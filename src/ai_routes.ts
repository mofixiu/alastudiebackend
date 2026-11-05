import crypto from 'node:crypto';
import express, { type Request, type RequestHandler, type Response } from 'express';
import type { Pool, QueryResultRow } from 'pg';
import { getGeminiConfig, type GeminiConfig } from './ai_config.js';

type AiUser = { id: string; username: string; profile: Record<string, unknown> };
type AiRequest = Request & { user?: AiUser };
type Handler = (req: AiRequest, res: Response) => Promise<unknown>;

class AiHttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const route = (handler: Handler) => (req: Request, res: Response) => {
  void handler(req as AiRequest, res).catch((error: unknown) => {
    if (error instanceof AiHttpError) return res.status(error.status).json({ error: error.message });
    console.error('AI route failed', error);
    return res.status(500).json({ error: 'AI is unavailable right now. Your study data is safe.' });
  });
};
const user = (req: AiRequest) => {
  if (!req.user) throw new AiHttpError(401, 'Sign in to continue.');
  return req.user;
};
const clean = (value: unknown, max = 20_000) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const required = (value: unknown, label: string, max = 20_000) => {
  const result = clean(value, max);
  if (!result) throw new AiHttpError(400, `${label} is required.`);
  return result;
};
const providerBase = () => (process.env.GEMINI_API_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');

const toTokens = (value: string) => Math.ceil(value.length / 3.4);
const estimatedCost = (inputTokens: number, outputTokens: number, cfg: GeminiConfig) =>
  (inputTokens * cfg.inputRate + outputTokens * cfg.outputRate) / 1_000_000;
const authHeader = (key: string) => ({ 'Content-Type': 'application/json', 'x-goog-api-key': key });
const parseJsonResponse = async (response: globalThis.Response) => {
  let body: Record<string, any> = {};
  try { body = await response.json() as Record<string, any>; } catch { /* provider did not return JSON */ }
  if (!response.ok) {
    const providerMessage = clean(body.error?.message, 400);
    throw new AiHttpError(response.status === 429 ? 429 : 502, response.status === 429 ? 'AI usage is temporarily limited. Try again later.' : providerMessage || 'Google AI could not complete that request.');
  }
  return body;
};

async function usageTotal(pool: Pool, client = pool) {
  const result = await client.query<{ total: string } & QueryResultRow>('SELECT COALESCE(SUM(estimated_usd),0)::text total FROM ai_usage');
  return Number(result.rows[0]?.total ?? 0);
}

type Material = { id: string; file_name: string; content_type: string; byte_size: number; data: Buffer; room_id: string };
type StudyDocument = Omit<Material, 'room_id'>;

async function uploadDocumentToSearchStore(
  cfg: GeminiConfig,
  userId: string,
  material: Pick<Material, 'id' | 'file_name' | 'content_type' | 'data'>,
) {
  const create = await fetch(`${providerBase()}/v1beta/fileSearchStores`, {
    method: 'POST', headers: authHeader(cfg.key),
    body: JSON.stringify({ displayName: `aLaStudie-${userId.slice(0, 8)}-${material.id.slice(0, 8)}`, embeddingModel: cfg.embeddingModel }),
  });
  const store = await parseJsonResponse(create);
  const storeName = clean(store.name, 240);
  if (!storeName.startsWith('fileSearchStores/')) throw new AiHttpError(502, 'Google AI did not create a document search index.');
  const fileBytes = material.data as Buffer;
  const start = await fetch(`${providerBase()}/upload/v1beta/${storeName}:uploadToFileSearchStore`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': cfg.key,
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(fileBytes.length),
      'X-Goog-Upload-Header-Content-Type': material.content_type,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ displayName: material.file_name }),
  });
  if (!start.ok) {
    await fetch(`${providerBase()}/v1beta/${storeName}`, { method: 'DELETE', headers: authHeader(cfg.key) }).catch(() => undefined);
    await parseJsonResponse(start);
  }
  const uploadUrl = start.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new AiHttpError(502, 'Google AI did not provide a secure upload link.');
  const uploaded = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
      'Content-Length': String(fileBytes.length),
      'Content-Type': material.content_type,
    },
    body: Uint8Array.from(fileBytes),
  });
  let operation = await parseJsonResponse(uploaded);
  let polls = 0;
  while (operation.done !== true && operation.name && polls++ < 12) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const check = await fetch(`${providerBase()}/v1beta/${operation.name}`, { headers: { 'x-goog-api-key': cfg.key } });
    operation = await parseJsonResponse(check);
  }
  if (operation.done !== true) throw new AiHttpError(504, 'Document indexing is taking longer than expected. Retry later.');
  const documentName = clean(operation.response?.documentName ?? operation.response?.document_name ?? operation.response?.name ?? storeName, 240);
  return { store_name: storeName, document_name: documentName };
}

async function ensureMaterialIndexed(pool: Pool, cfg: GeminiConfig, userId: string, material: Material) {
  const existing = await pool.query('SELECT store_name,document_name FROM ai_file_search_stores WHERE user_id=$1 AND material_id=$2', [userId, material.id]);
  if (existing.rows[0]) return existing.rows[0] as { store_name: string; document_name: string };
  const { store_name: storeName, document_name: documentName } = await uploadDocumentToSearchStore(cfg, userId, material);
  const indexed = await pool.query(
    'INSERT INTO ai_file_search_stores(user_id,material_id,store_name,document_name) VALUES($1,$2,$3,$4) ON CONFLICT(user_id,material_id) DO UPDATE SET store_name=EXCLUDED.store_name,document_name=EXCLUDED.document_name RETURNING store_name,document_name',
    [userId, material.id, storeName, documentName],
  );
  await pool.query("UPDATE room_materials SET ai_index_status='indexed' WHERE id=$1", [material.id]);
  return indexed.rows[0] as { store_name: string; document_name: string };
}

async function ensureStudyDocumentIndexed(pool: Pool, cfg: GeminiConfig, userId: string, document: StudyDocument) {
  const existing = await pool.query(
    'SELECT store_name,document_name FROM ai_personal_document_search_stores WHERE user_id=$1 AND document_id=$2',
    [userId, document.id],
  );
  if (existing.rows[0]) return existing.rows[0] as { store_name: string; document_name: string };
  const { store_name: storeName, document_name: documentName } = await uploadDocumentToSearchStore(cfg, userId, document);
  const indexed = await pool.query(
    `INSERT INTO ai_personal_document_search_stores(user_id,document_id,store_name,document_name)
     VALUES($1,$2,$3,$4) ON CONFLICT(user_id,document_id)
     DO UPDATE SET store_name=EXCLUDED.store_name,document_name=EXCLUDED.document_name
     RETURNING store_name,document_name`,
    [userId, document.id, storeName, documentName],
  );
  return indexed.rows[0] as { store_name: string; document_name: string };
}

async function cleanExternalStore(cfg: GeminiConfig, storeName: string) {
  try {
    const response = await fetch(`${providerBase()}/v1beta/${storeName}`, {
      method: 'DELETE', headers: authHeader(cfg.key),
    });
    return response.ok || response.status === 404;
  } catch {
    return false;
  }
}

async function drainStoreCleanup(pool: Pool, cfg: GeminiConfig) {
  const claim = await pool.query(
    `WITH candidate AS (
       SELECT id FROM ai_file_search_cleanup
       WHERE available_at <= NOW() AND (lease_until IS NULL OR lease_until < NOW())
       ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED
     )
     UPDATE ai_file_search_cleanup q SET lease_until=NOW()+INTERVAL '2 minutes',attempts=attempts+1
     FROM candidate WHERE q.id=candidate.id RETURNING q.id,q.store_name,q.attempts`,
  );
  const item = claim.rows[0];
  if (!item) return;
  if (await cleanExternalStore(cfg, String(item.store_name))) {
    await pool.query('DELETE FROM ai_file_search_cleanup WHERE id=$1', [item.id]);
    return;
  }
  await pool.query(
    `UPDATE ai_file_search_cleanup SET lease_until=NULL,
       available_at=NOW()+LEAST(attempts,60)*INTERVAL '1 minute',last_error='Provider deletion failed'
     WHERE id=$1`, [item.id],
  );
}

export function registerAiRoutes(app: express.Express, pool: Pool, authenticate: RequestHandler) {
  const cleanupTimer = setInterval(() => {
    const cfg = getGeminiConfig();
    if (cfg) void drainStoreCleanup(pool, cfg).catch((error) => console.error('AI index cleanup retry failed', error));
  }, 30_000);
  cleanupTimer.unref();

  app.get('/ai/status', authenticate, route(async (req, res) => {
    user(req);
    const cfg = getGeminiConfig();
    const spent = cfg ? await usageTotal(pool) : 0;
    res.json({
      enabled: cfg !== null,
      reason: cfg ? null : 'AI is not configured with a confirmed Gemini credit balance and Google-side spend cap.',
      model: cfg?.model ?? null,
      budgetUsd: cfg?.budget ?? null,
      estimatedSpentUsd: Number(spent.toFixed(6)),
      estimatedRemainingUsd: cfg ? Number(Math.max(0, cfg.budget - cfg.reserve - spent).toFixed(6)) : null,
    });
  }));

  app.delete('/ai/material-index/:materialId', authenticate, route(async (req, res) => {
    const me = user(req); const cfg = getGeminiConfig();
    const result = await pool.query(
      `SELECT s.store_name,m.id FROM ai_file_search_stores s JOIN room_materials m ON m.id=s.material_id
       WHERE s.user_id=$1 AND m.id=$2`,
      [me.id, clean(req.params.materialId, 64)],
    );
    if (!result.rows[0]) return res.json({ deleted: true });
    await pool.query('DELETE FROM ai_file_search_stores WHERE user_id=$1 AND material_id=$2', [me.id, result.rows[0].id]);
    let cleanupPending = true;
    if (cfg) {
      cleanupPending = !(await cleanExternalStore(cfg, String(result.rows[0].store_name)));
      if (!cleanupPending) await pool.query('DELETE FROM ai_file_search_cleanup WHERE store_name=$1', [result.rows[0].store_name]);
    }
    res.json({ deleted: true, cleanupPending });
  }));

  app.post('/ai/requests', authenticate, route(async (req, res) => {
    const me = user(req);
    const cfg = getGeminiConfig();
    if (!cfg) throw new AiHttpError(503, 'AI is turned off until Gemini credits and a Google-side spend cap are confirmed in the backend configuration.');
    const operation = ['assistant', 'quiz', 'study_plan', 'semantic_search'].includes(req.body.operation) ? String(req.body.operation) : '';
    if (!operation) throw new AiHttpError(400, 'Choose an available study tool.');
    const prompt = required(req.body.prompt, operation === 'quiz' ? 'Study material or request' : 'Your request', 12_000);
    const selectedIds = Array.isArray(req.body.materialIds)
      ? [...new Set(req.body.materialIds.map((value: unknown) => clean(value, 64)).filter((value: string) => /^[0-9a-f-]{36}$/i.test(value)))].slice(0, 4)
      : [];
    const selectedStudyDocumentIds = Array.isArray(req.body.studyDocumentIds)
      ? [...new Set(req.body.studyDocumentIds.map((value: unknown) => clean(value, 64)).filter((value: string) => /^[0-9a-f-]{36}$/i.test(value)))].slice(0, 4)
      : [];
    if (selectedIds.length + selectedStudyDocumentIds.length > 3) throw new AiHttpError(400, 'Use no more than three study files in one request.');
    if (operation === 'semantic_search' && !selectedIds.length && !selectedStudyDocumentIds.length) {
      throw new AiHttpError(400, 'Select one or more study files before searching them.');
    }
    // Consent is checked here, not just shown in the app: every request goes to Google,
    // and selected files are kept in a private Google search index until removed.
    if (req.body.confirmGoogleProcessing !== true) {
      throw new AiHttpError(400, 'Confirm that this request is sent to Google AI before submitting it.');
    }
    if ((selectedIds.length || selectedStudyDocumentIds.length) && req.body.confirmPersistentIndex !== true) {
      throw new AiHttpError(400, 'Confirm that the selected files are kept in a private search index before using them.');
    }

    const roomId = clean(req.body.roomId, 64);
    let materials: Material[] = [];
    let studyDocuments: StudyDocument[] = [];
    let storeNames: string[] = [];
    if (selectedIds.length) {
      const member = await pool.query('SELECT 1 FROM room_members WHERE room_id=$1 AND user_id=$2', [roomId, me.id]);
      if (!member.rowCount) throw new AiHttpError(403, 'Join this room before using its files with AI.');
      const result = await pool.query(
        `SELECT id,room_id,file_name,content_type,byte_size,data FROM room_materials WHERE room_id=$1 AND id=ANY($2::uuid[])`, [roomId, selectedIds],
      );
      if (result.rows.length !== selectedIds.length) throw new AiHttpError(404, 'A selected room file was removed or is no longer available.');
      materials = result.rows as Material[];
      const totalBytes = materials.reduce((sum, material) => sum + Number(material.byte_size), 0);
      if (totalBytes > 8 * 1024 * 1024) throw new AiHttpError(413, 'Select files totaling no more than 8 MB.');
      const indexed = await pool.query('SELECT material_id,store_name FROM ai_file_search_stores WHERE user_id=$1 AND material_id=ANY($2::uuid[])', [me.id, selectedIds]);
      storeNames = indexed.rows.map((row) => String(row.store_name));
    }
    if (selectedStudyDocumentIds.length) {
      const result = await pool.query(
        `SELECT id,file_name,content_type,byte_size,data FROM personal_study_documents
         WHERE user_id=$1 AND id=ANY($2::uuid[])`,
        [me.id, selectedStudyDocumentIds],
      );
      if (result.rows.length !== selectedStudyDocumentIds.length) {
        throw new AiHttpError(404, 'A selected personal study PDF was removed or is unavailable.');
      }
      studyDocuments = result.rows as StudyDocument[];
      const indexed = await pool.query(
        'SELECT document_id,store_name FROM ai_personal_document_search_stores WHERE user_id=$1 AND document_id=ANY($2::uuid[])',
        [me.id, selectedStudyDocumentIds],
      );
      storeNames.push(...indexed.rows.map((row) => String(row.store_name)));
    }
    const totalSelectedBytes = [...materials, ...studyDocuments]
      .reduce((sum, material) => sum + Number(material.byte_size), 0);
    if (totalSelectedBytes > 8 * 1024 * 1024) throw new AiHttpError(413, 'Select files totaling no more than 8 MB.');

    const ownPlan = req.body.includePlan === true;
    let planContext = '';
    if (ownPlan) {
      const [goal, blocks] = await Promise.all([
        pool.query('SELECT sessions_per_week FROM planner_goals WHERE user_id=$1', [me.id]),
        pool.query("SELECT title,subject,starts_at,ends_at,completed_at FROM planner_blocks WHERE user_id=$1 AND starts_at>=NOW()-INTERVAL '7 days' AND starts_at<NOW()+INTERVAL '14 days' ORDER BY starts_at LIMIT 40", [me.id]),
      ]);
      const profileSubjects = Array.isArray(me.profile?.subjects) ? me.profile.subjects.map((item) => clean(item, 60)).filter(Boolean) : [];
      planContext = `\nUSER'S PRIVATE PLAN (shared only because they explicitly included it): weekly session goal ${Number(goal.rows[0]?.sessions_per_week ?? 3)}; subjects ${profileSubjects.join(', ') || 'not set'}; blocks ${JSON.stringify(blocks.rows)}.`;
    }
    const fullPrompt = [
      'You are the aLaStudie study assistant. Help students learn, plan, and stay focused. Be accurate, concise, and say when the provided material does not contain the answer.',
      operation === 'quiz' ? 'Create a short practice quiz with an answer key separated from the questions.' : '',
      operation === 'study_plan' ? 'Return only valid JSON with shape {"blocks":[{"title":"…","subject":"…","startsAt":"ISO-8601 with offset","endsAt":"ISO-8601 with offset"}]}. Create at most seven realistic blocks within the next seven days. Make each block 25–120 minutes and do not overlap them. Do not claim events were created; the student will review and apply this draft.' : '',
      operation === 'semantic_search' ? 'Find the passages that best answer the search request. Include short quoted excerpts and identify their file names.' : '',
      planContext,
      `STUDENT REQUEST:\n${prompt}`,
    ].filter(Boolean).join('\n\n');
    const selectedDocuments = [...materials, ...studyDocuments];
    const estimatedInput = toTokens(fullPrompt) + selectedDocuments.reduce((sum, material) => sum + Math.ceil(Number(material.byte_size) / 3.4), 0);
    const maxOutputTokens = Math.max(256, Math.min(2048, Number.parseInt(String(req.body.maxOutputTokens ?? 1200), 10) || 1200));
    const indexedIds = new Set((await pool.query('SELECT material_id FROM ai_file_search_stores WHERE user_id=$1 AND material_id=ANY($2::uuid[])', [me.id, selectedIds])).rows.map((row) => String(row.material_id)));
    const newMaterials = materials.filter((material) => !indexedIds.has(material.id));
    const indexedStudyDocumentIds = new Set((await pool.query(
      'SELECT document_id FROM ai_personal_document_search_stores WHERE user_id=$1 AND document_id=ANY($2::uuid[])',
      [me.id, selectedStudyDocumentIds],
    )).rows.map((row) => String(row.document_id)));
    const newStudyDocuments = studyDocuments.filter((document) => !indexedStudyDocumentIds.has(document.id));
    const newIndexDocuments = [...newMaterials, ...newStudyDocuments];
    const upperEstimate = estimatedCost(estimatedInput, maxOutputTokens, cfg) + newIndexDocuments.reduce((sum, material) => sum + Math.ceil(Number(material.byte_size) / 3.4) * cfg.embeddingRate / 1_000_000, 0);
    if (upperEstimate <= 0) throw new AiHttpError(503, 'AI cost rates are not configured.');
    const requestId = crypto.randomUUID();
    const reservation = await pool.connect();
    try {
      await reservation.query('BEGIN');
      await reservation.query('SELECT pg_advisory_xact_lock(814329, 7419)');
      const spentResult = await reservation.query<{ total: string } & QueryResultRow>('SELECT COALESCE(SUM(estimated_usd),0)::text total FROM ai_usage');
      const spent = Number(spentResult.rows[0]?.total ?? 0);
      if (spent + upperEstimate > cfg.budget - cfg.reserve) throw new AiHttpError(429, 'AI has reached its protected credit limit. Try again after the available budget is reviewed.');
      await reservation.query(
        `INSERT INTO ai_usage(user_id,request_id,operation,model,input_tokens,output_tokens,estimated_usd)
         VALUES($1,$2,$3,$4,$5,$6,$7)`, [me.id, requestId, operation, cfg.model, estimatedInput, maxOutputTokens, upperEstimate],
      );
      await reservation.query('COMMIT');
    } catch (error) {
      await reservation.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { reservation.release(); }

    try {
      if (newMaterials.length) {
        storeNames.push(...(await Promise.all(newMaterials.map(async (material) => (await ensureMaterialIndexed(pool, cfg, me.id, material)).store_name))));
      }
      if (newStudyDocuments.length) {
        storeNames.push(...(await Promise.all(newStudyDocuments.map(async (document) => (await ensureStudyDocumentIndexed(pool, cfg, me.id, document)).store_name))));
      }
      const response = await fetch(`${providerBase()}/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent`, {
        method: 'POST', headers: authHeader(cfg.key),
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: fullPrompt }] }],
          ...(storeNames.length ? { tools: [{ file_search: { file_search_store_names: storeNames } }] } : {}),
          generationConfig: { maxOutputTokens, temperature: 0.5 },
        }),
      });
      const data = await parseJsonResponse(response);
      const answer = (data.candidates?.[0]?.content?.parts ?? []).map((part: Record<string, unknown>) => typeof part.text === 'string' ? part.text : '').join('').trim();
      if (!answer) throw new AiHttpError(502, 'Google AI returned an empty answer. Try a more specific prompt.');
      const inputTokens = Number(data.usageMetadata?.promptTokenCount ?? estimatedInput);
      const outputTokens = Number(data.usageMetadata?.candidatesTokenCount ?? toTokens(answer));
      const generationCost = estimatedCost(inputTokens, outputTokens, cfg);
      const indexCost = newIndexDocuments.reduce((sum, material) => sum + Math.ceil(Number(material.byte_size) / 3.4) * cfg.embeddingRate / 1_000_000, 0);
      const cost = generationCost + indexCost;
      await pool.query(
        'UPDATE ai_usage SET input_tokens=$2,output_tokens=$3,estimated_usd=LEAST(estimated_usd,$4) WHERE request_id=$1',
        [requestId, inputTokens, outputTokens, cost],
      );
      const grounding = data.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
      const citations = grounding.map((item: Record<string, any>) => ({
        title: clean(item.retrievedContext?.title ?? item.web?.title, 160),
        uri: clean(item.retrievedContext?.uri ?? item.web?.uri, 500),
      })).filter((item: { title: string; uri: string }) => item.title || item.uri);
      res.json({ requestId, operation, model: cfg.model, answer, citations, usage: { inputTokens, outputTokens, estimatedUsd: Number(cost.toFixed(8)) } });
    } catch (error) {
      if (error instanceof AiHttpError) throw error;
      console.error('Gemini request failed', error);
      throw new AiHttpError(502, 'Google AI could not complete that request. Check the backend key, quota, and network, then try again.');
    }
  }));
}
