import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import { Pool, type QueryResultRow } from 'pg';
import { Server as SocketServer, type Socket } from 'socket.io';
import { registerRoadmapRoutes } from './roadmap_routes.js';
import { registerAiRoutes } from './ai_routes.js';

const port = Number(process.env.PORT ?? 4000);
const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://localhost:5433/alastudie' });
const adminEmails = new Set((process.env.ADMIN_EMAILS ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean));
const mailboxEnabled = process.env.LOCAL_MAILBOX_ENABLED !== 'false';
const app = express();
const server = http.createServer(app);
const io = new SocketServer(server, { cors: { origin: '*' }, maxHttpBufferSize: 1_000_000 });

type User = { id: string; email: string; username: string; profile: Record<string, unknown>; is_admin: boolean };
type AuthedRequest = Request & { user?: User };
type Presence = 'studying' | 'break' | 'away' | 'offline';
const roomPresence = new Map<string, Map<string, Presence>>();

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const run = async <T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []) => pool.query<T>(sql, params);
const id = (req: Request, key = 'id') => String(req.params[key] ?? '');
const text = (value: unknown, max = 500) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const required = (value: unknown, label: string, max = 500) => {
  const valueText = text(value, max);
  if (!valueText) throw new HttpError(400, `${label} is required.`);
  return valueText;
};
const scheduledDate = (value: unknown) => {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new HttpError(400, 'Choose a valid room start date and time.');
  }
  const start = new Date(value);
  if (start.getTime() <= Date.now()) {
    throw new HttpError(400, 'Choose a room start time in the future.');
  }
  return start.toISOString();
};
const recurrenceValue = (value: unknown) => {
  const recurrence = value == null || value === '' ? 'none' : String(value);
  if (!['none', 'daily', 'weekly'].includes(recurrence)) {
    throw new HttpError(400, 'Choose no repeat, daily, or weekly.');
  }
  return recurrence;
};
const escapeHtml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]!));
const scheduleState = (start: number, recurrence: string, now = Date.now()) => {
  if (recurrence === 'none') return { at: start, active: start <= now };
  const interval = recurrence === 'daily' ? 86_400_000 : 7 * 86_400_000;
  if (start > now) return { at: start, active: false };
  const elapsed = now - start;
  const current = start + Math.floor(elapsed / interval) * interval;
  const active = now - current <= 4 * 60 * 60 * 1000;
  return { at: active ? current : current + interval, active };
};
const roomWithNextSchedule = <T extends QueryResultRow>(room: T): T => {
  const raw = room.scheduled_at as Date | string | null | undefined;
  if (!raw) return room;
  const initial = raw instanceof Date ? raw.getTime() : Date.parse(raw);
  if (!Number.isFinite(initial)) return room;
  const { at } = scheduleState(initial, String(room.recurrence ?? 'none'));
  return { ...room, scheduled_at: new Date(at) };
};
const emailOf = (value: unknown) => required(value, 'Email', 254).toLowerCase();
const asyncRoute = (fn: (req: AuthedRequest, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => { void fn(req as AuthedRequest, res, next).catch(next); };
const user = (req: AuthedRequest) => {
  if (!req.user) throw new HttpError(401, 'Sign in to continue.');
  return req.user;
};
const publicUser = (row: QueryResultRow) => ({ id: row.id, username: row.username, profile: row.profile ?? {} });
const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const makePasswordHash = async (password: string) => {
  if (password.length < 8) throw new HttpError(400, 'Use a password with at least 8 characters.');
  const salt = crypto.randomBytes(16).toString('hex');
  const key = await new Promise<Buffer>((resolve, reject) => crypto.scrypt(password, salt, 64, (error, result) => error ? reject(error) : resolve(result)));
  return `${salt}:${key.toString('hex')}`;
};
const verifyPassword = async (password: string, stored: string) => {
  const [salt, expected] = stored.split(':');
  if (!salt || !expected) return false;
  const key = await new Promise<Buffer>((resolve, reject) => crypto.scrypt(password, salt, 64, (error, result) => error ? reject(error) : resolve(result)));
  const wanted = Buffer.from(expected, 'hex');
  return key.length === wanted.length && crypto.timingSafeEqual(key, wanted);
};
const tokenCode = () => crypto.randomBytes(24).toString('base64url');
const issueEmailToken = async (userId: string, purpose: 'verify' | 'reset', email: string) => {
  const token = tokenCode();
  await run('INSERT INTO email_tokens(user_id, token_hash, purpose, expires_at) VALUES($1,$2,$3,NOW()+INTERVAL \'30 minutes\')', [userId, digest(token), purpose]);
  const action = purpose === 'verify' ? 'Verify your aLaStudie account' : 'Reset your aLaStudie password';
  const body = `${action}\n\nYour local development code is:\n${token}\n\nThis code expires in 30 minutes.`;
  if (mailboxEnabled) await run('INSERT INTO local_mailbox(recipient, subject, body) VALUES($1,$2,$3)', [email, action, body]);
  if (process.env.NODE_ENV !== 'production') console.info(`[local mailbox] ${purpose} message saved for ${email}`);
};

app.disable('x-powered-by');
app.use(express.json({ limit: '12mb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Idempotency-Key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const authenticate = asyncRoute(async (req, _res, next) => {
  const raw = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!raw) throw new HttpError(401, 'Sign in to continue.');
  const { rows } = await run<User & QueryResultRow>(
    `SELECT u.id,u.email,u.username,u.profile,u.is_suspended
       FROM auth_sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=$1 AND s.expires_at>NOW()`, [digest(raw)],
  );
  const row = rows[0];
  if (!row || row.is_suspended) throw new HttpError(401, 'Your session is no longer active.');
  req.user = { ...row, is_admin: adminEmails.has(row.email.toLowerCase()) };
  next();
});
const requireAdmin = (req: AuthedRequest) => { if (!user(req).is_admin) throw new HttpError(403, 'Staff access is required.'); };
const requireRoomMember = async (roomId: string, userId: string) => {
  const { rows } = await run('SELECT role,permissions FROM room_members WHERE room_id=$1 AND user_id=$2', [roomId, userId]);
  if (!rows[0]) throw new HttpError(403, 'Join this room to view it.');
  return rows[0] as { role: string; permissions?: Record<string, boolean> };
};
const requireRoomHost = async (roomId: string, userId: string) => {
  const role = await requireRoomMember(roomId, userId);
  if (role.role !== 'host') throw new HttpError(403, 'Only the room host can do that.');
};
const requireRoomPermission = async (roomId: string, userId: string, permission: string) => {
  const role = await requireRoomMember(roomId, userId);
  if (role.role !== 'host' && !(role.role === 'cohost' && role.permissions?.[permission] === true)) {
    throw new HttpError(403, 'Your co-host role does not include permission for that action.');
  }
  return role.role;
};
const materializeOccurrences = async (roomId: string, scheduledAt: Date | string | null, recurrence: string) => {
  if (!scheduledAt) return;
  let cursor = new Date(scheduledAt).getTime();
  if (!Number.isFinite(cursor)) return;
  const now = Date.now();
  const interval = recurrence === 'daily' ? 86_400_000 : recurrence === 'weekly' ? 7 * 86_400_000 : 0;
  if (interval && cursor < now) cursor += Math.floor((now - cursor) / interval) * interval;
  const limit = interval ? now + 90 * 86_400_000 : cursor;
  const startsAt: string[] = [];
  let count = 0;
  while (cursor <= limit && count++ < 100) {
    if (cursor >= now - 4 * 60 * 60 * 1000) startsAt.push(new Date(cursor).toISOString());
    if (!interval) break;
    cursor += interval;
  }
  if (startsAt.length) {
    await run(
      `INSERT INTO room_occurrences(room_id,starts_at,schedule_key)
       SELECT $1,generated.starts_at,generated.starts_at
         FROM unnest($2::timestamptz[]) AS generated(starts_at)
       ON CONFLICT(room_id,schedule_key) DO NOTHING`, [roomId, startsAt],
    );
  }
};
const notify = async (userId: string, title: string, body: string, kind: string) => {
  const { rows } = await run('INSERT INTO notifications(user_id,title,body,kind) VALUES($1,$2,$3,$4) RETURNING *', [userId, title, body, kind]);
  io.to(`user:${userId}`).emit('notification:new', rows[0]);
};
const sendOccurrenceReminders = async () => {
  const due = await run(
    `UPDATE occurrence_rsvps rsvp SET reminder_sent_at=NOW(),updated_at=NOW()
     FROM room_occurrences occurrence JOIN rooms room ON room.id=occurrence.room_id
     WHERE rsvp.occurrence_id=occurrence.id AND rsvp.reminder_enabled=TRUE
       AND rsvp.status='going' AND rsvp.reminder_sent_at IS NULL
       AND occurrence.status='scheduled' AND occurrence.starts_at>NOW()
       AND occurrence.starts_at<=NOW()+INTERVAL '24 hours'
     RETURNING rsvp.user_id,room.title,occurrence.starts_at`,
  );
  for (const row of due.rows) {
    const start = new Date(row.starts_at as Date | string);
    const when = new Intl.DateTimeFormat('en', { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(start);
    await notify(row.user_id, 'Your study room is coming up', `${row.title} starts ${when}.`, 'occurrence_reminder');
  }
};
const isBlockedEitherWay = async (a: string, b: string) => {
  const { rowCount } = await run('SELECT 1 FROM user_blocks WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1)', [a, b]);
  return (rowCount ?? 0) > 0;
};
const publishRoomMessage = async (roomId: string, senderId: string, event: string, payload: Record<string, unknown>) => {
  const members = await run('SELECT user_id FROM room_members WHERE room_id=$1', [roomId]);
  for (const member of members.rows) {
    if (member.user_id === senderId || !await isBlockedEitherWay(senderId, member.user_id)) {
      io.to(`user:${member.user_id}`).emit(event, { ...payload, roomId });
    }
  }
};
const presenceForRoom = (roomId: string) => Object.fromEntries(roomPresence.get(roomId) ?? []);
const publishPresence = (roomId: string) => io.to(`room:${roomId}`).emit('presence:snapshot', { roomId, members: presenceForRoom(roomId) });
const setPresence = async (roomId: string, userId: string, status: Presence) => {
  const values = roomPresence.get(roomId) ?? new Map<string, Presence>();
  values.set(userId, status);
  roomPresence.set(roomId, values);
  const active = await run('SELECT id,phase,status FROM study_sessions WHERE room_id=$1 AND status IN (\'running\',\'paused\') ORDER BY started_at DESC LIMIT 1', [roomId]);
  const session = active.rows[0];
  if (session?.status === 'running' && session.phase === 'focus') {
    if (status === 'studying') {
      await openFocusInterval(session.id, userId);
    } else {
      await closeFocusInterval(session.id, userId);
    }
  }
  publishPresence(roomId);
};
const openFocusInterval = async (sessionId: string, userId: string) => {
  await run('UPDATE session_participants SET last_focus_started_at=COALESCE(last_focus_started_at,NOW()) WHERE session_id=$1 AND user_id=$2', [sessionId, userId]);
  await run('INSERT INTO focus_intervals(session_id,user_id,cycle) SELECT $1,$2,cycle FROM study_sessions WHERE id=$1 ON CONFLICT(session_id,user_id) WHERE ended_at IS NULL DO NOTHING', [sessionId, userId]);
};
const closeFocusInterval = async (sessionId: string, userId: string) => {
  const closed = await run('UPDATE focus_intervals SET ended_at=NOW() WHERE session_id=$1 AND user_id=$2 AND ended_at IS NULL RETURNING FLOOR(EXTRACT(EPOCH FROM (NOW()-started_at)))::int seconds', [sessionId, userId]);
  const seconds = Number(closed.rows[0]?.seconds ?? 0);
  await run('UPDATE session_participants SET focused_seconds=focused_seconds+$3,last_focus_started_at=NULL WHERE session_id=$1 AND user_id=$2', [sessionId, userId, seconds]);
};
const closeFocusIntervals = async (sessionId: string) => {
  const { rows } = await run('UPDATE focus_intervals SET ended_at=NOW() WHERE session_id=$1 AND ended_at IS NULL RETURNING user_id,FLOOR(EXTRACT(EPOCH FROM (NOW()-started_at)))::int seconds', [sessionId]);
  for (const interval of rows) {
    await run('UPDATE session_participants SET focused_seconds=focused_seconds+$3,last_focus_started_at=NULL WHERE session_id=$1 AND user_id=$2', [sessionId, interval.user_id, Number(interval.seconds ?? 0)]);
  }
};
const currentSession = async (roomId: string) => {
  const { rows } = await run(
    `SELECT s.*,u.username AS host_name FROM study_sessions s JOIN users u ON u.id=s.host_id
      WHERE s.room_id=$1 AND s.status IN ('running','paused') ORDER BY s.started_at DESC LIMIT 1`, [roomId],
  );
  return rows[0] ?? null;
};
const sessionView = (row: QueryResultRow | null) => {
  if (!row) return null;
  let remaining = Number(row.remaining_seconds);
  if (row.status === 'running' && row.phase_started_at) {
    remaining = Math.max(0, remaining - Math.floor((Date.now() - new Date(row.phase_started_at).getTime()) / 1000));
  }
  return {
    id: row.id, roomId: row.room_id, hostId: row.host_id, hostName: row.host_name,
    preset: row.preset, focusSeconds: row.focus_seconds, breakSeconds: row.break_seconds,
    phase: row.phase, status: row.status, cycle: row.cycle, remainingSeconds: remaining,
    phaseStartedAt: row.phase_started_at, startedAt: row.started_at,
  };
};

app.get('/health', (_req, res) => res.json({ ok: true, service: 'aLaStudie local API' }));

app.post('/auth/register', asyncRoute(async (req, res) => {
  const email = emailOf(req.body.email);
  const username = required(req.body.username, 'Username', 32).replace(/^@/, '');
  const passwordHash = await makePasswordHash(required(req.body.password, 'Password', 200));
  if (req.body.ageConfirmed !== true) throw new HttpError(400, 'Confirm that you are 18 or older to create an account.');
  const { rows } = await run(
    'INSERT INTO users(email,username,password_hash) VALUES($1,$2,$3) RETURNING id,email,username,profile,is_verified',
    [email, username, passwordHash],
  ).catch((error: { code?: string }) => {
    if (error.code === '23505') throw new HttpError(409, 'That email or username is already in use.');
    throw error;
  });
  await issueEmailToken(rows[0]!.id, 'verify', email);
  res.status(201).json({ message: 'Check the local development mailbox to verify your account.', user: rows[0] });
}));

app.post('/auth/verify', asyncRoute(async (req, res) => {
  const email = emailOf(req.body.email);
  const code = required(req.body.code, 'Verification code', 100);
  const { rows } = await run(
    `UPDATE email_tokens SET consumed_at=NOW() WHERE id=(SELECT t.id FROM email_tokens t JOIN users u ON u.id=t.user_id
       WHERE u.email=$1 AND t.token_hash=$2 AND t.purpose='verify' AND t.consumed_at IS NULL AND t.expires_at>NOW()
       ORDER BY t.expires_at DESC LIMIT 1) RETURNING user_id`, [email, digest(code)],
  );
  if (!rows[0]) throw new HttpError(400, 'That verification code is invalid or expired.');
  await run('UPDATE users SET is_verified=TRUE WHERE id=$1', [rows[0].user_id]);
  res.json({ message: 'Email verified. You can sign in now.' });
}));

app.post('/auth/login', asyncRoute(async (req, res) => {
  const identifier = required(req.body.identifier ?? req.body.email, 'Email or username', 254).toLowerCase();
  const { rows } = await run('SELECT id,email,username,password_hash,profile,is_verified,is_suspended FROM users WHERE lower(email)=$1 OR lower(username)=$1 LIMIT 1', [identifier]);
  const account = rows[0];
  if (!account || !await verifyPassword(required(req.body.password, 'Password', 200), account.password_hash)) throw new HttpError(401, 'Email or username and password are incorrect.');
  if (!account.is_verified) throw new HttpError(403, 'Verify your email before signing in.');
  if (account.is_suspended) throw new HttpError(403, 'This account is suspended.');
  const token = crypto.randomBytes(32).toString('base64url');
  const hours = Number(process.env.SESSION_HOURS ?? 720);
  await run('INSERT INTO auth_sessions(user_id,token_hash,expires_at) VALUES($1,$2,NOW()+($3 * INTERVAL \'1 hour\'))', [account.id, digest(token), hours]);
  const email = String(account.email).toLowerCase();
  res.json({ token, user: { id: account.id, email, username: account.username, profile: account.profile, is_admin: adminEmails.has(email) } });
}));

app.post('/auth/logout', authenticate, asyncRoute(async (req, res) => {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
  await run('DELETE FROM auth_sessions WHERE token_hash=$1', [digest(token)]);
  res.json({ message: 'Signed out.' });
}));

app.post('/auth/forgot-password', asyncRoute(async (req, res) => {
  const email = emailOf(req.body.email);
  const found = await run('SELECT id FROM users WHERE email=$1', [email]);
  if (found.rows[0]) await issueEmailToken(found.rows[0].id, 'reset', email);
  res.json({ message: 'If the account exists, a reset code is in the local development mailbox.' });
}));

app.post('/auth/reset-password', asyncRoute(async (req, res) => {
  const email = emailOf(req.body.email);
  const code = required(req.body.code, 'Reset code', 100);
  const passwordHash = await makePasswordHash(required(req.body.password, 'New password', 200));
  const { rows } = await run(
    `UPDATE email_tokens SET consumed_at=NOW() WHERE id=(SELECT t.id FROM email_tokens t JOIN users u ON u.id=t.user_id
       WHERE u.email=$1 AND t.token_hash=$2 AND t.purpose='reset' AND t.consumed_at IS NULL AND t.expires_at>NOW()
       ORDER BY t.expires_at DESC LIMIT 1) RETURNING user_id`, [email, digest(code)],
  );
  if (!rows[0]) throw new HttpError(400, 'That reset code is invalid or expired.');
  await run('UPDATE users SET password_hash=$2 WHERE id=$1', [rows[0].user_id, passwordHash]);
  await run('DELETE FROM auth_sessions WHERE user_id=$1', [rows[0].user_id]);
  res.json({ message: 'Password reset. Sign in with the new password.' });
}));

app.get('/dev/mailbox', asyncRoute(async (req, res) => {
  if (!mailboxEnabled || process.env.NODE_ENV === 'production') throw new HttpError(404, 'Not found.');
  const email = req.query.email ? emailOf(req.query.email) : '';
  const { rows } = await run('SELECT id,recipient,subject,body,created_at FROM local_mailbox WHERE ($1=\'\' OR recipient=$1) ORDER BY created_at DESC LIMIT 40', [email]);
  res.json({ messages: rows });
}));

app.get('/me', authenticate, asyncRoute(async (req, res) => res.json({ user: req.user })));
app.patch('/me/profile', authenticate, asyncRoute(async (req, res) => {
  const me = user(req);
  const safe = {
    displayName: text(req.body.displayName, 50), school: text(req.body.school, 100),
    subjects: Array.isArray(req.body.subjects) ? req.body.subjects.map((x: unknown) => text(x, 40)).filter(Boolean).slice(0, 12) : [],
    photoUrl: text(req.body.photoUrl, 500), visibility: req.body.visibility === 'public' ? 'public' : 'private',
    allowMessageRequests: req.body.allowMessageRequests !== false,
  };
  const { rows } = await run('UPDATE users SET profile=$2::jsonb WHERE id=$1 RETURNING id,email,username,profile', [me.id, JSON.stringify(safe)]);
  res.json({ user: rows[0] });
}));
app.get('/users/search', authenticate, asyncRoute(async (req, res) => {
  const me = user(req);
  const term = `%${text(req.query.q, 40).replace(/[\\%_]/g, '\\$&')}%`;
  const { rows } = await run(
    `SELECT id,username,profile FROM users WHERE is_verified=TRUE AND is_suspended=FALSE AND id<>$1
      AND (username ILIKE $2 OR COALESCE(profile->>'displayName','') ILIKE $2)
      AND COALESCE(profile->>'visibility','private')='public' ORDER BY username LIMIT 20`, [me.id, term],
  );
  res.json({ users: rows.map(publicUser) });
}));

app.get('/rooms', authenticate, asyncRoute(async (req, res) => {
  const me = user(req);
  const search = `%${text(req.query.q, 80).replace(/[\\%_]/g, '\\$&')}%`;
  const subject = `%${text(req.query.subject, 60).replace(/[\\%_]/g, '\\$&')}%`;
  const course = `%${text(req.query.course, 80).replace(/[\\%_]/g, '\\$&')}%`;
  const parseFilterDate = (value: unknown) => {
    if (!value) return null;
    const parsed = Date.parse(String(value));
    if (!Number.isFinite(parsed)) throw new HttpError(400, 'Choose a valid start-time filter.');
    return new Date(parsed).toISOString();
  };
  const startAfter = parseFilterDate(req.query.startAfter);
  const startBefore = parseFilterDate(req.query.startBefore);
  const availableSeats = Math.max(0, Math.min(50, Number.parseInt(String(req.query.availableSeats ?? '0'), 10) || 0));
  const { rows } = await run(
    `SELECT r.*,u.username host_name,COUNT(m.user_id)::int member_count,
      EXISTS(SELECT 1 FROM room_members mine WHERE mine.room_id=r.id AND mine.user_id=$1) is_member
     FROM rooms r JOIN users u ON u.id=r.host_id LEFT JOIN room_members m ON m.room_id=r.id
     WHERE r.status='open' AND r.access_type='public'
       AND (r.title ILIKE $2 OR r.subject ILIKE $2 OR r.course ILIKE $2 OR r.goal ILIKE $2)
       AND r.subject ILIKE $3 AND r.course ILIKE $4
       AND ($5::timestamptz IS NULL OR r.scheduled_at >= $5)
       AND ($6::timestamptz IS NULL OR r.scheduled_at <= $6)
     GROUP BY r.id,u.username
     HAVING r.participant_limit-COUNT(m.user_id) >= $7
     ORDER BY member_count DESC,r.created_at DESC LIMIT 50`,
    [me.id, search, subject, course, startAfter, startBefore, availableSeats],
  );
  res.json({ rooms: rows.map(roomWithNextSchedule) });
}));

app.get('/rooms/mine', authenticate, asyncRoute(async (req, res) => {
  const me = user(req);
  const { rows } = await run(
    `SELECT r.*,m.role,u.username host_name,COUNT(allm.user_id)::int member_count
       FROM room_members m JOIN rooms r ON r.id=m.room_id JOIN users u ON u.id=r.host_id
       LEFT JOIN room_members allm ON allm.room_id=r.id WHERE m.user_id=$1
       GROUP BY r.id,m.role,u.username ORDER BY r.created_at DESC`, [me.id],
  );
  res.json({ rooms: rows.map(roomWithNextSchedule) });
}));

app.get('/calendar', authenticate, asyncRoute(async (req, res) => {
  const me = user(req);
  const parseRange = (value: unknown, fallback: Date) => {
    if (!value) return fallback.toISOString();
    const parsed = Date.parse(String(value));
    if (!Number.isFinite(parsed)) throw new HttpError(400, 'Choose a valid calendar date range.');
    return new Date(parsed).toISOString();
  };
  const from = parseRange(req.query.from, new Date(Date.now() - 86_400_000));
  const to = parseRange(req.query.to, new Date(Date.now() + 90 * 86_400_000));
  const availableRooms = await run(
    `SELECT r.id,r.scheduled_at,r.recurrence FROM rooms r WHERE r.status='open' AND r.scheduled_at IS NOT NULL
      AND (r.access_type='public'
        OR EXISTS(SELECT 1 FROM room_members m WHERE m.room_id=r.id AND m.user_id=$1)
        OR EXISTS(SELECT 1 FROM room_invitations i WHERE i.room_id=r.id AND i.invited_user_id=$1))`, [me.id],
  );
  await Promise.all(availableRooms.rows.map((room) =>
    materializeOccurrences(room.id, room.scheduled_at, String(room.recurrence ?? 'none')),
  ));
  const { rows } = await run(
    `SELECT o.id,o.room_id,o.starts_at,o.status,r.title room_title,r.subject,r.course,r.goal,r.access_type,
       r.participant_limit,h.username host_name,
       mine.status my_rsvp,COALESCE(mine.reminder_enabled,FALSE) reminder_enabled,
       EXISTS(SELECT 1 FROM occurrence_attendance own_att WHERE own_att.occurrence_id=o.id AND own_att.user_id=$1) attended,
       (SELECT COUNT(*)::int FROM occurrence_rsvps rr WHERE rr.occurrence_id=o.id AND rr.status='going') going_count,
       (SELECT COUNT(*)::int FROM occurrence_attendance aa WHERE aa.occurrence_id=o.id) attendance_count,
       (SELECT COUNT(*)::int FROM room_members rm WHERE rm.room_id=o.room_id) member_count,
       (r.host_id=$1 OR EXISTS(SELECT 1 FROM room_members cm WHERE cm.room_id=o.room_id AND cm.user_id=$1 AND (cm.role='host' OR (cm.role='cohost' AND cm.permissions->>'manage_schedule'='true')))) can_manage,
       (r.host_id=$1 OR EXISTS(SELECT 1 FROM room_members cm WHERE cm.room_id=o.room_id AND cm.user_id=$1 AND (cm.role='host' OR (cm.role='cohost' AND cm.permissions->>'manage_attendance'='true')))) can_manage_attendance,
       CASE WHEN (r.host_id=$1 OR EXISTS(SELECT 1 FROM room_members cm WHERE cm.room_id=o.room_id AND cm.user_id=$1 AND (cm.role='host' OR (cm.role='cohost' AND cm.permissions->>'manage_attendance'='true')))) THEN
         COALESCE((SELECT json_agg(json_build_object('id',rm.user_id,'username',member.username,
           'attended',EXISTS(SELECT 1 FROM occurrence_attendance attended WHERE attended.occurrence_id=o.id AND attended.user_id=rm.user_id)))
           FROM room_members rm JOIN users member ON member.id=rm.user_id WHERE rm.room_id=o.room_id),'[]'::json)
         ELSE '[]'::json END attendance_members,
       (r.host_id=$1) can_reschedule
     FROM room_occurrences o JOIN rooms r ON r.id=o.room_id JOIN users h ON h.id=r.host_id
       LEFT JOIN occurrence_rsvps mine ON mine.occurrence_id=o.id AND mine.user_id=$1
     WHERE o.starts_at >= $2 AND o.starts_at <= $3 AND (
       r.access_type='public' OR EXISTS(SELECT 1 FROM room_members m WHERE m.room_id=r.id AND m.user_id=$1)
       OR EXISTS(SELECT 1 FROM room_invitations i WHERE i.room_id=r.id AND i.invited_user_id=$1))
     ORDER BY o.starts_at LIMIT 250`, [me.id, from, to],
  );
  res.json({ occurrences: rows });
}));

const occurrenceForUser = async (occurrenceId: string, userId: string) => {
  const found = await run(
    `SELECT o.id,o.room_id,o.starts_at,o.status,r.title,r.access_type,r.host_id,r.participant_limit
       FROM room_occurrences o JOIN rooms r ON r.id=o.room_id WHERE o.id=$1`, [occurrenceId],
  );
  const occurrence = found.rows[0];
  if (!occurrence) throw new HttpError(404, 'Study-room occurrence not found.');
  const access = await run(
    `SELECT 1 FROM room_members WHERE room_id=$1 AND user_id=$2
     UNION SELECT 1 FROM room_invitations WHERE room_id=$1 AND invited_user_id=$2`, [occurrence.room_id, userId],
  );
  if (occurrence.access_type !== 'public' && !access.rows[0]) throw new HttpError(403, 'This room is private.');
  return occurrence;
};

app.post('/calendar/occurrences/:occurrenceId/rsvp', authenticate, asyncRoute(async (req, res) => {
  const me = user(req); const occurrenceId = id(req, 'occurrenceId');
  const occurrence = await occurrenceForUser(occurrenceId, me.id);
  if (occurrence.status === 'cancelled') throw new HttpError(409, 'This occurrence was cancelled.');
  const status = String(req.body.status ?? '');
  if (!['going', 'maybe', 'declined'].includes(status)) throw new HttpError(400, 'Choose going, maybe, or declined.');
  if (status === 'going') {
    const confirmed = await run("SELECT COUNT(*)::int total FROM occurrence_rsvps WHERE occurrence_id=$1 AND status='going' AND user_id<>$2", [occurrenceId, me.id]);
    if (Number(confirmed.rows[0]?.total ?? 0) >= Number(occurrence.participant_limit)) {
      throw new HttpError(409, 'This meeting has no RSVP seats left.');
    }
  }
  const reminderEnabled = req.body.reminderEnabled !== false && status === 'going';
  await run(
    `INSERT INTO occurrence_rsvps(occurrence_id,user_id,status,reminder_enabled,reminder_sent_at)
     VALUES($1,$2,$3,$4,NULL) ON CONFLICT(occurrence_id,user_id) DO UPDATE SET
       status=EXCLUDED.status,reminder_enabled=EXCLUDED.reminder_enabled,
       reminder_sent_at=CASE WHEN occurrence_rsvps.reminder_enabled=FALSE AND EXCLUDED.reminder_enabled=TRUE
         THEN NULL ELSE occurrence_rsvps.reminder_sent_at END,updated_at=NOW()`,
    [occurrenceId, me.id, status, reminderEnabled],
  );
  io.to(`room:${occurrence.room_id}`).emit('calendar:rsvp', { occurrenceId, userId: me.id, status });
  res.json({ occurrenceId, status, reminderEnabled });
}));

app.patch('/calendar/occurrences/:occurrenceId', authenticate, asyncRoute(async (req, res) => {
  const me = user(req); const occurrenceId = id(req, 'occurrenceId');
  const occurrence = await occurrenceForUser(occurrenceId, me.id);
  await requireRoomHost(occurrence.room_id, me.id);
  if (occurrence.status !== 'scheduled') throw new HttpError(409, 'Only a scheduled meeting can be moved.');
  if (new Date(occurrence.starts_at).getTime() <= Date.now()) throw new HttpError(409, 'A started meeting cannot be moved.');
  const startsAt = scheduledDate(req.body.startsAt);
  if (!startsAt) throw new HttpError(400, 'Choose a new start time.');
  const conflict = await run(
    'SELECT 1 FROM room_occurrences WHERE room_id=$1 AND starts_at=$2 AND id<>$3',
    [occurrence.room_id, startsAt, occurrenceId],
  );
  if (conflict.rows[0]) throw new HttpError(409, 'This room already has a meeting at that time.');
  await run('UPDATE room_occurrences SET starts_at=$2 WHERE id=$1', [occurrenceId, startsAt]);
  await run('UPDATE occurrence_rsvps SET reminder_sent_at=NULL,updated_at=NOW() WHERE occurrence_id=$1 AND reminder_enabled=TRUE AND status=\'going\'', [occurrenceId]);
  const attendees = await run(
    "SELECT user_id FROM occurrence_rsvps WHERE occurrence_id=$1 AND status IN ('going','maybe') AND user_id<>$2",
    [occurrenceId, me.id],
  );
  const when = new Intl.DateTimeFormat('en', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(startsAt));
  for (const attendee of attendees.rows) {
    await notify(attendee.user_id, 'Study room meeting moved', `${occurrence.title} now starts ${when}.`, 'occurrence_rescheduled');
  }
  io.to(`room:${occurrence.room_id}`).emit('calendar:rescheduled', { occurrenceId, startsAt });
  res.json({ occurrenceId, startsAt });
}));

app.post('/calendar/occurrences/:occurrenceId/cancel', authenticate, asyncRoute(async (req, res) => {
  const me = user(req); const occurrenceId = id(req, 'occurrenceId');
  const occurrence = await occurrenceForUser(occurrenceId, me.id);
  await requireRoomPermission(occurrence.room_id, me.id, 'manage_schedule');
  if (new Date(occurrence.starts_at).getTime() <= Date.now()) throw new HttpError(409, 'A started occurrence cannot be cancelled.');
  await run("UPDATE room_occurrences SET status='cancelled' WHERE id=$1", [occurrenceId]);
  const attendees = await run("SELECT user_id FROM occurrence_rsvps WHERE occurrence_id=$1 AND status IN ('going','maybe') AND user_id<>$2", [occurrenceId, me.id]);
  for (const attendee of attendees.rows) await notify(attendee.user_id, 'Study room cancelled', `${occurrence.title} was cancelled by its host.`, 'occurrence_cancelled');
  io.to(`room:${occurrence.room_id}`).emit('calendar:cancelled', { occurrenceId });
  res.json({ occurrenceId, status: 'cancelled' });
}));

app.post('/calendar/occurrences/:occurrenceId/attendance', authenticate, asyncRoute(async (req, res) => {
  const me = user(req); const occurrenceId = id(req, 'occurrenceId');
  const occurrence = await occurrenceForUser(occurrenceId, me.id);
  if (occurrence.status === 'cancelled') throw new HttpError(409, 'This occurrence was cancelled.');
  const targetId = typeof req.body.userId === 'string' ? req.body.userId : me.id;
  if (targetId === me.id) await requireRoomMember(occurrence.room_id, me.id);
  else {
    await requireRoomPermission(occurrence.room_id, me.id, 'manage_attendance');
    await requireRoomMember(occurrence.room_id, targetId);
  }
  const start = new Date(occurrence.starts_at).getTime();
  if (Date.now() < start - 60 * 60_000 || Date.now() > start + 4 * 60 * 60_000) {
    throw new HttpError(409, 'Attendance opens one hour before the room and closes four hours after it starts.');
  }
  const attendance = await run('INSERT INTO occurrence_attendance(occurrence_id,user_id,marked_by) VALUES($1,$2,$3) ON CONFLICT(occurrence_id,user_id) DO NOTHING RETURNING occurrence_id', [occurrenceId, targetId, me.id]);
  if (attendance.rowCount) {
    await run(`INSERT INTO user_focus_activities(user_id,activity_key,source,occurred_at)
      VALUES($1,$2,'room_checkin',NOW()) ON CONFLICT(user_id,activity_key) DO NOTHING`, [targetId, `attendance:${occurrenceId}`]);
  }
  res.json({ occurrenceId, userId: targetId, attended: true });
}));

app.get('/rooms/invitations', authenticate, asyncRoute(async (req, res) => {
  const me = user(req);
  const { rows } = await run(
    `SELECT i.room_id,r.title,r.subject,r.goal,r.participant_limit,r.created_at,h.username host_name,
       (SELECT COUNT(*)::int FROM room_members m WHERE m.room_id=r.id) member_count
     FROM room_invitations i JOIN rooms r ON r.id=i.room_id JOIN users h ON h.id=r.host_id
     WHERE i.invited_user_id=$1 AND r.access_type='invite' AND r.status='open' ORDER BY i.created_at DESC`, [me.id],
  );
  res.json({ invitations: rows });
}));

app.delete('/rooms/invitations/:roomId', authenticate, asyncRoute(async (req, res) => {
  const me = user(req);
  await run('DELETE FROM room_invitations WHERE room_id=$1 AND invited_user_id=$2', [id(req, 'roomId'), me.id]);
  res.json({ dismissed: true });
}));

app.post('/rooms', authenticate, asyncRoute(async (req, res) => {
  const me = user(req);
  const accessType = ['public', 'link', 'invite'].includes(req.body.accessType) ? req.body.accessType : 'public';
  const cap = Math.max(2, Math.min(50, Number(req.body.participantLimit) || 8));
  const code = accessType === 'link' ? crypto.randomBytes(4).toString('hex').toUpperCase() : null;
  const scheduledAt = scheduledDate(req.body.scheduledAt);
  const recurrence = recurrenceValue(req.body.recurrence);
  if (recurrence !== 'none' && scheduledAt == null) throw new HttpError(400, 'Choose a start date before setting a repeating room.');
  const { rows } = await run(
    `INSERT INTO rooms(host_id,title,subject,course,goal,access_type,access_code,participant_limit,language,scheduled_at,recurrence)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [me.id, required(req.body.title, 'Room name', 80), required(req.body.subject, 'Subject', 60), text(req.body.course, 60), required(req.body.goal, 'Study goal', 240), accessType, code, cap, text(req.body.language, 40) || 'English', scheduledAt, recurrence],
  );
  await run('INSERT INTO room_members(room_id,user_id,role) VALUES($1,$2,\'host\')', [rows[0]!.id, me.id]);
  await materializeOccurrences(rows[0]!.id, rows[0]!.scheduled_at, rows[0]!.recurrence);
  res.status(201).json({ room: rows[0], accessCode: code });
}));

app.get('/room-templates', authenticate, asyncRoute(async (req, res) => {
  const me = user(req);
  const { rows } = await run('SELECT * FROM room_templates WHERE owner_id=$1 ORDER BY created_at DESC', [me.id]);
  res.json({ templates: rows });
}));

app.post('/room-templates', authenticate, asyncRoute(async (req, res) => {
  const me = user(req);
  const accessType = ['public', 'link', 'invite'].includes(req.body.accessType) ? req.body.accessType : 'public';
  const recurrence = recurrenceValue(req.body.recurrence);
  const limit = Math.max(2, Math.min(50, Number(req.body.participantLimit) || 8));
  const { rows } = await run(
    `INSERT INTO room_templates(owner_id,title,subject,course,goal,access_type,participant_limit,recurrence)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [me.id, required(req.body.title, 'Template name', 80), required(req.body.subject, 'Subject', 60), text(req.body.course, 60), required(req.body.goal, 'Study goal', 240), accessType, limit, recurrence],
  );
  res.status(201).json({ template: rows[0] });
}));

app.delete('/room-templates/:id', authenticate, asyncRoute(async (req, res) => {
  const me = user(req);
  const result = await run('DELETE FROM room_templates WHERE id=$1 AND owner_id=$2', [id(req), me.id]);
  if (!result.rowCount) throw new HttpError(404, 'Room template not found.');
  res.json({ deleted: true });
}));

app.post('/rooms/:roomId/members/:userId/cohost', authenticate, asyncRoute(async (req, res) => {
  const me = user(req); const roomId = id(req, 'roomId'); const target = id(req, 'userId');
  await requireRoomHost(roomId, me.id);
  if (target === me.id) throw new HttpError(400, 'The host is already the room host.');
  const current = await requireRoomMember(roomId, target);
  if (current.role === 'host') throw new HttpError(400, 'The host role cannot be changed here.');
  const role = req.body.enabled === true ? 'cohost' : 'member';
  const allowedPermissions = new Set(['manage_members', 'manage_room', 'manage_schedule', 'manage_attendance', 'moderate_chat']);
  const requested = Array.isArray(req.body.permissions) ? req.body.permissions : [];
  const permissions = role === 'cohost'
    ? Object.fromEntries(requested.filter((permission: unknown): permission is string => typeof permission === 'string' && allowedPermissions.has(permission)).map((permission: string) => [permission, true]))
    : {};
  await run('UPDATE room_members SET role=$3,permissions=$4::jsonb WHERE room_id=$1 AND user_id=$2', [roomId, target, role, JSON.stringify(permissions)]);
  io.to(`room:${roomId}`).emit('room:role_changed', { roomId, userId: target, role, permissions });
  res.json({ userId: target, role, permissions });
}));

app.get('/share/rooms/:id', asyncRoute(async (req, res) => {
  const roomId = id(req);
  const found = await run(
    `SELECT id,title,subject,goal,access_type,status,scheduled_at,recurrence
       FROM rooms WHERE id=$1`, [roomId],
  );
  const room = found.rows[0];
  if (!room || room.access_type !== 'public' || room.status !== 'open') {
    throw new HttpError(404, 'That public room is not available.');
  }
  const scheduled = roomWithNextSchedule(room);
  const when = scheduled.scheduled_at
    ? new Intl.DateTimeFormat('en', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(scheduled.scheduled_at as Date | string))
    : 'Ready to join now';
  const repeat = room.recurrence === 'daily' ? ' · repeats daily' : room.recurrence === 'weekly' ? ' · repeats weekly' : '';
  const title = escapeHtml(room.title);
  const subject = escapeHtml(room.subject);
  const goal = escapeHtml(room.goal);
  res.type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#06475c"><title>${title} · aLaStudie</title>
<style>*{box-sizing:border-box}body{margin:0;background:#f5f0e7;color:#10212a;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:100vh;display:grid;place-items:center;padding:24px}.card{width:min(100%,560px);padding:32px;border-radius:30px;background:#06475c;color:#fff;box-shadow:0 24px 64px #10212a20}.brand{font-weight:800;letter-spacing:-.05em;font-size:20px}.brand i{font-style:normal;color:#ff1230}.eyebrow{margin:38px 0 10px;color:#e5d3bd;font-size:12px;letter-spacing:.18em;font-weight:800;text-transform:uppercase}h1{font-size:clamp(34px,8vw,56px);line-height:.98;letter-spacing:-.055em;margin:0 0 16px}.goal{color:#d9e0e1;font-size:17px}.details{margin-top:26px;padding-top:18px;border-top:1px solid #ffffff35;color:#fff;font-weight:700}.hint{margin:22px 0 0;padding:14px 16px;border-radius:14px;background:#ffffff12;color:#f4f0e9;font-size:14px}.mark{display:inline-block;margin-top:24px;padding:11px 16px;background:#ff1230;border-radius:999px;color:#fff;text-decoration:none;font-size:13px;font-weight:800}</style></head>
<body><main class="card"><div class="brand">aLaStud<span style="color:#fff">i</span><i>e</i></div><div class="eyebrow">PUBLIC STUDY ROOM · ${subject}</div><h1>${title}</h1><div class="goal">${goal}</div><div class="details">${escapeHtml(when + repeat)}</div><p class="hint">Open aLaStudie, go to Discover, and search for <strong>${title}</strong> to join this room.</p><div class="mark">aLaStudie · study together</div></main></body></html>`);
}));

app.post('/rooms/join-by-code', authenticate, asyncRoute(async (req, res) => {
  const me = user(req);
  const code = required(req.body.accessCode, 'Room code', 24).toUpperCase();
  const found = await run("SELECT * FROM rooms WHERE access_type='link' AND access_code=$1 AND status='open'", [code]);
  const room = found.rows[0];
  if (!room) throw new HttpError(404, 'That room code is invalid or the room has closed.');
  const already = await run('SELECT 1 FROM room_members WHERE room_id=$1 AND user_id=$2', [room.id, me.id]);
  if (already.rows[0]) return res.json({ roomId: room.id, message: 'You are already in this room.' });
  const count = await run('SELECT COUNT(*)::int n FROM room_members WHERE room_id=$1', [room.id]);
  if (count.rows[0]!.n >= room.participant_limit) throw new HttpError(409, 'This room has reached its participant limit.');
  await run('INSERT INTO room_members(room_id,user_id) VALUES($1,$2)', [room.id, me.id]);
  await run('INSERT INTO task_completions(task_id,user_id) SELECT id,$2 FROM tasks WHERE room_id=$1 AND is_personal=FALSE ON CONFLICT DO NOTHING', [room.id, me.id]);
  const activeSession = await currentSession(room.id);
  if (activeSession) await run('INSERT INTO session_participants(session_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [activeSession.id, me.id]);
  await notify(room.host_id, `${me.username} joined your room`, room.title, 'room_join');
  io.to(`room:${room.id}`).emit('room:member_joined', { roomId: room.id, user: { id: me.id, username: me.username } });
  res.status(201).json({ roomId: room.id, message: 'You joined the room.' });
}));

app.get('/rooms/:id', authenticate, asyncRoute(async (req, res) => {
  const me = user(req); const roomId = id(req);
  const myMembership = await requireRoomMember(roomId, me.id);
  const roomQuery = await run(
    `SELECT r.*,h.username host_name,COUNT(m.user_id)::int member_count FROM rooms r
     JOIN users h ON h.id=r.host_id LEFT JOIN room_members m ON m.room_id=r.id WHERE r.id=$1 GROUP BY r.id,h.username`, [roomId],
  );
  if (!roomQuery.rows[0]) throw new HttpError(404, 'Room not found.');
  const members = await run(
    `SELECT u.id,u.username,CASE WHEN u.id=$2 OR COALESCE(u.profile->>'visibility','private')='public' THEN u.profile ELSE '{}'::jsonb END profile,m.role,m.permissions,m.joined_at
       FROM room_members m JOIN users u ON u.id=m.user_id WHERE m.room_id=$1 ORDER BY m.role DESC,m.joined_at`, [roomId, me.id],
  );
  const tasks = await run(
    `SELECT t.*,COALESCE(json_agg(json_build_object('userId',c.user_id,'completedAt',c.completed_at)) FILTER (WHERE c.user_id IS NOT NULL),'[]') completions
       FROM tasks t LEFT JOIN task_completions c ON c.task_id=t.id
         AND EXISTS(SELECT 1 FROM room_members current_member WHERE current_member.room_id=$1 AND current_member.user_id=c.user_id)
       WHERE t.room_id=$1 AND t.is_personal=FALSE GROUP BY t.id ORDER BY t.created_at`, [roomId],
  );
  res.json({ room: roomWithNextSchedule(roomQuery.rows[0]!), role: myMembership.role, permissions: myMembership.permissions ?? {}, members: members.rows, tasks: tasks.rows, session: sessionView(await currentSession(roomId)), presence: presenceForRoom(roomId) });
}));

app.post('/rooms/:id/join', authenticate, asyncRoute(async (req, res) => {
  const me = user(req); const roomId = id(req);
  const found = await run('SELECT * FROM rooms WHERE id=$1 AND status=\'open\'', [roomId]);
  const room = found.rows[0]; if (!room) throw new HttpError(404, 'Room is not available.');
  const already = await run('SELECT 1 FROM room_members WHERE room_id=$1 AND user_id=$2', [roomId, me.id]);
  if (already.rows[0]) return res.json({ message: 'You are already in this room.' });
  if (room.access_type === 'link' && text(req.body.accessCode).toUpperCase() !== room.access_code) throw new HttpError(403, 'Enter the room code to join.');
  if (room.access_type === 'invite') {
    const invite = await run('SELECT 1 FROM room_invitations WHERE room_id=$1 AND invited_user_id=$2', [roomId, me.id]);
    if (!invite.rows[0]) throw new HttpError(403, 'This room is invite-only.');
  }
  if (room.access_type === 'invite') await run('DELETE FROM room_invitations WHERE room_id=$1 AND invited_user_id=$2', [roomId, me.id]);
  const count = await run('SELECT COUNT(*)::int n FROM room_members WHERE room_id=$1', [roomId]);
  if (count.rows[0]!.n >= room.participant_limit) throw new HttpError(409, 'This room has reached its participant limit.');
  await run('INSERT INTO room_members(room_id,user_id) VALUES($1,$2)', [roomId, me.id]);
  await run('INSERT INTO task_completions(task_id,user_id) SELECT id,$2 FROM tasks WHERE room_id=$1 AND is_personal=FALSE ON CONFLICT DO NOTHING', [roomId, me.id]);
  const activeSession = await currentSession(roomId);
  if (activeSession) await run('INSERT INTO session_participants(session_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [activeSession.id, me.id]);
  await notify(room.host_id, `${me.username} joined your room`, room.title, 'room_join');
  io.to(`room:${roomId}`).emit('room:member_joined', { roomId, user: { id: me.id, username: me.username } });
  res.status(201).json({ message: 'You joined the room.' });
}));

app.post('/rooms/:id/invitations', authenticate, asyncRoute(async (req, res) => {
  const me = user(req); const roomId = id(req); await requireRoomPermission(roomId, me.id, 'manage_members');
  const roomAccess = await run('SELECT access_type FROM rooms WHERE id=$1', [roomId]);
  if (roomAccess.rows[0]?.access_type !== 'invite') throw new HttpError(400, 'Direct invitations are for invite-only rooms.');
  const username = required(req.body.username, 'Username', 32).replace(/^@/, '');
  const target = await run('SELECT id,email FROM users WHERE username=$1 AND is_verified=TRUE', [username]);
  if (!target.rows[0]) throw new HttpError(404, 'Verified account not found.');
  await run('INSERT INTO room_invitations(room_id,invited_user_id,invited_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [roomId, target.rows[0]!.id, me.id]);
  const room = await run('SELECT title FROM rooms WHERE id=$1', [roomId]);
  await notify(target.rows[0]!.id, 'Study room invitation', `You were invited to ${room.rows[0]!.title}.`, 'room_invite');
  res.status(201).json({ message: 'Invitation sent.' });
}));

app.post('/rooms/:id/leave', authenticate, asyncRoute(async (req, res) => {
  const me = user(req); const roomId = id(req);
  const membership = await requireRoomMember(roomId, me.id);
  if (membership.role === 'host') throw new HttpError(409, 'Transfer the host role or close the room before leaving.');
  await run('DELETE FROM room_members WHERE room_id=$1 AND user_id=$2', [roomId, me.id]);
  await run('DELETE FROM task_completions c USING tasks t WHERE c.task_id=t.id AND t.room_id=$1 AND c.user_id=$2', [roomId, me.id]);
  await setPresence(roomId, me.id, 'offline');
  res.json({ message: 'You left the room.' });
}));

app.delete('/rooms/:roomId/members/:userId', authenticate, asyncRoute(async (req, res) => {
  const me = user(req); const roomId = id(req, 'roomId'); const target = id(req, 'userId');
  const managerRole = await requireRoomPermission(roomId, me.id, 'manage_members');
  if (target === me.id) throw new HttpError(400, 'The host cannot remove themselves.');
  const targetMembership = await requireRoomMember(roomId, target);
  if (targetMembership.role === 'host' || (managerRole === 'cohost' && targetMembership.role === 'cohost')) {
    throw new HttpError(403, 'A co-host cannot remove the host or another co-host.');
  }
  await run('DELETE FROM room_members WHERE room_id=$1 AND user_id=$2', [roomId, target]);
  await run('DELETE FROM task_completions c USING tasks t WHERE c.task_id=t.id AND t.room_id=$1 AND c.user_id=$2', [roomId, target]);
  await setPresence(roomId, target, 'offline');
  io.to(`user:${target}`).emit('room:removed', { roomId });
  res.json({ message: 'Member removed.' });
}));

app.patch('/rooms/:id', authenticate, asyncRoute(async (req, res) => {
  const me = user(req); const roomId = id(req);
  if (req.body.closed === true) await requireRoomHost(roomId, me.id);
  else await requireRoomPermission(roomId, me.id, 'manage_room');
  const changesSchedule = Object.prototype.hasOwnProperty.call(req.body, 'scheduledAt');
  const scheduledAt = changesSchedule ? scheduledDate(req.body.scheduledAt) : null;
  const recurrence = Object.prototype.hasOwnProperty.call(req.body, 'recurrence') ? recurrenceValue(req.body.recurrence) : null;
  if (recurrence != null && recurrence !== 'none' && changesSchedule && scheduledAt == null) {
    throw new HttpError(400, 'Choose a start date before setting a repeating room.');
  }
  const { rows } = await run(
    `UPDATE rooms SET title=COALESCE(NULLIF($3,''),title),goal=COALESCE(NULLIF($4,''),goal),
      participant_limit=COALESCE($5,participant_limit),status=COALESCE($6,status),
      scheduled_at=CASE WHEN $7 THEN $8::timestamptz ELSE scheduled_at END,
      recurrence=COALESCE($9,recurrence) WHERE id=$1 AND EXISTS(
        SELECT 1 FROM room_members manager WHERE manager.room_id=rooms.id AND manager.user_id=$2 AND
          (manager.role='host' OR (manager.role='cohost' AND manager.permissions->>'manage_room'='true'))) RETURNING *`,
    [roomId, me.id, text(req.body.title, 80), text(req.body.goal, 240), req.body.participantLimit ? Math.max(2, Math.min(50, Number(req.body.participantLimit))) : null, req.body.closed === true ? 'closed' : null, changesSchedule, scheduledAt, recurrence],
  );
  await materializeOccurrences(roomId, rows[0]!.scheduled_at, String(rows[0]!.recurrence ?? 'none'));
  if (req.body.closed === true) {
    const session = await currentSession(roomId);
    if (session) {
      await closeFocusIntervals(session.id);
      await run("UPDATE study_sessions SET status='finished',phase='finished',finished_at=NOW(),phase_started_at=NULL WHERE id=$1", [session.id]);
      io.to(`room:${roomId}`).emit('session:update', { id: session.id, status: 'finished', phase: 'finished', remainingSeconds: 0 });
    }
    io.to(`room:${roomId}`).emit('room:closed', { roomId });
  }
  res.json({ room: roomWithNextSchedule(rows[0]!) });
}));

app.get('/tasks/personal', authenticate, asyncRoute(async (req, res) => {
  const me = user(req);
  const { rows } = await run(
    `SELECT t.*,c.completed_at FROM tasks t LEFT JOIN task_completions c ON c.task_id=t.id AND c.user_id=$1
     WHERE t.owner_id=$1 AND t.is_personal=TRUE ORDER BY t.created_at DESC`, [me.id],
  );
  res.json({ tasks: rows });
}));
app.post('/tasks/personal', authenticate, asyncRoute(async (req, res) => {
  const me = user(req);
  const { rows } = await run('INSERT INTO tasks(owner_id,title,is_personal) VALUES($1,$2,TRUE) RETURNING *', [me.id, required(req.body.title, 'Task', 160)]);
  res.status(201).json({ task: rows[0] });
}));
app.post('/rooms/:id/tasks', authenticate, asyncRoute(async (req, res) => {
  const me = user(req); const roomId = id(req); await requireRoomMember(roomId, me.id);
  const { rows } = await run('INSERT INTO tasks(room_id,owner_id,title) VALUES($1,$2,$3) RETURNING *', [roomId, me.id, required(req.body.title, 'Task', 160)]);
  const members = await run('SELECT user_id FROM room_members WHERE room_id=$1', [roomId]);
  for (const member of members.rows) await run('INSERT INTO task_completions(task_id,user_id) VALUES($1,$2)', [rows[0]!.id, member.user_id]);
  io.to(`room:${roomId}`).emit('task:changed', { roomId, task: rows[0] });
  res.status(201).json({ task: rows[0] });
}));
app.patch('/tasks/:id', authenticate, asyncRoute(async (req, res) => {
  const me = user(req); const taskId = id(req);
  const found = await run('SELECT * FROM tasks WHERE id=$1', [taskId]); const task = found.rows[0];
  if (!task) throw new HttpError(404, 'Task not found.');
  if (task.is_personal && task.owner_id !== me.id) throw new HttpError(403, 'That task is private.');
  if (task.room_id) await requireRoomMember(task.room_id, me.id);
  const { rows } = await run('UPDATE tasks SET title=$2 WHERE id=$1 RETURNING *', [taskId, required(req.body.title, 'Task', 160)]);
  if (task.room_id) io.to(`room:${task.room_id}`).emit('task:changed', { roomId: task.room_id, task: rows[0] });
  res.json({ task: rows[0] });
}));
app.delete('/tasks/:id', authenticate, asyncRoute(async (req, res) => {
  const me = user(req); const taskId = id(req); const found = await run('SELECT * FROM tasks WHERE id=$1', [taskId]); const task = found.rows[0];
  if (!task) throw new HttpError(404, 'Task not found.');
  if (task.is_personal && task.owner_id !== me.id) throw new HttpError(403, 'That task is private.');
  if (task.room_id) await requireRoomMember(task.room_id, me.id);
  await run('DELETE FROM tasks WHERE id=$1', [taskId]);
  if (task.room_id) io.to(`room:${task.room_id}`).emit('task:removed', { roomId: task.room_id, taskId });
  res.json({ message: 'Task removed.' });
}));
app.patch('/tasks/:id/completion', authenticate, asyncRoute(async (req, res) => {
  const me = user(req); const taskId = id(req); const found = await run('SELECT * FROM tasks WHERE id=$1', [taskId]); const task = found.rows[0];
  if (!task) throw new HttpError(404, 'Task not found.');
  if (task.is_personal && task.owner_id !== me.id) throw new HttpError(403, 'That task is private.');
  if (task.room_id) await requireRoomMember(task.room_id, me.id);
  const completed = req.body.completed === true;
  await run('INSERT INTO task_completions(task_id,user_id,completed_at) VALUES($1,$2,$3) ON CONFLICT(task_id,user_id) DO UPDATE SET completed_at=EXCLUDED.completed_at', [taskId, me.id, completed ? new Date().toISOString() : null]);
  const result = { taskId, userId: me.id, completed };
  if (task.room_id) io.to(`room:${task.room_id}`).emit('task:completion', result);
  res.json(result);
}));

app.post('/rooms/:id/sessions', authenticate, asyncRoute(async (req, res) => {
  const me = user(req); const roomId = id(req); await requireRoomHost(roomId, me.id);
  const roomSchedule = await run('SELECT scheduled_at,recurrence FROM rooms WHERE id=$1', [roomId]);
  const scheduledStart = roomSchedule.rows[0]?.scheduled_at;
  if (scheduledStart) {
    const state = scheduleState(
      new Date(scheduledStart).getTime(),
      String(roomSchedule.rows[0]?.recurrence ?? 'none'),
    );
    if (!state.active) {
      throw new HttpError(409, 'This room is outside its scheduled study time. Try again when it meets.');
    }
  }
  const existing = await currentSession(roomId);
  if (existing) throw new HttpError(409, 'Finish the active session first.');
  const preset = ['classic', 'deep', 'custom'].includes(req.body.preset) ? req.body.preset : 'classic';
  const focusMinutes = preset === 'classic' ? 25 : preset === 'deep' ? 50 : Math.max(5, Math.min(180, Number(req.body.focusMinutes) || 25));
  const breakMinutes = preset === 'classic' ? 5 : preset === 'deep' ? 10 : Math.max(1, Math.min(60, Number(req.body.breakMinutes) || 5));
  const { rows } = await run(
    `INSERT INTO study_sessions(room_id,host_id,preset,focus_seconds,break_seconds,phase_started_at,remaining_seconds)
     VALUES($1,$2,$3,$4,$5,NOW(),$4) RETURNING *`, [roomId, me.id, preset, focusMinutes * 60, breakMinutes * 60],
  );
  const members = await run('SELECT user_id FROM room_members WHERE room_id=$1', [roomId]);
  for (const member of members.rows) {
    const active = roomPresence.get(roomId)?.get(member.user_id) === 'studying';
    await run('INSERT INTO session_participants(session_id,user_id,last_focus_started_at) VALUES($1,$2,$3)', [rows[0]!.id, member.user_id, active ? new Date().toISOString() : null]);
    if (active) await openFocusInterval(rows[0]!.id, member.user_id);
    await notify(member.user_id, 'Study session started', 'The room focus timer is running.', 'session_start');
  }
  const view = sessionView({ ...rows[0], host_name: me.username });
  io.to(`room:${roomId}`).emit('session:update', view);
  res.status(201).json({ session: view });
}));
app.post('/sessions/:id/control', authenticate, asyncRoute(async (req, res) => {
  const me = user(req); const sessionId = id(req); const found = await run('SELECT * FROM study_sessions WHERE id=$1', [sessionId]); const session = found.rows[0];
  if (!session) throw new HttpError(404, 'Session not found.');
  await requireRoomHost(session.room_id, me.id);
  const action = text(req.body.action, 20);
  if (action === 'pause' && session.status === 'running') {
    const left = Math.max(0, Number(session.remaining_seconds) - Math.floor((Date.now() - new Date(session.phase_started_at).getTime()) / 1000));
    await closeFocusIntervals(sessionId);
    await run('UPDATE study_sessions SET status=\'paused\',remaining_seconds=$2,phase_started_at=NULL WHERE id=$1', [sessionId, left]);
  } else if (action === 'resume' && session.status === 'paused') {
    await run('UPDATE study_sessions SET status=\'running\',phase_started_at=NOW() WHERE id=$1', [sessionId]);
    if (session.phase === 'focus') {
      for (const [memberId, presence] of roomPresence.get(session.room_id) ?? []) if (presence === 'studying') await openFocusInterval(sessionId, memberId);
    }
  } else if (action === 'finish') {
    await closeFocusIntervals(sessionId);
    await run('UPDATE study_sessions SET status=\'finished\',phase=\'finished\',finished_at=NOW(),phase_started_at=NULL WHERE id=$1', [sessionId]);
  } else throw new HttpError(409, 'That session action is not available.');
  const view = sessionView(await currentSession(session.room_id));
  io.to(`room:${session.room_id}`).emit('session:update', view ?? { id: sessionId, status: 'finished', phase: 'finished', remainingSeconds: 0 });
  res.json({ session: view });
}));
app.get('/sessions/history', authenticate, asyncRoute(async (req, res) => {
  const me = user(req);
  const { rows } = await run(
    `SELECT s.id,s.preset,s.started_at,s.finished_at,r.title room_title,
      COALESCE(p.focused_seconds,0)::int focused_seconds,
      (SELECT COUNT(*)::int FROM task_completions c JOIN tasks t ON t.id=c.task_id WHERE t.room_id=r.id AND c.user_id=$1 AND c.completed_at BETWEEN s.started_at AND COALESCE(s.finished_at,NOW())) task_count
     FROM session_participants p JOIN study_sessions s ON s.id=p.session_id JOIN rooms r ON r.id=s.room_id
     WHERE p.user_id=$1 ORDER BY s.started_at DESC LIMIT 100`, [me.id],
  );
  res.json({ sessions: rows });
}));
app.get('/stats', authenticate, asyncRoute(async (req, res) => {
  const me = user(req); const timezone = text(req.query.timezone, 64) || 'UTC';
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }); }
  catch { throw new HttpError(400, 'Choose a valid local timezone.'); }
  const [{ rows }, todayResult] = await Promise.all([
    run(
      `WITH expanded AS (
         SELECT fi.session_id, bucket.day::date AS day,
           GREATEST(fi.started_at, bucket.day::date::timestamp AT TIME ZONE $2) AS interval_start,
           LEAST(COALESCE(fi.ended_at,NOW()), (bucket.day::date + 1)::timestamp AT TIME ZONE $2) AS interval_end
         FROM focus_intervals fi
         CROSS JOIN LATERAL generate_series(
           GREATEST((fi.started_at AT TIME ZONE $2)::date, (NOW() AT TIME ZONE $2)::date - 365)::timestamp,
           (COALESCE(fi.ended_at,NOW()) AT TIME ZONE $2)::date::timestamp,
           INTERVAL '1 day'
         ) AS bucket(day)
         WHERE fi.user_id=$1
       )
       , activity_days AS (
         SELECT (occurred_at AT TIME ZONE $2)::date AS day,
           SUM(focused_seconds)::int focused_seconds,SUM(session_count)::int sessions
         FROM user_focus_activities WHERE user_id=$1 AND source IN ('planner_block','room_checkin','nearby')
         GROUP BY (occurred_at AT TIME ZONE $2)::date
       ), combined AS (
         SELECT day,FLOOR(SUM(EXTRACT(EPOCH FROM (interval_end-interval_start))))::int focused_seconds,
           COUNT(DISTINCT session_id)::int sessions
         FROM expanded WHERE interval_end>interval_start GROUP BY day
         UNION ALL SELECT day,focused_seconds,sessions FROM activity_days
       )
       SELECT to_char(day, 'YYYY-MM-DD') AS day,SUM(focused_seconds)::int focused_seconds,SUM(sessions)::int sessions
       FROM combined GROUP BY day ORDER BY day`, [me.id, timezone],
    ),
    run('SELECT (NOW() AT TIME ZONE $1)::date::text local_today', [timezone]),
  ]);
  const days = rows.map((row) => ({ day: String(row.day), focusedSeconds: Number(row.focused_seconds ?? 0), sessions: Number(row.sessions) }));
  const localToday = String(todayResult.rows[0]!.local_today);
  const todayDate = new Date(`${localToday}T00:00:00Z`);
  const cutoff = new Date(todayDate.getTime() - 29 * 86_400_000).toISOString().slice(0, 10);
  const total = days.filter((day) => day.day >= cutoff && day.day <= localToday).reduce((sum, row) => sum + row.focusedSeconds, 0);
  let streak = 0; const byDay = new Map(days.map((day) => [day.day, day.focusedSeconds]));
  for (let offset = 0; offset < 366; offset++) {
    const date = new Date(todayDate.getTime() - offset * 86_400_000).toISOString().slice(0, 10);
    if ((byDay.get(date) ?? 0) >= 1500) streak++; else if (offset > 0) break;
  }
  res.json({ days: days.filter((day) => day.day >= cutoff), focusedSeconds30Days: total, streakDays: streak });
}));

app.get('/rooms/:id/messages', authenticate, asyncRoute(async (req, res) => {
  const me = user(req); const roomId = id(req); await requireRoomMember(roomId, me.id);
  const { rows } = await run(
    `SELECT m.*,u.username sender_name,(SELECT p.body FROM room_messages p WHERE p.id=m.reply_to
        AND NOT EXISTS(SELECT 1 FROM user_blocks b WHERE (b.blocker_id=p.sender_id AND b.blocked_id=$2) OR (b.blocker_id=$2 AND b.blocked_id=p.sender_id))) reply_body,
      COALESCE((SELECT json_agg(json_build_object('reaction',r.reaction,'userId',r.user_id)) FROM message_reactions r WHERE r.message_kind='room' AND r.message_id=m.id),'[]') reactions
      FROM room_messages m JOIN users u ON u.id=m.sender_id WHERE m.room_id=$1
        AND NOT EXISTS(SELECT 1 FROM user_blocks b WHERE (b.blocker_id=m.sender_id AND b.blocked_id=$2) OR (b.blocker_id=$2 AND b.blocked_id=m.sender_id))
      ORDER BY m.created_at DESC LIMIT 100`, [roomId, me.id],
  );
  res.json({ messages: rows.reverse() });
}));
app.post('/rooms/:id/messages', authenticate, asyncRoute(async (req, res) => {
  const me = user(req); const roomId = id(req); await requireRoomMember(roomId, me.id);
  const body = required(req.body.body, 'Message', 2000);
  const replyTo = text(req.body.replyTo, 64) || null;
  if (replyTo && !(await run('SELECT 1 FROM room_messages WHERE id=$1 AND room_id=$2', [replyTo, roomId])).rows[0]) throw new HttpError(400, 'That reply target is not in this room.');
  const mutationId = text(req.body.clientMutationId, 80) || null;
  const { rows } = await run(
    `INSERT INTO room_messages(room_id,sender_id,body,reply_to,client_mutation_id) VALUES($1,$2,$3,$4,$5)
     ON CONFLICT(sender_id,client_mutation_id) WHERE client_mutation_id IS NOT NULL DO NOTHING RETURNING *`,
    [roomId, me.id, body, replyTo, mutationId],
  );
  const created = rows.length > 0;
  const message = rows[0] ?? (await run('SELECT * FROM room_messages WHERE sender_id=$1 AND client_mutation_id=$2', [me.id, mutationId])).rows[0];
  const shaped = { ...message, sender_name: me.username };
  if (created) {
    await publishRoomMessage(roomId, me.id, 'room:message', shaped);
    const mentions = [...body.matchAll(/@([a-zA-Z0-9_]{2,32})/g)].map((match) => match[1]);
    if (mentions.length) {
      const targets = await run('SELECT id FROM users WHERE username=ANY($1::text[])', [mentions]);
      for (const target of targets.rows) if (target.id !== me.id && !await isBlockedEitherWay(me.id, target.id)) await notify(target.id, `Mentioned by ${me.username}`, body.slice(0, 100), 'mention');
    }
  }
  res.status(201).json({ message: shaped });
}));

app.post('/rooms/:roomId/messages/:messageId/pin', authenticate, asyncRoute(async (req, res) => {
  const me = user(req); const roomId = id(req, 'roomId'); const messageId = id(req, 'messageId'); await requireRoomPermission(roomId, me.id, 'moderate_chat');
  const { rows } = await run('UPDATE room_messages SET is_pinned=NOT is_pinned WHERE id=$1 AND room_id=$2 RETURNING *', [messageId, roomId]);
  if (!rows[0]) throw new HttpError(404, 'Message not found.');
  await publishRoomMessage(roomId, rows[0].sender_id, 'room:message_changed', rows[0]);
  res.json({ message: rows[0] });
}));

app.post('/messages/:kind/:messageId/reactions', authenticate, asyncRoute(async (req, res) => {
  const me = user(req); const kind = id(req, 'kind'); const messageId = id(req, 'messageId');
  if (kind !== 'room' && kind !== 'direct') throw new HttpError(400, 'Unknown message type.');
  const reaction = required(req.body.reaction, 'Reaction', 16);
  if (kind === 'room') {
    const found = await run('SELECT room_id FROM room_messages WHERE id=$1', [messageId]);
    if (!found.rows[0]) throw new HttpError(404, 'Message not found.');
    await requireRoomMember(found.rows[0].room_id, me.id);
    const sender = await run('SELECT sender_id FROM room_messages WHERE id=$1', [messageId]);
    if (await isBlockedEitherWay(me.id, sender.rows[0]!.sender_id)) throw new HttpError(403, 'This conversation is blocked.');
  } else {
    const found = await run(
      `SELECT d.request_id,d.sender_id,r.sender_id request_sender,r.recipient_id
       FROM direct_messages d JOIN direct_requests r ON r.id=d.request_id
       WHERE d.id=$1 AND r.status='accepted'`, [messageId],
    );
    const message = found.rows[0];
    if (!message || (message.request_sender !== me.id && message.recipient_id !== me.id)) throw new HttpError(404, 'Message not found.');
    const otherId = message.request_sender === me.id ? message.recipient_id : message.request_sender;
    if (await isBlockedEitherWay(me.id, otherId)) throw new HttpError(403, 'This conversation is blocked.');
  }
  await run('INSERT INTO message_reactions(message_kind,message_id,user_id,reaction) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [kind, messageId, me.id, reaction]);
  res.status(201).json({ messageId, reaction });
}));

app.post('/direct/requests', authenticate, asyncRoute(async (req, res) => {
  const me = user(req); const username = required(req.body.username, 'Username', 32).replace(/^@/, '');
  const targetQuery = await run('SELECT id,username,profile FROM users WHERE username=$1 AND is_verified=TRUE AND is_suspended=FALSE', [username]);
  const target = targetQuery.rows[0]; if (!target) throw new HttpError(404, 'Verified account not found.');
  if (target.id === me.id) throw new HttpError(400, 'You cannot message yourself.');
  if (target.profile?.allowMessageRequests === false) throw new HttpError(403, 'This student is not accepting new message requests.');
  if (await isBlockedEitherWay(me.id, target.id)) throw new HttpError(403, 'This message request is unavailable.');
  const { rows } = await run(
    `INSERT INTO direct_requests(sender_id,recipient_id) VALUES($1,$2) ON CONFLICT(sender_id,recipient_id)
      DO UPDATE SET status=CASE WHEN direct_requests.status='declined' THEN 'pending' ELSE direct_requests.status END RETURNING *`, [me.id, target.id],
  );
  await notify(target.id, 'New message request', `${me.username} would like to message you.`, 'dm_request');
  res.status(201).json({ request: rows[0] });
}));
app.get('/direct/requests', authenticate, asyncRoute(async (req, res) => {
  const me = user(req);
  const { rows } = await run(
    `SELECT d.*,s.username sender_name,r.username recipient_name FROM direct_requests d JOIN users s ON s.id=d.sender_id JOIN users r ON r.id=d.recipient_id
      WHERE (d.recipient_id=$1 AND d.status='pending') OR (d.sender_id=$1 AND d.status='accepted') ORDER BY d.created_at DESC`, [me.id],
  );
  res.json({ requests: rows });
}));
app.post('/direct/requests/:id/respond', authenticate, asyncRoute(async (req, res) => {
  const me = user(req); const requestId = id(req); const decision = req.body.accept === true ? 'accepted' : 'declined';
  const { rows } = await run('UPDATE direct_requests SET status=$3 WHERE id=$1 AND recipient_id=$2 AND status=\'pending\' RETURNING *', [requestId, me.id, decision]);
  if (!rows[0]) throw new HttpError(404, 'Message request not found.');
  if (decision === 'accepted') await notify(rows[0].sender_id, 'Message request accepted', 'You can now message each other.', 'dm_accepted');
  res.json({ request: rows[0] });
}));
app.get('/direct/conversations', authenticate, asyncRoute(async (req, res) => {
  const me = user(req);
  const { rows } = await run(
    `SELECT d.id,d.created_at,CASE WHEN d.sender_id=$1 THEN r.id ELSE s.id END other_id,
      CASE WHEN d.sender_id=$1 THEN r.username ELSE s.username END other_username
     FROM direct_requests d JOIN users s ON s.id=d.sender_id JOIN users r ON r.id=d.recipient_id
     WHERE (d.sender_id=$1 OR d.recipient_id=$1) AND d.status='accepted' ORDER BY d.created_at DESC`, [me.id],
  );
  res.json({ conversations: rows });
}));
app.get('/direct/:id/messages', authenticate, asyncRoute(async (req, res) => {
  const me = user(req); const requestId = id(req);
  const access = await run('SELECT 1 FROM direct_requests WHERE id=$1 AND status=\'accepted\' AND (sender_id=$2 OR recipient_id=$2)', [requestId, me.id]);
  if (!access.rows[0]) throw new HttpError(403, 'Accept the message request before opening this conversation.');
  const { rows } = await run(
    `SELECT m.*,u.username sender_name,(SELECT p.body FROM direct_messages p WHERE p.id=m.reply_to) reply_body,
      COALESCE((SELECT json_agg(json_build_object('reaction',r.reaction,'userId',r.user_id)) FROM message_reactions r WHERE r.message_kind='direct' AND r.message_id=m.id),'[]') reactions
     FROM direct_messages m JOIN users u ON u.id=m.sender_id WHERE m.request_id=$1 ORDER BY m.created_at DESC LIMIT 100`, [requestId],
  );
  res.json({ messages: rows.reverse() });
}));
app.post('/direct/:id/messages', authenticate, asyncRoute(async (req, res) => {
  const me = user(req); const requestId = id(req); const body = required(req.body.body, 'Message', 2000);
  const access = await run('SELECT * FROM direct_requests WHERE id=$1 AND status=\'accepted\' AND (sender_id=$2 OR recipient_id=$2)', [requestId, me.id]);
  const conversation = access.rows[0]; if (!conversation) throw new HttpError(403, 'This conversation is not available.');
  const other = conversation.sender_id === me.id ? conversation.recipient_id : conversation.sender_id;
  if (await isBlockedEitherWay(me.id, other)) throw new HttpError(403, 'This conversation is blocked.');
  const recipient = (await run('SELECT username FROM users WHERE id=$1', [other])).rows[0];
  const recipientHandle = `${recipient?.username ?? ''}`;
  const mentionPattern = recipientHandle
    ? new RegExp(`(^|[^A-Za-z0-9_])@${recipientHandle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^A-Za-z0-9_])`, 'i')
    : null;
  const mentionsRecipient = mentionPattern?.test(body) ?? false;
  const replyTo = text(req.body.replyTo, 64) || null;
  if (replyTo && !(await run('SELECT 1 FROM direct_messages WHERE id=$1 AND request_id=$2', [replyTo, requestId])).rows[0]) throw new HttpError(400, 'That reply target is not in this conversation.');
  const clientId = text(req.body.clientMutationId, 80) || null;
  const { rows } = await run(
    `INSERT INTO direct_messages(request_id,sender_id,body,reply_to,client_mutation_id) VALUES($1,$2,$3,$4,$5)
     ON CONFLICT(sender_id,client_mutation_id) WHERE client_mutation_id IS NOT NULL DO NOTHING RETURNING *`,
    [requestId, me.id, body, replyTo, clientId],
  );
  const created = rows.length > 0;
  const message = rows[0] ?? (await run('SELECT * FROM direct_messages WHERE sender_id=$1 AND client_mutation_id=$2', [me.id, clientId])).rows[0];
  if (created) {
    io.to(`user:${other}`).emit('direct:message', { ...message, sender_name: me.username });
    await notify(
      other,
      mentionsRecipient ? `${me.username} mentioned you` : `Message from ${me.username}`,
      body.slice(0, 100),
      mentionsRecipient ? 'mention' : 'direct_message',
    );
  }
  res.status(201).json({ message: { ...message, sender_name: me.username } });
}));

app.post('/direct/:id/messages/:messageId/pin', authenticate, asyncRoute(async (req, res) => {
  const me = user(req); const requestId = id(req); const messageId = id(req, 'messageId');
  const found = await run(
    `SELECT d.id,d.request_id,r.sender_id request_sender,r.recipient_id,d.sender_id
       FROM direct_messages d JOIN direct_requests r ON r.id=d.request_id
      WHERE d.id=$1 AND d.request_id=$2 AND r.status='accepted'`, [messageId, requestId],
  );
  const conversation = found.rows[0];
  if (!conversation || (conversation.request_sender !== me.id && conversation.recipient_id !== me.id)) {
    throw new HttpError(404, 'Message not found.');
  }
  const otherId = conversation.request_sender === me.id ? conversation.recipient_id : conversation.request_sender;
  if (await isBlockedEitherWay(me.id, otherId)) throw new HttpError(403, 'This conversation is blocked.');
  const { rows } = await run('UPDATE direct_messages SET is_pinned=NOT is_pinned WHERE id=$1 RETURNING *', [messageId]);
  const changed = { ...rows[0], sender_name: me.username };
  io.to(`user:${conversation.request_sender}`).emit('direct:message_changed', changed);
  io.to(`user:${conversation.recipient_id}`).emit('direct:message_changed', changed);
  res.json({ message: changed });
}));

app.post('/users/:id/block', authenticate, asyncRoute(async (req, res) => {
  const me = user(req); const target = id(req);
  if (target === me.id) throw new HttpError(400, 'You cannot block yourself.');
  await run('INSERT INTO user_blocks(blocker_id,blocked_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [me.id, target]);
  res.status(201).json({ blocked: true });
}));
app.post('/reports', authenticate, asyncRoute(async (req, res) => {
  const me = user(req); const reported = required(req.body.reportedUserId, 'Reported account', 64);
  if (reported === me.id) throw new HttpError(400, 'You cannot report your own account.');
  const { rows } = await run('INSERT INTO reports(reporter_id,reported_user_id,room_id,reason,details) VALUES($1,$2,$3,$4,$5) RETURNING id,status,created_at', [me.id, reported, text(req.body.roomId, 64) || null, required(req.body.reason, 'Reason', 80), text(req.body.details, 1000)]);
  res.status(201).json({ report: rows[0] });
}));
app.get('/admin/reports', authenticate, asyncRoute(async (req, res) => {
  requireAdmin(req);
  const { rows } = await run(
    `SELECT r.*,reporter.username reporter_name,reported.username reported_name FROM reports r
      JOIN users reporter ON reporter.id=r.reporter_id JOIN users reported ON reported.id=r.reported_user_id
      ORDER BY (r.status='open') DESC,r.created_at DESC LIMIT 200`,
  );
  res.json({ reports: rows });
}));
app.patch('/admin/reports/:id', authenticate, asyncRoute(async (req, res) => {
  requireAdmin(req); const me = user(req); const reportId = id(req);
  const action = ['warned', 'suspended', 'dismissed'].includes(req.body.action) ? req.body.action : '';
  if (!action) throw new HttpError(400, 'Choose warn, suspend or dismiss.');
  const { rows } = await run('UPDATE reports SET status=$2,reviewed_by=$3,reviewed_at=NOW() WHERE id=$1 RETURNING *', [reportId, action, me.id]);
  if (!rows[0]) throw new HttpError(404, 'Report not found.');
  if (action === 'suspended') await run('UPDATE users SET is_suspended=TRUE WHERE id=$1', [rows[0].reported_user_id]);
  if (action === 'warned') await notify(rows[0].reported_user_id, 'Account conduct notice', 'A report about your account was reviewed by staff. Please follow the aLaStudie community guidelines.', 'moderation_warning');
  res.json({ report: rows[0] });
}));

app.get('/notifications', authenticate, asyncRoute(async (req, res) => {
  const me = user(req); const { rows } = await run('SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100', [me.id]);
  res.json({ notifications: rows });
}));
app.patch('/notifications/:id/read', authenticate, asyncRoute(async (req, res) => {
  const me = user(req); await run('UPDATE notifications SET is_read=TRUE WHERE id=$1 AND user_id=$2', [id(req), me.id]);
  res.json({ read: true });
}));

registerRoadmapRoutes(app, pool, authenticate, io);
registerAiRoutes(app, pool, authenticate);

io.use(async (socket, next) => {
  try {
    const token = String(socket.handshake.auth.token ?? '');
    const { rows } = await run('SELECT u.id,u.email,u.username FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>NOW() AND u.is_suspended=FALSE', [digest(token)]);
    if (!rows[0]) return next(new Error('Authentication required.'));
    socket.data.user = rows[0] as User;
    next();
  } catch (error) { next(error as Error); }
});
io.on('connection', (socket: Socket) => {
  const me = socket.data.user as User;
  socket.join(`user:${me.id}`);
  const subscriptions = new Set<string>();
  socket.on('room:subscribe', async ({ roomId }: { roomId: string }) => {
    try {
      await requireRoomMember(roomId, me.id);
      socket.join(`room:${roomId}`); subscriptions.add(roomId);
      const members = await run('SELECT user_id FROM room_members WHERE room_id=$1', [roomId]);
      const statuses = roomPresence.get(roomId) ?? new Map<string, Presence>();
      for (const member of members.rows) if (!statuses.has(member.user_id)) statuses.set(member.user_id, 'offline');
      statuses.set(me.id, 'away'); roomPresence.set(roomId, statuses);
      await setPresence(roomId, me.id, 'away');
      socket.emit('session:update', sessionView(await currentSession(roomId)));
    } catch (error) { socket.emit('app:error', { message: error instanceof Error ? error.message : 'Could not join room.' }); }
  });
  socket.on('room:unsubscribe', async ({ roomId }: { roomId: string }) => {
    socket.leave(`room:${roomId}`); subscriptions.delete(roomId);
    const stillHere = [...(io.sockets.adapter.rooms.get(`room:${roomId}`) ?? [])].some((socketId) => io.sockets.sockets.get(socketId)?.data.user?.id === me.id);
    if (!stillHere) await setPresence(roomId, me.id, 'offline');
  });
  socket.on('presence:update', async ({ roomId, status }: { roomId: string; status: Presence }) => {
    if (!subscriptions.has(roomId) || !['studying', 'break', 'away'].includes(status)) return;
    await setPresence(roomId, me.id, status);
  });
  socket.on('disconnect', async () => {
    for (const roomId of subscriptions) {
      const stillHere = [...(io.sockets.adapter.rooms.get(`room:${roomId}`) ?? [])].some((socketId) => io.sockets.sockets.get(socketId)?.data.user?.id === me.id);
      if (!stillHere) await setPresence(roomId, me.id, 'offline').catch(() => undefined);
    }
  });
});

const advanceSessions = async () => {
  const { rows } = await run("SELECT * FROM study_sessions WHERE status='running' AND phase_started_at IS NOT NULL");
  for (const session of rows) {
    const elapsed = Math.floor((Date.now() - new Date(session.phase_started_at).getTime()) / 1000);
    const left = Number(session.remaining_seconds) - elapsed;
    if (left > 0) continue;
    if (session.phase === 'focus') {
      await closeFocusIntervals(session.id);
      const completedFocus = await run(
        `SELECT user_id,FLOOR(SUM(EXTRACT(EPOCH FROM (ended_at-started_at))))::int focused_seconds
         FROM focus_intervals WHERE session_id=$1 AND cycle=$2 AND ended_at IS NOT NULL
         GROUP BY user_id`, [session.id, session.cycle],
      );
      for (const participant of completedFocus.rows) {
        const focusedSeconds = Number(participant.focused_seconds ?? 0);
        if (focusedSeconds < Math.floor(Number(session.focus_seconds) * 0.8)) continue;
        await run(
          `INSERT INTO user_focus_activities(user_id,activity_key,source,focused_seconds,session_count)
           VALUES($1,$2,'timer',$3,1) ON CONFLICT(user_id,activity_key) DO NOTHING`,
          [participant.user_id, `roomtimer:${session.id}:${session.cycle}:${participant.user_id}`, focusedSeconds],
        );
      }
      await run("UPDATE study_sessions SET phase='break',phase_started_at=NOW(),remaining_seconds=$2 WHERE id=$1 AND status='running'", [session.id, session.break_seconds]);
    } else {
      const cycle = Number(session.cycle) + 1;
      await run("UPDATE study_sessions SET phase='focus',cycle=$2,phase_started_at=NOW(),remaining_seconds=$3 WHERE id=$1 AND status='running'", [session.id, cycle, session.focus_seconds]);
      for (const [memberId, presence] of roomPresence.get(session.room_id) ?? []) if (presence === 'studying') await openFocusInterval(session.id, memberId);
    }
    io.to(`room:${session.room_id}`).emit('session:update', sessionView(await currentSession(session.room_id)));
  }
};

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof HttpError) return res.status(error.status).json({ error: error.message });
  console.error(error);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

const start = async () => {
  const schemaPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../schema.sql');
  const schema = await fs.readFile(schemaPath, 'utf8');
  await pool.query(schema);
  server.listen(port, '0.0.0.0', () => console.info(`aLaStudie local API listening on http://localhost:${port}`));
  setInterval(() => { void advanceSessions().catch((error) => console.error('session timer update failed', error)); }, 1000);
  setInterval(() => { void sendOccurrenceReminders().catch((error) => console.error('occurrence reminder update failed', error)); }, process.env.NODE_ENV === 'test' ? 1000 : 60_000);
};

void start().catch((error) => { console.error('Could not start aLaStudie API:', error); process.exitCode = 1; });
