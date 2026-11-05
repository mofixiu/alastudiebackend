import crypto from 'node:crypto';
import express, { type Request, type RequestHandler, type Response } from 'express';
import type { Pool, QueryResultRow } from 'pg';
import type { Server as SocketServer } from 'socket.io';

type RoadmapUser = {
  id: string;
  email: string;
  username: string;
  profile: Record<string, unknown>;
  is_admin?: boolean;
};
type RoadmapRequest = Request & { user?: RoadmapUser };
type Handler = (req: RoadmapRequest, res: Response) => Promise<unknown>;

class RouteError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const route = (handler: Handler) => (req: Request, res: Response) => {
  void handler(req as RoadmapRequest, res).catch((error: unknown) => {
    if (error instanceof RouteError) return res.status(error.status).json({ error: error.message });
    console.error('roadmap API request failed', error);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });
};
const text = (value: unknown, max = 500) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const required = (value: unknown, label: string, max = 500) => {
  const result = text(value, max);
  if (!result) throw new RouteError(400, `${label} is required.`);
  return result;
};
const safeList = (value: unknown, maxCount: number, maxLength: number) => Array.isArray(value)
  ? [...new Set(value.map((item) => text(item, maxLength)).filter(Boolean))].slice(0, maxCount)
  : [];
const currentUser = (req: RoadmapRequest) => {
  if (!req.user) throw new RouteError(401, 'Sign in to continue.');
  return req.user;
};
const parsedDate = (value: unknown, label: string) => {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new RouteError(400, `Choose a valid ${label}.`);
  return new Date(value).toISOString();
};
const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const normalizePair = (a: string, b: string) => a < b ? [a, b] : [b, a];
const weekStartUtc = (date = new Date()) => {
  const value = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const daysSinceMonday = (value.getUTCDay() + 6) % 7;
  value.setUTCDate(value.getUTCDate() - daysSinceMonday);
  return value;
};
const validIdList = (value: unknown, max = 12) => safeList(value, max, 64).filter((item) => /^[0-9a-f-]{36}$/i.test(item));

export function registerRoadmapRoutes(
  app: express.Express,
  pool: Pool,
  authenticate: RequestHandler,
  io: SocketServer,
) {
  const run = <T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []) => pool.query<T>(sql, params);
  const requireRoomMember = async (roomId: string, userId: string) => {
    const result = await run('SELECT role FROM room_members WHERE room_id=$1 AND user_id=$2', [roomId, userId]);
    if (!result.rows[0]) throw new RouteError(403, 'Join this room to view it.');
    return result.rows[0] as { role: string };
  };
  const ensureNotBlocked = async (a: string, b: string) => {
    const result = await run('SELECT 1 FROM user_blocks WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1)', [a, b]);
    if (result.rowCount) throw new RouteError(403, 'This account is unavailable.');
  };
  const notify = async (userId: string, title: string, body: string, kind: string) => {
    const result = await run('INSERT INTO notifications(user_id,title,body,kind) VALUES($1,$2,$3,$4) RETURNING *', [userId, title, body, kind]);
    io.to(`user:${userId}`).emit('notification:new', result.rows[0]);
  };

  // Weekly plan blocks are private rows owned by the requesting account.
  app.get('/planner/blocks', authenticate, route(async (req, res) => {
    const me = currentUser(req);
    const from = req.query.from ? parsedDate(req.query.from, 'start date') : new Date(Date.now() - 7 * 86_400_000).toISOString();
    const to = req.query.to ? parsedDate(req.query.to, 'end date') : new Date(Date.now() + 14 * 86_400_000).toISOString();
    if (Date.parse(to) <= Date.parse(from)) throw new RouteError(400, 'The planner range must end after it starts.');
    const [blocks, goal, activities] = await Promise.all([
      run('SELECT * FROM planner_blocks WHERE user_id=$1 AND starts_at<$3 AND ends_at>$2 ORDER BY starts_at', [me.id, from, to]),
      run('SELECT sessions_per_week FROM planner_goals WHERE user_id=$1', [me.id]),
      run('SELECT COALESCE(SUM(session_count),0)::int completed FROM user_focus_activities WHERE user_id=$1 AND occurred_at >= date_trunc(\'week\',NOW())', [me.id]),
    ]);
    res.json({
      blocks: blocks.rows,
      goal: Number(goal.rows[0]?.sessions_per_week ?? 3),
      completedThisWeek: Number(activities.rows[0]?.completed ?? 0),
      weekStartsAt: weekStartUtc().toISOString(),
    });
  }));

  app.put('/planner/goal', authenticate, route(async (req, res) => {
    const me = currentUser(req);
    const value = Number.parseInt(String(req.body.sessionsPerWeek), 10);
    if (!Number.isInteger(value) || value < 1 || value > 21) throw new RouteError(400, 'Choose a weekly goal from 1 to 21 sessions.');
    const result = await run(
      `INSERT INTO planner_goals(user_id,sessions_per_week) VALUES($1,$2)
       ON CONFLICT(user_id) DO UPDATE SET sessions_per_week=EXCLUDED.sessions_per_week,updated_at=NOW()
       RETURNING sessions_per_week`, [me.id, value],
    );
    res.json({ sessionsPerWeek: Number(result.rows[0]!.sessions_per_week) });
  }));

  app.post('/planner/blocks', authenticate, route(async (req, res) => {
    const me = currentUser(req);
    const title = required(req.body.title, 'Block title', 90);
    const subject = text(req.body.subject, 60);
    const startsAt = parsedDate(req.body.startsAt, 'start time');
    const endsAt = parsedDate(req.body.endsAt, 'end time');
    if (Date.parse(endsAt) <= Date.parse(startsAt) || Date.parse(endsAt) - Date.parse(startsAt) > 12 * 60 * 60 * 1000) throw new RouteError(400, 'A study block must be between 1 minute and 12 hours.');
    const result = await run(
      `INSERT INTO planner_blocks(user_id,title,subject,starts_at,ends_at,reminder_enabled)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
      [me.id, title, subject, startsAt, endsAt, req.body.reminderEnabled === true],
    );
    res.status(201).json({ block: result.rows[0] });
  }));

  app.patch('/planner/blocks/:id', authenticate, route(async (req, res) => {
    const me = currentUser(req);
    const blockId = text(req.params.id, 64);
    const current = await run('SELECT * FROM planner_blocks WHERE id=$1 AND user_id=$2', [blockId, me.id]);
    if (!current.rows[0]) throw new RouteError(404, 'Study block not found.');
    const old = current.rows[0];
    const title = req.body.title == null ? old.title : required(req.body.title, 'Block title', 90);
    const subject = req.body.subject == null ? old.subject : text(req.body.subject, 60);
    const startsAt = req.body.startsAt == null ? old.starts_at : parsedDate(req.body.startsAt, 'start time');
    const endsAt = req.body.endsAt == null ? old.ends_at : parsedDate(req.body.endsAt, 'end time');
    if (Date.parse(String(endsAt)) <= Date.parse(String(startsAt)) || Date.parse(String(endsAt)) - Date.parse(String(startsAt)) > 12 * 60 * 60 * 1000) throw new RouteError(400, 'A study block must be between 1 minute and 12 hours.');
    const completedAt = req.body.completed === true ? (old.completed_at ?? new Date().toISOString()) : req.body.completed === false ? null : old.completed_at;
    const result = await run(
      `UPDATE planner_blocks SET title=$3,subject=$4,starts_at=$5,ends_at=$6,
       reminder_enabled=$7,completed_at=$8,updated_at=NOW() WHERE id=$1 AND user_id=$2 RETURNING *`,
      [blockId, me.id, title, subject, startsAt, endsAt, req.body.reminderEnabled == null ? old.reminder_enabled : req.body.reminderEnabled === true, completedAt],
    );
    if (!old.completed_at && result.rows[0]!.completed_at) {
      await run(
        `INSERT INTO user_focus_activities(user_id,activity_key,source,focused_seconds,session_count,occurred_at)
         VALUES($1,$2,'planner_block',$3,1,NOW()) ON CONFLICT(user_id,activity_key) DO NOTHING`,
        [me.id, `planner:${blockId}`, Math.max(0, Math.floor((Date.parse(String(endsAt)) - Date.parse(String(startsAt))) / 1000))],
      );
    }
    res.json({ block: result.rows[0] });
  }));

  app.delete('/planner/blocks/:id', authenticate, route(async (req, res) => {
    const me = currentUser(req);
    await run('DELETE FROM planner_blocks WHERE id=$1 AND user_id=$2', [text(req.params.id, 64), me.id]);
    res.json({ deleted: true });
  }));

  // Selective copying accepts the client-local wall-clock result as concrete instants.
  app.post('/planner/blocks/carry-forward', authenticate, route(async (req, res) => {
    const me = currentUser(req);
    const copies = Array.isArray(req.body.copies) ? req.body.copies.slice(0, 21) : [];
    if (!copies.length) throw new RouteError(400, 'Select at least one study block to copy.');
    const created = [];
    for (const copy of copies) {
      if (!copy || typeof copy !== 'object') continue;
      const sourceId = required(copy.blockId, 'Source block', 64);
      const startsAt = parsedDate(copy.startsAt, 'new start time');
      const endsAt = parsedDate(copy.endsAt, 'new end time');
      if (Date.parse(endsAt) <= Date.parse(startsAt) || Date.parse(endsAt) - Date.parse(startsAt) > 12 * 60 * 60 * 1000) throw new RouteError(400, 'A copied study block must be between 1 minute and 12 hours.');
      const result = await run(
        `INSERT INTO planner_blocks(user_id,title,subject,starts_at,ends_at,reminder_enabled,copied_from)
         SELECT user_id,title,subject,$3,$4,reminder_enabled,id FROM planner_blocks WHERE id=$1 AND user_id=$2 RETURNING *`,
        [sourceId, me.id, startsAt, endsAt],
      );
      if (!result.rows[0]) throw new RouteError(404, 'One selected study block was not found.');
      created.push(result.rows[0]);
    }
    res.status(201).json({ blocks: created });
  }));

  // Matching preferences contain only broad, user-selected study windows.
  app.get('/matching/preferences', authenticate, route(async (req, res) => {
    const me = currentUser(req);
    const result = await run('SELECT enabled,subjects,courses,availability FROM matching_preferences WHERE user_id=$1', [me.id]);
    res.json({ preferences: result.rows[0] ?? { enabled: false, subjects: [], courses: [], availability: [] } });
  }));

  app.put('/matching/preferences', authenticate, route(async (req, res) => {
    const me = currentUser(req);
    const availability = safeList(req.body.availability, 7, 20);
    const allowed = new Set(['weekday_morning', 'weekday_afternoon', 'weekday_evening', 'weekend_morning', 'weekend_afternoon', 'weekend_evening']);
    if (availability.some((item) => !allowed.has(item))) throw new RouteError(400, 'Choose broad study windows from the available options.');
    const result = await run(
      `INSERT INTO matching_preferences(user_id,enabled,subjects,courses,availability)
       VALUES($1,$2,$3::jsonb,$4::jsonb,$5::jsonb)
       ON CONFLICT(user_id) DO UPDATE SET enabled=EXCLUDED.enabled,subjects=EXCLUDED.subjects,
        courses=EXCLUDED.courses,availability=EXCLUDED.availability,updated_at=NOW()
       RETURNING enabled,subjects,courses,availability`,
      [me.id, req.body.enabled === true, JSON.stringify(safeList(req.body.subjects, 20, 50)), JSON.stringify(safeList(req.body.courses, 20, 80)), JSON.stringify(availability)],
    );
    res.json({ preferences: result.rows[0] });
  }));

  app.get('/recommendations', authenticate, route(async (req, res) => {
    const me = currentUser(req);
    const own = await run('SELECT enabled,subjects,courses,availability FROM matching_preferences WHERE user_id=$1', [me.id]);
    const prefs = own.rows[0];
    if (!prefs?.enabled) return res.json({ enabled: false, rooms: [], people: [] });
    const subjects = strings(prefs.subjects).map((item) => item.toLocaleLowerCase());
    const courses = strings(prefs.courses).map((item) => item.toLocaleLowerCase());
    const availability = strings(prefs.availability);
    const [rooms, people] = await Promise.all([
      run(
        `SELECT r.id,r.title,r.subject,r.course,r.goal,r.scheduled_at,r.recurrence,r.participant_limit,
          COUNT(m.user_id)::int member_count,u.username host_name
         FROM rooms r JOIN users u ON u.id=r.host_id LEFT JOIN room_members m ON m.room_id=r.id
         WHERE r.status='open' AND r.access_type='public' AND r.host_id<>$1
         GROUP BY r.id,u.username HAVING COUNT(m.user_id)<r.participant_limit ORDER BY r.created_at DESC LIMIT 80`, [me.id],
      ),
      run(
        `SELECT u.id,u.username,u.profile,p.subjects,p.courses,p.availability
         FROM matching_preferences p JOIN users u ON u.id=p.user_id
         WHERE p.enabled=TRUE AND u.id<>$1 AND u.is_verified=TRUE AND u.is_suspended=FALSE
          AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.blocker_id=$1 AND b.blocked_id=u.id) OR (b.blocker_id=u.id AND b.blocked_id=$1))
          AND NOT EXISTS (SELECT 1 FROM friendships f WHERE (f.user_a=LEAST($1::uuid,u.id) AND f.user_b=GREATEST($1::uuid,u.id)))
         ORDER BY u.created_at DESC LIMIT 150`, [me.id],
      ),
    ]);
    const roomMatches = rooms.rows.map((room) => {
      const subjectMatch = subjects.some((value) => String(room.subject).toLocaleLowerCase().includes(value));
      const courseMatch = courses.some((value) => String(room.course).toLocaleLowerCase().includes(value));
      return { ...room, score: Number(subjectMatch) * 3 + Number(courseMatch) * 2, reasons: [subjectMatch ? 'A subject you study' : '', courseMatch ? 'A course you follow' : ''].filter(Boolean) };
    }).filter((room) => room.score > 0).sort((a, b) => b.score - a.score).slice(0, 20);
    const peopleMatches = people.rows.map((person) => {
      const personSubjects = strings(person.subjects);
      const personCourses = strings(person.courses);
      const sharedSubjects = personSubjects.filter((item) => subjects.includes(item.toLocaleLowerCase()));
      const sharedCourses = personCourses.filter((item) => courses.includes(item.toLocaleLowerCase()));
      const sharedTimes = strings(person.availability).some((item) => availability.includes(item));
      const score = sharedSubjects.length * 3 + sharedCourses.length * 2 + Number(sharedTimes);
      const profile = (person.profile ?? {}) as Record<string, unknown>;
      return {
        id: person.id,
        username: person.username,
        displayName: text(profile.displayName, 50) || person.username,
        photoUrl: text(profile.photoUrl, 500),
        sharedSubjects,
        sharedCourses,
        similarStudyWindows: sharedTimes,
        score,
      };
    }).filter((person) => person.score > 0).sort((a, b) => b.score - a.score).slice(0, 20);
    res.json({ enabled: true, rooms: roomMatches, people: peopleMatches });
  }));

  // Friendship requests stay separate from DM request/conversation state.
  app.get('/friends', authenticate, route(async (req, res) => {
    const me = currentUser(req);
    const result = await run(
      `SELECT u.id,u.username,u.profile,f.created_at FROM friendships f
       JOIN users u ON u.id=CASE WHEN f.user_a=$1 THEN f.user_b ELSE f.user_a END
       WHERE f.user_a=$1 OR f.user_b=$1 ORDER BY u.username`, [me.id],
    );
    res.json({ friends: result.rows.map((row) => ({ id: row.id, username: row.username, displayName: text((row.profile as Record<string, unknown> | null)?.displayName, 50) || row.username, photoUrl: text((row.profile as Record<string, unknown> | null)?.photoUrl, 500), createdAt: row.created_at })) });
  }));

  app.get('/friends/requests', authenticate, route(async (req, res) => {
    const me = currentUser(req);
    const result = await run(
      `SELECT r.id,r.sender_id,r.recipient_id,r.status,r.created_at,s.username sender_username,s.profile sender_profile,
       t.username recipient_username,t.profile recipient_profile
       FROM friend_requests r JOIN users s ON s.id=r.sender_id JOIN users t ON t.id=r.recipient_id
       WHERE (r.sender_id=$1 OR r.recipient_id=$1) AND r.status='pending' ORDER BY r.created_at DESC`, [me.id],
    );
    res.json({ requests: result.rows });
  }));

  app.post('/friends/requests', authenticate, route(async (req, res) => {
    const me = currentUser(req);
    const target = await run('SELECT id,username FROM users WHERE lower(username)=lower($1) AND is_verified=TRUE AND is_suspended=FALSE', [required(req.body.username, 'Username', 32).replace(/^@/, '')]);
    if (!target.rows[0]) throw new RouteError(404, 'That student could not be found.');
    const targetId = String(target.rows[0].id);
    if (targetId === me.id) throw new RouteError(400, 'You cannot add yourself as a friend.');
    await ensureNotBlocked(me.id, targetId);
    const [a, b] = normalizePair(me.id, targetId);
    const alreadyFriends = await run('SELECT 1 FROM friendships WHERE user_a=$1 AND user_b=$2', [a, b]);
    if (alreadyFriends.rowCount) return res.json({ status: 'accepted', alreadyFriends: true });
    const existing = await run(
      `INSERT INTO friend_requests(sender_id,recipient_id) VALUES($1,$2)
       ON CONFLICT(sender_id,recipient_id) DO UPDATE SET status='pending',updated_at=NOW()
       WHERE friend_requests.status='declined' RETURNING *`, [me.id, targetId],
    );
    const request = existing.rows[0] ?? (await run('SELECT * FROM friend_requests WHERE sender_id=$1 AND recipient_id=$2', [me.id, targetId])).rows[0];
    if (!request) throw new RouteError(500, 'Could not create the friend request.');
    if (request.status === 'pending' && request.sender_id === me.id) await notify(targetId, 'A study connection request', `@${me.username} would like to connect.`, 'friend_request');
    res.status(201).json({ request });
  }));

  app.patch('/friends/requests/:id', authenticate, route(async (req, res) => {
    const me = currentUser(req);
    const action = req.body.action === 'accept' ? 'accepted' : req.body.action === 'decline' ? 'declined' : '';
    if (!action) throw new RouteError(400, 'Choose accept or decline.');
    const result = await run('UPDATE friend_requests SET status=$3,updated_at=NOW() WHERE id=$1 AND recipient_id=$2 AND status=\'pending\' RETURNING *', [text(req.params.id, 64), me.id, action]);
    if (!result.rows[0]) throw new RouteError(404, 'Friend request not found.');
    if (action === 'accepted') {
      const [a, b] = normalizePair(String(result.rows[0].sender_id), me.id);
      await run('INSERT INTO friendships(user_a,user_b) VALUES($1,$2) ON CONFLICT DO NOTHING', [a, b]);
      await notify(String(result.rows[0].sender_id), 'Study connection accepted', `@${me.username} accepted your request.`, 'friend_accepted');
    }
    res.json({ request: result.rows[0] });
  }));

  app.delete('/friends/:userId', authenticate, route(async (req, res) => {
    const me = currentUser(req);
    const [a, b] = normalizePair(me.id, text(req.params.userId, 64));
    await run('DELETE FROM friendships WHERE user_a=$1 AND user_b=$2', [a, b]);
    res.json({ removed: true });
  }));

  const unlockAchievements = async (userId: string) => {
    const [activity, dates] = await Promise.all([
      run('SELECT COALESCE(SUM(session_count),0)::int sessions,COALESCE(SUM(focused_seconds),0)::int focused_seconds FROM user_focus_activities WHERE user_id=$1', [userId]),
      run('SELECT DISTINCT occurred_at::date study_day FROM user_focus_activities WHERE user_id=$1 AND session_count>0 ORDER BY study_day DESC LIMIT 40', [userId]),
    ]);
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    const days = new Set(dates.rows.map((row) => new Date(row.study_day as Date | string).toISOString().slice(0, 10)));
    let streak = 0;
    for (let offset = 0; offset < 40; offset++) {
      const day = new Date(today); day.setUTCDate(today.getUTCDate() - offset);
      if (!days.has(day.toISOString().slice(0, 10))) {
        if (offset === 0) continue;
        break;
      }
      streak++;
    }
    const metrics = { sessions: Number(activity.rows[0]!.sessions), focused_seconds: Number(activity.rows[0]!.focused_seconds), streak_days: streak };
    const earned = await run('SELECT * FROM achievements ORDER BY threshold,code');
    for (const badge of earned.rows) {
      if (metrics[badge.metric as keyof typeof metrics] >= Number(badge.threshold)) {
        await run('INSERT INTO user_achievements(user_id,achievement_code) VALUES($1,$2) ON CONFLICT DO NOTHING', [userId, badge.code]);
      }
    }
    return metrics;
  };

  app.get('/achievements', authenticate, route(async (req, res) => {
    const me = currentUser(req);
    const metrics = await unlockAchievements(me.id);
    const result = await run(
      `SELECT a.code,a.title,a.description,a.threshold,a.metric,u.unlocked_at
       FROM achievements a LEFT JOIN user_achievements u ON u.achievement_code=a.code AND u.user_id=$1
       ORDER BY (u.unlocked_at IS NOT NULL) DESC,a.threshold`, [me.id],
    );
    res.json({ metrics, achievements: result.rows });
  }));

  app.get('/leaderboard/settings', authenticate, route(async (req, res) => {
    const me = currentUser(req);
    const result = await run('SELECT enabled,display_name FROM leaderboard_settings WHERE user_id=$1', [me.id]);
    res.json({ settings: result.rows[0] ?? { enabled: false, display_name: '' } });
  }));

  app.put('/leaderboard/settings', authenticate, route(async (req, res) => {
    const me = currentUser(req);
    const result = await run(
      `INSERT INTO leaderboard_settings(user_id,enabled,display_name) VALUES($1,$2,$3)
       ON CONFLICT(user_id) DO UPDATE SET enabled=EXCLUDED.enabled,display_name=EXCLUDED.display_name,updated_at=NOW()
       RETURNING enabled,display_name`, [me.id, req.body.enabled === true, text(req.body.displayName, 32) || me.username],
    );
    res.json({ settings: result.rows[0] });
  }));

  app.get('/leaderboard/weekly', authenticate, route(async (_req, res) => {
    const from = weekStartUtc();
    const to = new Date(from); to.setUTCDate(from.getUTCDate() + 7);
    const result = await run(
      `SELECT s.display_name,COALESCE(SUM(a.session_count),0)::int weekly_score
       FROM leaderboard_settings s JOIN user_focus_activities a ON a.user_id=s.user_id
       WHERE s.enabled=TRUE AND a.source='timer' AND a.occurred_at >= $1 AND a.occurred_at < $2
       GROUP BY s.user_id,s.display_name ORDER BY weekly_score DESC,s.display_name LIMIT 100`, [from.toISOString(), to.toISOString()],
    );
    res.json({ weekStartsAt: from.toISOString(), entries: result.rows.map((row, index) => ({ rank: index + 1, displayName: row.display_name, weeklyScore: Number(row.weekly_score) })) });
  }));

  // Room material rows are streamed only after current membership is checked.
  app.get('/rooms/:roomId/materials', authenticate, route(async (req, res) => {
    const me = currentUser(req); const roomId = text(req.params.roomId, 64);
    await requireRoomMember(roomId, me.id);
    const result = await run(
      `SELECT m.id,m.uploader_id,u.username uploader_name,m.title,m.file_name,m.content_type,m.byte_size,m.created_at,
        m.ai_index_status,EXISTS(SELECT 1 FROM ai_file_search_stores s WHERE s.user_id=$1 AND s.material_id=m.id) ai_indexed
       FROM room_materials m JOIN users u ON u.id=m.uploader_id WHERE m.room_id=$2 ORDER BY m.created_at DESC`, [me.id, roomId],
    );
    res.json({ materials: result.rows });
  }));

  app.post('/rooms/:roomId/materials', authenticate, route(async (req, res) => {
    const me = currentUser(req); const roomId = text(req.params.roomId, 64);
    await requireRoomMember(roomId, me.id);
    const title = required(req.body.title, 'File title', 100);
    const fileName = required(req.body.fileName, 'File name', 150).replace(/[\\/\u0000-\u001f]/g, '_');
    const contentType = required(req.body.contentType, 'File type', 100).toLowerCase();
    const allowed = new Set(['application/pdf', 'text/plain', 'text/markdown', 'text/csv', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']);
    if (!allowed.has(contentType)) throw new RouteError(415, 'Share a PDF, text, Markdown, CSV, or DOCX file.');
    const encoded = required(req.body.dataBase64, 'File contents', 11_200_000);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new RouteError(400, 'The file contents are not valid base64.');
    const data = Buffer.from(encoded, 'base64');
    if (!data.length || data.length > 8 * 1024 * 1024) throw new RouteError(413, 'Files must be no larger than 8 MB.');
    const result = await run(
      `INSERT INTO room_materials(room_id,uploader_id,title,file_name,content_type,byte_size,data)
       VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,room_id,uploader_id,title,file_name,content_type,byte_size,created_at,ai_index_status`,
      [roomId, me.id, title, fileName, contentType, data.length, data],
    );
    res.status(201).json({ material: result.rows[0] });
  }));

  app.get('/rooms/:roomId/materials/:materialId/download', authenticate, route(async (req, res) => {
    const me = currentUser(req); const roomId = text(req.params.roomId, 64); const materialId = text(req.params.materialId, 64);
    await requireRoomMember(roomId, me.id);
    const result = await run('SELECT file_name,content_type,data FROM room_materials WHERE id=$1 AND room_id=$2', [materialId, roomId]);
    const material = result.rows[0];
    if (!material) throw new RouteError(404, 'Room file not found.');
    const name = String(material.file_name).replace(/[\\"\r\n]/g, '_');
    res.setHeader('Content-Type', material.content_type);
    res.setHeader('Content-Length', (material.data as Buffer).length);
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.send(material.data);
  }));

  app.delete('/rooms/:roomId/materials/:materialId', authenticate, route(async (req, res) => {
    const me = currentUser(req); const roomId = text(req.params.roomId, 64); const materialId = text(req.params.materialId, 64);
    const role = await requireRoomMember(roomId, me.id);
    const result = await run('DELETE FROM room_materials WHERE id=$1 AND room_id=$2 AND (uploader_id=$3 OR $4=\'host\') RETURNING id', [materialId, roomId, me.id, role.role]);
    if (!result.rowCount) throw new RouteError(404, 'File not found or you cannot remove it.');
    res.json({ deleted: true });
  }));

  app.get('/study-documents', authenticate, route(async (req, res) => {
    const me = currentUser(req);
    const result = await run(
      `SELECT d.id,d.file_name,d.content_type,d.byte_size,d.created_at,
        EXISTS(SELECT 1 FROM ai_personal_document_search_stores s WHERE s.user_id=d.user_id AND s.document_id=d.id) ai_indexed
       FROM personal_study_documents d WHERE d.user_id=$1 ORDER BY d.created_at DESC`,
      [me.id],
    );
    res.json({ documents: result.rows });
  }));

  app.post('/study-documents', authenticate, route(async (req, res) => {
    const me = currentUser(req);
    const fileName = required(req.body.fileName, 'PDF file name', 150)
      .replace(/[\\/\u0000-\u001f]/g, '_');
    if (!fileName.toLowerCase().endsWith('.pdf') ||
        text(req.body.contentType, 100).toLowerCase() !== 'application/pdf') {
      throw new RouteError(415, 'Upload a PDF document.');
    }
    const encoded = required(req.body.dataBase64, 'PDF contents', 11_200_000);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
      throw new RouteError(400, 'The PDF contents are not valid base64.');
    }
    const data = Buffer.from(encoded, 'base64');
    if (!data.length || data.length > 8 * 1024 * 1024) {
      throw new RouteError(413, 'PDFs must be no larger than 8 MB.');
    }
    if (data.subarray(0, 5).toString('ascii') !== '%PDF-') {
      throw new RouteError(415, 'This file does not appear to be a valid PDF.');
    }
    const result = await run(
      `INSERT INTO personal_study_documents(user_id,file_name,content_type,byte_size,data)
       VALUES($1,$2,'application/pdf',$3,$4)
       RETURNING id,file_name,content_type,byte_size,created_at`,
      [me.id, fileName, data.length, data],
    );
    res.status(201).json({ document: result.rows[0] });
  }));

  app.get('/study-documents/:documentId/download', authenticate, route(async (req, res) => {
    const me = currentUser(req);
    const result = await run(
      'SELECT file_name,data FROM personal_study_documents WHERE id=$1 AND user_id=$2',
      [text(req.params.documentId, 64), me.id],
    );
    const document = result.rows[0];
    if (!document) throw new RouteError(404, 'Private study PDF not found.');
    const name = String(document.file_name).replace(/[\\"\r\n]/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', (document.data as Buffer).length);
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.send(document.data);
  }));

  app.delete('/study-documents/:documentId', authenticate, route(async (req, res) => {
    const me = currentUser(req);
    const result = await run(
      'DELETE FROM personal_study_documents WHERE id=$1 AND user_id=$2 RETURNING id',
      [text(req.params.documentId, 64), me.id],
    );
    if (!result.rowCount) throw new RouteError(404, 'Private study PDF not found.');
    res.json({ deleted: true });
  }));

  app.get('/rooms/:roomId/notes', authenticate, route(async (req, res) => {
    const me = currentUser(req); const roomId = text(req.params.roomId, 64);
    await requireRoomMember(roomId, me.id);
    const result = await run('SELECT n.*,u.username author_name FROM room_notes n JOIN users u ON u.id=n.author_id WHERE n.room_id=$1 ORDER BY n.updated_at DESC', [roomId]);
    res.json({ notes: result.rows });
  }));

  app.post('/rooms/:roomId/notes', authenticate, route(async (req, res) => {
    const me = currentUser(req); const roomId = text(req.params.roomId, 64);
    await requireRoomMember(roomId, me.id);
    const result = await run('INSERT INTO room_notes(room_id,author_id,title,body) VALUES($1,$2,$3,$4) RETURNING *', [roomId, me.id, required(req.body.title, 'Note title', 100), text(req.body.body, 20_000)]);
    res.status(201).json({ note: result.rows[0] });
  }));

  app.patch('/rooms/:roomId/notes/:noteId', authenticate, route(async (req, res) => {
    const me = currentUser(req); const roomId = text(req.params.roomId, 64);
    await requireRoomMember(roomId, me.id);
    const version = Number.parseInt(String(req.body.version), 10);
    if (!Number.isInteger(version) || version < 1) throw new RouteError(400, 'Reload this note before editing it.');
    const result = await run('UPDATE room_notes SET title=$4,body=$5,version=version+1,updated_at=NOW() WHERE id=$1 AND room_id=$2 AND version=$3 RETURNING *', [text(req.params.noteId, 64), roomId, version, required(req.body.title, 'Note title', 100), text(req.body.body, 20_000)]);
    if (!result.rows[0]) {
      const exists = await run('SELECT 1 FROM room_notes WHERE id=$1 AND room_id=$2', [text(req.params.noteId, 64), roomId]);
      if (!exists.rowCount) throw new RouteError(404, 'Room note not found.');
      throw new RouteError(409, 'Another member updated this note. Reload it before saving.');
    }
    res.json({ note: result.rows[0] });
  }));

  app.delete('/rooms/:roomId/notes/:noteId', authenticate, route(async (req, res) => {
    const me = currentUser(req); const roomId = text(req.params.roomId, 64);
    const role = await requireRoomMember(roomId, me.id);
    const result = await run('DELETE FROM room_notes WHERE id=$1 AND room_id=$2 AND (author_id=$3 OR $4=\'host\')', [text(req.params.noteId, 64), roomId, me.id, role.role]);
    res.json({ deleted: true, changed: (result.rowCount ?? 0) > 0 });
  }));

  app.get('/rooms/:roomId/whiteboard', authenticate, route(async (req, res) => {
    const me = currentUser(req); const roomId = text(req.params.roomId, 64);
    await requireRoomMember(roomId, me.id);
    const result = await run('SELECT strokes,version,updated_at,updated_by FROM room_whiteboards WHERE room_id=$1', [roomId]);
    res.json({ whiteboard: result.rows[0] ?? { strokes: [], version: 0, updated_at: null } });
  }));

  app.put('/rooms/:roomId/whiteboard', authenticate, route(async (req, res) => {
    const me = currentUser(req); const roomId = text(req.params.roomId, 64);
    await requireRoomMember(roomId, me.id);
    const version = Number.parseInt(String(req.body.version), 10);
    const strokes = Array.isArray(req.body.strokes) ? req.body.strokes.slice(0, 400) : null;
    if (!Number.isInteger(version) || version < 0 || !strokes) throw new RouteError(400, 'Reload the board before saving your drawing.');
    if (JSON.stringify(strokes).length > 1_000_000 || strokes.some((stroke: unknown) => !stroke || typeof stroke !== 'object' || !Array.isArray((stroke as Record<string, unknown>).points) || ((stroke as Record<string, unknown>).points as unknown[]).length > 250)) {
      throw new RouteError(413, 'This whiteboard has reached its drawing limit. Clear a few marks and try again.');
    }
    const existing = await run('SELECT version FROM room_whiteboards WHERE room_id=$1', [roomId]);
    let saved;
    if (!existing.rows[0] && version === 0) {
      saved = await run('INSERT INTO room_whiteboards(room_id,strokes,updated_by) VALUES($1,$2::jsonb,$3) ON CONFLICT(room_id) DO NOTHING RETURNING strokes,version,updated_at,updated_by', [roomId, JSON.stringify(strokes), me.id]);
    } else {
      saved = await run('UPDATE room_whiteboards SET strokes=$3::jsonb,version=version+1,updated_by=$4,updated_at=NOW() WHERE room_id=$1 AND version=$2 RETURNING strokes,version,updated_at,updated_by', [roomId, version, JSON.stringify(strokes), me.id]);
    }
    if (!saved.rows[0]) throw new RouteError(409, 'Another member updated the whiteboard. Reload it before saving.');
    io.to(`room:${roomId}`).emit('whiteboard:update', { roomId, whiteboard: saved.rows[0] });
    res.json({ whiteboard: saved.rows[0] });
  }));

  app.post('/offline/summaries', authenticate, route(async (req, res) => {
    const me = currentUser(req);
    const clientSessionId = required(req.body.clientSessionId, 'Nearby session ID', 100);
    const focusedSeconds = Math.max(0, Math.min(86_400, Number.parseInt(String(req.body.focusedSeconds), 10) || 0));
    const completedCycles = Math.max(0, Math.min(100, Number.parseInt(String(req.body.completedCycles), 10) || 0));
    const endedAt = parsedDate(req.body.endedAt, 'session end time');
    const result = await run(
      `INSERT INTO nearby_summaries(user_id,client_session_id,focused_seconds,completed_cycles,ended_at)
       VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id,client_session_id) DO UPDATE SET
        focused_seconds=GREATEST(nearby_summaries.focused_seconds,EXCLUDED.focused_seconds),
        completed_cycles=GREATEST(nearby_summaries.completed_cycles,EXCLUDED.completed_cycles)
       RETURNING *`, [me.id, clientSessionId, focusedSeconds, completedCycles, endedAt],
    );
    await run(
      `INSERT INTO user_focus_activities(user_id,activity_key,source,focused_seconds,session_count,occurred_at)
       VALUES($1,$2,'nearby',$3,$4,$5) ON CONFLICT(user_id,activity_key) DO UPDATE SET
        focused_seconds=GREATEST(user_focus_activities.focused_seconds,EXCLUDED.focused_seconds),
        session_count=GREATEST(user_focus_activities.session_count,EXCLUDED.session_count)`,
      [me.id, `nearby:${clientSessionId}`, focusedSeconds, completedCycles, endedAt],
    );
    res.status(201).json({ summary: result.rows[0] });
  }));

  // Institution domains are curated by staff. Verification email is independent
  // from login email and never appears in community or leaderboard responses.
  app.post('/communities/school-email/request', authenticate, route(async (req, res) => {
    const me = currentUser(req);
    const email = required(req.body.email, 'School email', 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new RouteError(400, 'Enter a valid school email address.');
    const domain = email.split('@').at(-1)!;
    const institution = await run('SELECT domain,institution_id FROM institution_domains WHERE domain=$1', [domain]);
    if (!institution.rows[0]) throw new RouteError(422, 'This school email domain is not supported yet. Ask a verified member to invite you.');
    const claimed = await run('SELECT user_id FROM user_school_emails WHERE email=$1 AND user_id<>$2', [email, me.id]);
    if (claimed.rowCount) throw new RouteError(409, 'That school email is already connected to another account.');
    const token = crypto.randomBytes(24).toString('base64url');
    await run('INSERT INTO email_tokens(user_id,token_hash,purpose,target_email,expires_at) VALUES($1,$2,\'school_verify\',$3,NOW()+INTERVAL \'30 minutes\')', [me.id, crypto.createHash('sha256').update(token).digest('hex'), email]);
    if (process.env.LOCAL_MAILBOX_ENABLED !== 'false') {
      await run('INSERT INTO local_mailbox(recipient,subject,body) VALUES($1,$2,$3)', [email, 'Verify your aLaStudie school email', `Your local development code is:\n${token}\n\nThis code expires in 30 minutes.`]);
    }
    res.status(202).json({ sent: true, email, delivery: process.env.LOCAL_MAILBOX_ENABLED === 'false' ? 'external mail provider required' : 'local mailbox' });
  }));

  app.post('/communities/school-email/verify', authenticate, route(async (req, res) => {
    const me = currentUser(req);
    const email = required(req.body.email, 'School email', 254).toLowerCase();
    const code = required(req.body.code, 'Verification code', 120);
    const hash = crypto.createHash('sha256').update(code).digest('hex');
    const token = await run(
      `SELECT t.id,d.domain,d.institution_id,i.name FROM email_tokens t
       JOIN institution_domains d ON d.domain=split_part(t.target_email,'@',2)
       JOIN institutions i ON i.id=d.institution_id
       WHERE t.user_id=$1 AND t.target_email=$2 AND t.purpose='school_verify' AND t.token_hash=$3
        AND t.consumed_at IS NULL AND t.expires_at>NOW() ORDER BY t.expires_at DESC LIMIT 1`, [me.id, email, hash],
    );
    if (!token.rows[0]) throw new RouteError(400, 'That school verification code is invalid or expired.');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE email_tokens SET consumed_at=NOW() WHERE id=$1', [token.rows[0].id]);
      await client.query(
        `INSERT INTO user_school_emails(user_id,email,domain,institution_id) VALUES($1,$2,$3,$4)
         ON CONFLICT(user_id) DO UPDATE SET email=EXCLUDED.email,domain=EXCLUDED.domain,institution_id=EXCLUDED.institution_id,verified_at=NOW()`,
        [me.id, email, token.rows[0].domain, token.rows[0].institution_id],
      );
      await client.query('INSERT INTO communities(institution_id,name) VALUES($1,$2) ON CONFLICT(institution_id) DO NOTHING', [token.rows[0].institution_id, token.rows[0].name]);
      await client.query(
        `INSERT INTO community_members(community_id,user_id,verification_method)
         SELECT id,$1,'school_email' FROM communities WHERE institution_id=$2 ON CONFLICT(community_id,user_id) DO UPDATE SET verification_method='school_email',invited_by=NULL`,
        [me.id, token.rows[0].institution_id],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
    res.json({ verified: true, institution: token.rows[0].name });
  }));

  app.get('/communities', authenticate, route(async (req, res) => {
    const me = currentUser(req);
    const result = await run(
      `SELECT c.id,c.name,i.name institution_name,COUNT(DISTINCT m.user_id)::int member_count,
        mine.verification_method,myinvite.id invite_id
       FROM communities c JOIN institutions i ON i.id=c.institution_id
       LEFT JOIN community_members m ON m.community_id=c.id
       LEFT JOIN community_members mine ON mine.community_id=c.id AND mine.user_id=$1
       LEFT JOIN community_invites myinvite ON myinvite.community_id=c.id AND myinvite.invited_user_id=$1 AND myinvite.accepted_at IS NULL
       GROUP BY c.id,i.name,mine.verification_method,myinvite.id ORDER BY i.name`, [me.id],
    );
    res.json({ communities: result.rows });
  }));

  app.post('/communities/:id/join', authenticate, route(async (req, res) => {
    const me = currentUser(req); const communityId = text(req.params.id, 64);
    const community = await run('SELECT institution_id FROM communities WHERE id=$1', [communityId]);
    if (!community.rows[0]) throw new RouteError(404, 'Community not found.');
    const verified = await run('SELECT 1 FROM user_school_emails WHERE user_id=$1 AND institution_id=$2', [me.id, community.rows[0].institution_id]);
    let method = 'school_email'; let invitedBy: string | null = null;
    if (!verified.rowCount) {
      const invite = await run('SELECT id,invited_by FROM community_invites WHERE community_id=$1 AND invited_user_id=$2 AND accepted_at IS NULL', [communityId, me.id]);
      if (!invite.rows[0]) throw new RouteError(403, 'Verify a school email or use an invite from a verified member.');
      method = 'member_invite'; invitedBy = String(invite.rows[0].invited_by);
      await run('UPDATE community_invites SET accepted_at=NOW() WHERE id=$1', [invite.rows[0].id]);
    }
    await run('INSERT INTO community_members(community_id,user_id,verification_method,invited_by) VALUES($1,$2,$3,$4) ON CONFLICT(community_id,user_id) DO NOTHING', [communityId, me.id, method, invitedBy]);
    res.status(201).json({ joined: true, verificationMethod: method });
  }));

  app.post('/communities/:id/invites', authenticate, route(async (req, res) => {
    const me = currentUser(req); const communityId = text(req.params.id, 64);
    const verifiedMember = await run(
      `SELECT 1 FROM community_members m JOIN user_school_emails e ON e.user_id=m.user_id AND e.institution_id=(SELECT institution_id FROM communities WHERE id=$1)
       WHERE m.community_id=$1 AND m.user_id=$2`, [communityId, me.id],
    );
    if (!verifiedMember.rowCount) throw new RouteError(403, 'Only a school-email-verified member can invite students.');
    const target = await run('SELECT id,username FROM users WHERE lower(username)=lower($1) AND is_verified=TRUE AND is_suspended=FALSE', [required(req.body.username, 'Username', 32).replace(/^@/, '')]);
    if (!target.rows[0]) throw new RouteError(404, 'That student could not be found.');
    if (String(target.rows[0].id) === me.id) throw new RouteError(400, 'You are already a member.');
    const result = await run(
      `INSERT INTO community_invites(community_id,invited_user_id,invited_by) VALUES($1,$2,$3)
       ON CONFLICT(community_id,invited_user_id) DO UPDATE SET invited_by=EXCLUDED.invited_by,accepted_at=NULL RETURNING *`, [communityId, target.rows[0].id, me.id],
    );
    await notify(String(target.rows[0].id), 'University community invitation', `@${me.username} invited you to join a study community.`, 'community_invite');
    res.status(201).json({ invite: result.rows[0] });
  }));

  app.post('/admin/institutions', authenticate, route(async (req, res) => {
    const me = currentUser(req);
    if (!me.is_admin) throw new RouteError(403, 'Staff access is required.');
    const name = required(req.body.name, 'Institution name', 120);
    const domain = required(req.body.domain, 'School email domain', 180).toLowerCase().replace(/^@/, '');
    if (domain.includes('@') || domain.includes('/') || !domain.includes('.')) throw new RouteError(400, 'Enter a domain such as university.edu.');
    const client = await pool.connect();
    let institution;
    try {
      await client.query('BEGIN');
      institution = await client.query('INSERT INTO institutions(name) VALUES($1) ON CONFLICT(name) DO UPDATE SET name=EXCLUDED.name RETURNING *', [name]);
      await client.query('INSERT INTO institution_domains(domain,institution_id,added_by) VALUES($1,$2,$3) ON CONFLICT(domain) DO UPDATE SET institution_id=EXCLUDED.institution_id,added_by=EXCLUDED.added_by', [domain, institution.rows[0].id, me.id]);
      await client.query('INSERT INTO communities(institution_id,name) VALUES($1,$2) ON CONFLICT(institution_id) DO NOTHING', [institution.rows[0].id, name]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    res.status(201).json({ institution: institution!.rows[0], domain });
  }));
}
