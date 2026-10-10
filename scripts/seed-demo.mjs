import crypto from 'node:crypto';
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://localhost:5433/alastudie',
});
const demoPassword = process.env.DEMO_PASSWORD ?? 'DemoStudy8!';
const people = [
  { username: 'nia_demo', name: 'Nia', school: 'Lagos State University', subjects: 'Computer science, statistics' },
  { username: 'tobi_demo', name: 'Tobi', school: 'University of Lagos', subjects: 'Chemistry, biology' },
  { username: 'zara_demo', name: 'Zara', school: 'University of Ibadan', subjects: 'Mathematics, economics' },
  { username: 'ade_demo', name: 'Ade', school: 'Covenant University', subjects: 'Design, computer science' },
  { username: 'maya_demo', name: 'Maya', school: 'Pan-Atlantic University', subjects: 'Law, history' },
  { username: 'sam_demo', name: 'Sam', school: 'University of Nigeria', subjects: 'Physics, engineering' },
];
const roomData = [
  { title: 'CSC 401 · operating systems', subject: 'Computer science', course: 'CSC 401', goal: 'Work through process scheduling, one question at a time.', access: 'public', host: 0, members: [0, 1, 3, 5], schedule: null, repeat: 'none' },
  { title: 'Organic chemistry, quiet hour', subject: 'Chemistry', course: 'CHM 211', goal: 'Review reaction mechanisms and make a clean summary sheet.', access: 'public', host: 1, members: [1, 0, 2], schedule: '3 hours', repeat: 'weekly' },
  { title: 'Calculus problem set', subject: 'Mathematics', course: 'MTH 202', goal: 'Solve six integration problems together.', access: 'public', host: 2, members: [2, 3, 4], schedule: '1 day', repeat: 'none' },
  { title: 'Sunday library table', subject: 'Study hall', course: 'Open study', goal: 'Bring one goal and a quiet playlist.', access: 'public', host: 3, members: [3, 0, 4, 5], schedule: '2 days', repeat: 'weekly' },
  { title: 'Early birds · exam prep', subject: 'Exam prep', course: 'Finals week', goal: 'Start with the hardest topic before the day gets loud.', access: 'public', host: 4, members: [4, 1, 5], schedule: '12 hours', repeat: 'daily' },
  { title: 'Mobile dev focus table', subject: 'Software engineering', course: 'Project work', goal: 'Ship one small screen and review each other’s code.', access: 'link', host: 5, members: [5, 0, 2], schedule: null, repeat: 'none', code: 'STUDY777' },
  { title: 'Law reading group', subject: 'Law', course: 'Constitutional law', goal: 'Read the assigned cases and compare notes.', access: 'invite', host: 4, members: [4, 2, 3], schedule: '1 day', repeat: 'none' },
  { title: 'Drop-in study hall', subject: 'General study', course: 'Bring your own subject', goal: 'Settle in for one focused block and say hello.', access: 'public', host: 0, members: [0, 1, 2, 3, 4, 5], schedule: null, repeat: 'none' },
];
const uuid = (kind, index) => `${kind}-0000-4000-8000-${String(index).padStart(12, '0')}`;
const passwordHash = () => {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = crypto.scryptSync(demoPassword, salt, 64);
  return `${salt}:${key.toString('hex')}`;
};

try {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const userIds = [];
    for (const person of people) {
      const email = `${person.username.replace('_demo', '')}@demo.alastudie.test`;
      const profile = {
        demoAccount: true,
        displayName: person.name,
        school: person.school,
        subjects: person.subjects,
        visibility: 'public',
        allowMessageRequests: true,
      };
      const result = await client.query(
        `INSERT INTO users(email,username,password_hash,is_verified,profile)
         VALUES($1,$2,$3,TRUE,$4::jsonb)
         ON CONFLICT(email) DO UPDATE SET username=EXCLUDED.username,
           password_hash=EXCLUDED.password_hash,is_verified=TRUE,profile=EXCLUDED.profile
         RETURNING id`,
        [email, person.username, passwordHash(), JSON.stringify(profile)],
      );
      userIds.push(result.rows[0].id);
    }

    const roomIds = [];
    for (let index = 0; index < roomData.length; index++) {
      const room = roomData[index];
      const id = uuid('91000000', index + 1);
      const result = await client.query(
        `INSERT INTO rooms(id,host_id,title,subject,course,goal,access_type,access_code,participant_limit,scheduled_at,recurrence,status)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,
           CASE WHEN $10::text IS NULL THEN NULL ELSE NOW()+$10::interval END,$11,'open')
         ON CONFLICT(id) DO UPDATE SET host_id=EXCLUDED.host_id,title=EXCLUDED.title,
           subject=EXCLUDED.subject,course=EXCLUDED.course,goal=EXCLUDED.goal,
           access_type=EXCLUDED.access_type,access_code=EXCLUDED.access_code,
           participant_limit=EXCLUDED.participant_limit,scheduled_at=EXCLUDED.scheduled_at,
           recurrence=EXCLUDED.recurrence,status='open'
         RETURNING id`,
        [id, userIds[room.host], room.title, room.subject, room.course, room.goal, room.access, room.code ?? null, 10, room.schedule, room.repeat],
      );
      roomIds.push(result.rows[0].id);
      for (const memberIndex of room.members) {
        await client.query(
          `INSERT INTO room_members(room_id,user_id,role) VALUES($1,$2,$3)
           ON CONFLICT(room_id,user_id) DO UPDATE SET role=EXCLUDED.role`,
          [roomIds[index], userIds[memberIndex], memberIndex === room.host ? 'host' : 'member'],
        );
      }
      for (const [taskIndex, title] of [
        'Read the lecture notes',
        'Write down three questions',
        'Take a short break after this block',
      ].entries()) {
        const taskId = uuid('92000000', index * 10 + taskIndex + 1);
        const task = await client.query(
          `INSERT INTO tasks(id,room_id,owner_id,title,is_personal) VALUES($1,$2,$3,$4,FALSE)
           ON CONFLICT(id) DO UPDATE SET title=EXCLUDED.title RETURNING id`,
          [taskId, roomIds[index], userIds[room.host], title],
        );
        for (const memberIndex of room.members) {
          const done = taskIndex === 0 && memberIndex % 2 === 0;
          await client.query(
            `INSERT INTO task_completions(task_id,user_id,completed_at) VALUES($1,$2,$3)
             ON CONFLICT(task_id,user_id) DO UPDATE SET completed_at=EXCLUDED.completed_at`,
            [task.rows[0].id, userIds[memberIndex], done ? new Date(Date.now() - 3_600_000).toISOString() : null],
          );
        }
      }
      if (room.members.length > 1) {
        const messageId = uuid('93000000', index + 1);
        await client.query(
          `INSERT INTO room_messages(id,room_id,sender_id,body,created_at)
           VALUES($1,$2,$3,$4,NOW()-INTERVAL '20 minutes')
           ON CONFLICT(id) DO UPDATE SET body=EXCLUDED.body`,
          [messageId, roomIds[index], userIds[room.members[0]], `I’m in. Let’s start with: ${room.goal}`],
        );
      }
    }

    for (let index = 0; index < people.length; index++) {
      const accountId = userIds[index];
      const taskId = uuid('94000000', index + 1);
      await client.query(
        `INSERT INTO tasks(id,owner_id,title,is_personal) VALUES($1,$2,$3,TRUE)
         ON CONFLICT(id) DO UPDATE SET title=EXCLUDED.title`,
        [taskId, accountId, ['Review today’s lecture', 'Finish the reading notes', 'Practice five questions'][index % 3]],
      );
      await client.query(
        `INSERT INTO task_completions(task_id,user_id,completed_at) VALUES($1,$2,$3)
         ON CONFLICT(task_id,user_id) DO UPDATE SET completed_at=EXCLUDED.completed_at`,
        [taskId, accountId, index % 2 === 0 ? new Date(Date.now() - 86_400_000).toISOString() : null],
      );

      const sessionId = uuid('95000000', index + 1);
      const roomIndex = roomData.findIndex((entry) => entry.members.includes(index));
      const roomId = roomIds[roomIndex];
      const room = roomData[roomIndex];
      const started = `NOW()-INTERVAL '${index % 3 + 1} days'`;
      const session = await client.query(
        `INSERT INTO study_sessions(id,room_id,host_id,preset,focus_seconds,break_seconds,phase,status,remaining_seconds,started_at,finished_at)
         VALUES($1,$2,$3,'classic',1500,300,'finished','finished',0,${started},${started}+INTERVAL '30 minutes')
         ON CONFLICT(id) DO UPDATE SET status='finished',phase='finished' RETURNING id,started_at,finished_at`,
        [sessionId, roomId, userIds[room.host]],
      );
      await client.query(
        `INSERT INTO session_participants(session_id,user_id,focused_seconds)
         VALUES($1,$2,1800) ON CONFLICT(session_id,user_id) DO UPDATE SET focused_seconds=1800`,
        [session.rows[0].id, accountId],
      );
      await client.query(
        `INSERT INTO focus_intervals(session_id,user_id,started_at,ended_at)
         SELECT $1,$2,$3,$4 WHERE NOT EXISTS(
           SELECT 1 FROM focus_intervals WHERE session_id=$1 AND user_id=$2
         )`,
        [session.rows[0].id, accountId, session.rows[0].started_at, session.rows[0].finished_at],
      );
    }
    await client.query('COMMIT');
    console.log(`Seeded ${people.length} demo accounts and ${roomData.length} rooms.`);
    console.log(`Shared local demo password: ${demoPassword}`);
    console.log('Demo emails use the pattern <first-name>@demo.alastudie.test.');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}
