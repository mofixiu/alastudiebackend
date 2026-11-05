import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { Pool } from 'pg';
import WebSocket from 'ws';

const databaseUrl = process.env.TEST_DATABASE_URL;
const skippedReason = databaseUrl
  ? undefined
  : 'Set TEST_DATABASE_URL to a disposable PostgreSQL database whose name includes "test".';

test('local API covers the agreed aLaStudie MVP flows', { skip: skippedReason }, async (t) => {
  const parsedDatabaseUrl = new URL(databaseUrl);
  const databaseName = decodeURIComponent(parsedDatabaseUrl.pathname.slice(1));
  assert.match(databaseName, /test/i, 'refusing to run integration tests outside a test database');

  const port = await availablePort();
  const suffix = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  const adminEmail = `staff_${suffix}@example.test`;
  const baseUrl = `http://127.0.0.1:${port}`;
  const geminiRequests = [];
  let mockStoreSequence = 0;
  const geminiMock = createHttpServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    let payload = {};
    try { payload = raw.startsWith('{') ? JSON.parse(raw) : {}; } catch {}
    geminiRequests.push({ method: req.method, url: req.url, payload, raw });
    res.setHeader('Content-Type', 'application/json');
    if (req.url?.includes('uploadToFileSearchStore') && req.headers['x-goog-upload-command'] === 'start') {
      res.setHeader('x-goog-upload-url', `http://127.0.0.1:${geminiMock.address().port}/upload-finalize`);
      res.end('{}');
    } else if (req.url === '/upload-finalize') {
      res.end(JSON.stringify({ done: true, response: { documentName: 'fileSearchStores/mock/documents/demo' } }));
    } else if (req.url?.includes('/fileSearchStores') && req.method === 'POST') {
      mockStoreSequence += 1;
      res.end(JSON.stringify({ name: `fileSearchStores/test-private-store-${mockStoreSequence}` }));
    } else if (req.url?.includes(':generateContent')) {
      const prompt = payload.contents?.[0]?.parts?.[0]?.text ?? '';
      if (prompt.includes('force-provider-error')) {
        res.statusCode = 503;
        res.end(JSON.stringify({ error: { message: 'Mock provider failure' } }));
      } else {
        const answer = prompt.includes('Return only valid JSON with shape')
          ? JSON.stringify({ blocks: [{ title: 'Mock revision', subject: 'Biology', startsAt: new Date(Date.now() + 86_400_000).toISOString(), endsAt: new Date(Date.now() + 87_000_000).toISOString() }] })
          : 'Mocked study response.';
        res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: answer }] }, groundingMetadata: { groundingChunks: [{ retrievedContext: { title: 'Selected file', uri: 'fileSearchStores/mock/documents/demo' } }] } }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 8 } }));
      }
    } else {
      res.end('{}');
    }
  });
  geminiMock.listen(0, '127.0.0.1');
  await once(geminiMock, 'listening');
  t.after(() => geminiMock.close());
  const apiProcess = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      PORT: String(port),
      NODE_ENV: 'test',
      LOCAL_MAILBOX_ENABLED: 'true',
      ADMIN_EMAILS: adminEmail,
      GEMINI_API_KEY: 'integration-test-only',
      GEMINI_API_BASE_URL: `http://127.0.0.1:${geminiMock.address().port}`,
      GEMINI_CREDITS_CONFIRMED: 'true',
      GEMINI_SPEND_CAP_CONFIGURED: 'true',
      GEMINI_BUDGET_USD: '40',
      GEMINI_BUDGET_RESERVE_USD: '2',
      GEMINI_INPUT_USD_PER_MILLION: '0.1',
      GEMINI_OUTPUT_USD_PER_MILLION: '0.4',
      GEMINI_EMBEDDING_USD_PER_MILLION: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOutput = '';
  apiProcess.stdout.setEncoding('utf8').on('data', (chunk) => { serverOutput += chunk; });
  apiProcess.stderr.setEncoding('utf8').on('data', (chunk) => { serverOutput += chunk; });
  t.after(async () => {
    apiProcess.kill('SIGTERM');
    await Promise.race([once(apiProcess, 'exit'), delay(3000)]);
    if (apiProcess.exitCode === null) apiProcess.kill('SIGKILL');
  });

  const db = new Pool({ connectionString: databaseUrl });
  t.after(() => db.end());
  await waitForHealth(baseUrl, apiProcess, () => serverOutput);

  const call = async (account, method, path, body) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(account?.token ? { Authorization: `Bearer ${account.token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json();
    return { status: response.status, data };
  };
  const expectStatus = (result, status) => {
    assert.equal(result.status, status, `expected HTTP ${status}, got ${result.status}: ${JSON.stringify(result.data)}`);
    return result.data;
  };
  const mailboxCode = async (email, purpose) => {
    const result = expectStatus(await call(null, 'GET', `/dev/mailbox?email=${encodeURIComponent(email)}`), 200);
    const matching = result.messages.find((message) => message.subject.includes(purpose));
    assert.ok(matching, `missing local mailbox ${purpose} message for ${email}`);
    const code = matching.body.match(/code is:\s*([A-Za-z0-9_-]+)/i)?.[1];
    assert.ok(code, `could not read local mailbox code for ${email}`);
    return code;
  };
  const register = async (tag, email = `${tag}_${suffix}@example.test`) => {
    const username = `study_${tag}_${suffix}`;
    expectStatus(await call(null, 'POST', '/auth/register', {
      email, username, password: 'student-pass-8', ageConfirmed: true,
    }), 201);
    expectStatus(await call(null, 'POST', '/auth/verify', {
      email, code: await mailboxCode(email, 'Verify'),
    }), 200);
    const login = expectStatus(await call(null, 'POST', '/auth/login', {
      email, password: 'student-pass-8',
    }), 200);
    return { id: login.user.id, email, username, token: login.token };
  };
  const room = async (host, accessType, title, participantLimit = 8) => {
    const result = expectStatus(await call(host, 'POST', '/rooms', {
      title, subject: 'Computer science', course: 'CSC test', goal: 'Finish a practice set',
      accessType, participantLimit,
    }), 201);
    return { ...result.room, accessCode: result.accessCode };
  };
  const notificationCount = async (account, kind) => {
    const data = expectStatus(await call(account, 'GET', '/notifications'), 200);
    return data.notifications.filter((notification) => notification.kind === kind).length;
  };

  expectStatus(await call(null, 'GET', '/health'), 200);
  const plannerOptions = await fetch(`${baseUrl}/planner/goal`, { method: 'OPTIONS' });
  assert.equal(plannerOptions.status, 204);
  assert.match(plannerOptions.headers.get('access-control-allow-methods'), /PUT/);
  expectStatus(await call(null, 'GET', '/me'), 401);
  expectStatus(await call(null, 'POST', '/auth/register', {
    email: `short_${suffix}@example.test`, username: `short_${suffix}`,
    password: 'short12', ageConfirmed: true,
  }), 400);
  expectStatus(await call(null, 'POST', '/auth/register', {
    email: `age_${suffix}@example.test`, username: `age_${suffix}`,
    password: 'eight888', ageConfirmed: false,
  }), 400);

  const host = await register('host');
  const member = await register('member');
  const invitee = await register('invitee');
  const admin = await register('staff', adminEmail);
  const recovery = await register('recovery');

  const usernameLogin = expectStatus(await call(null, 'POST', '/auth/login', {
    identifier: host.username.toUpperCase(), password: 'student-pass-8',
  }), 200);
  assert.equal(usernameLogin.user.id, host.id);
  const emailIdentifierLogin = expectStatus(await call(null, 'POST', '/auth/login', {
    identifier: host.email.toUpperCase(), password: 'student-pass-8',
  }), 200);
  assert.equal(emailIdentifierLogin.user.id, host.id);

  // Email recovery accepts eight-character passwords and invalidates old sessions.
  expectStatus(await call(null, 'POST', '/auth/forgot-password', { email: recovery.email }), 200);
  const resetCode = await mailboxCode(recovery.email, 'Reset');
  expectStatus(await call(null, 'POST', '/auth/reset-password', {
    email: recovery.email, code: resetCode, password: 'new-pass-8',
  }), 200);
  expectStatus(await call(recovery, 'GET', '/me'), 401);
  const recoveredLogin = expectStatus(await call(null, 'POST', '/auth/login', {
    email: recovery.email, password: 'new-pass-8',
  }), 200);
  recovery.token = recoveredLogin.token;
  expectStatus(await call(recovery, 'GET', '/me'), 200);

  // Profile visibility is private by default, and public fields are searchable after opt-in.
  expectStatus(await call(invitee, 'PATCH', '/me/profile', {
    displayName: 'Study Buddy', school: 'North Campus', subjects: ['Biology'], visibility: 'public',
  }), 200);
  let search = expectStatus(await call(host, 'GET', `/users/search?q=${encodeURIComponent(invitee.username)}`), 200);
  assert.equal(search.users.some((student) => student.id === invitee.id), true);
  expectStatus(await call(member, 'PATCH', '/me/profile', {
    displayName: 'Private Student', school: 'Private Campus', visibility: 'private',
  }), 200);
  search = expectStatus(await call(host, 'GET', `/users/search?q=${encodeURIComponent(member.username)}`), 200);
  assert.equal(search.users.some((student) => student.id === member.id), false);

  // Room access paths: public discovery, link code, and direct invite.
  const publicRoom = await room(host, 'public', 'Public practice room');
  const publicShare = await fetch(`${baseUrl}/share/rooms/${publicRoom.id}`);
  assert.equal(publicShare.status, 200);
  assert.match(publicShare.headers.get('content-type'), /text\/html/);
  assert.match(await publicShare.text(), /Public practice room/);
  const linkRoom = await room(host, 'link', 'Code-only room');
  const inviteRoom = await room(host, 'invite', 'Invite-only room');
  assert.equal((await fetch(`${baseUrl}/share/rooms/${linkRoom.id}`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/share/rooms/${inviteRoom.id}`)).status, 404);
  assert.ok(linkRoom.accessCode);
  expectStatus(await call(member, 'POST', `/rooms/${publicRoom.id}/join`, {}), 201);
  const discovery = expectStatus(await call(member, 'GET', '/rooms'), 200);
  assert.equal(discovery.rooms.some((item) => item.id === publicRoom.id), true);
  assert.equal(discovery.rooms.some((item) => item.id === linkRoom.id), false);
  assert.equal(discovery.rooms.some((item) => item.id === inviteRoom.id), false);
  const filteredRooms = expectStatus(await call(member, 'GET', '/rooms?subject=Computer%20science&course=CSC%20test&availableSeats=5'), 200);
  assert.equal(filteredRooms.rooms.some((item) => item.id === publicRoom.id), true);
  const tooFewSeats = expectStatus(await call(member, 'GET', '/rooms?availableSeats=9'), 200);
  assert.equal(tooFewSeats.rooms.some((item) => item.id === publicRoom.id), false);
  expectStatus(await call(member, 'POST', `/rooms/${linkRoom.id}/join`, {}), 403);
  expectStatus(await call(member, 'POST', '/rooms/join-by-code', { accessCode: linkRoom.accessCode }), 201);
  expectStatus(await call(member, 'POST', `/rooms/${inviteRoom.id}/join`, {}), 403);
  expectStatus(await call(host, 'POST', `/rooms/${inviteRoom.id}/invitations`, { username: invitee.username }), 201);
  const invitations = expectStatus(await call(invitee, 'GET', '/rooms/invitations'), 200);
  assert.equal(invitations.invitations.some((item) => item.room_id === inviteRoom.id), true);
  expectStatus(await call(invitee, 'POST', `/rooms/${inviteRoom.id}/join`, {}), 201);

  // A scheduled room is discoverable with its schedule and cannot start early.
  const scheduledAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const scheduledRoom = expectStatus(await call(host, 'POST', '/rooms', {
    title: 'Weekly study table', subject: 'Biology', goal: 'Review cell structure',
    accessType: 'public', participantLimit: 8, scheduledAt, recurrence: 'none',
  }), 201).room;
  assert.equal(scheduledRoom.recurrence, 'none');
  assert.ok(Math.abs(new Date(scheduledRoom.scheduled_at).getTime() - Date.parse(scheduledAt)) < 1000);
  const scheduledDiscovery = expectStatus(await call(member, 'GET', '/rooms'), 200);
  const scheduledListing = scheduledDiscovery.rooms.find((item) => item.id === scheduledRoom.id);
  assert.equal(scheduledListing.recurrence, 'none');
  const matchingSchedule = expectStatus(await call(member, 'GET', `/rooms?startAfter=${encodeURIComponent(new Date(Date.now() + 20 * 60 * 1000).toISOString())}&startBefore=${encodeURIComponent(new Date(Date.now() + 90 * 60 * 1000).toISOString())}`), 200);
  assert.equal(matchingSchedule.rooms.some((item) => item.id === scheduledRoom.id), true);
  expectStatus(await call(member, 'GET', '/rooms?startAfter=not-a-date'), 400);
  expectStatus(await call(host, 'POST', `/rooms/${scheduledRoom.id}/sessions`, { preset: 'classic' }), 409);
  const weeklyRoom = expectStatus(await call(host, 'POST', '/rooms', {
    title: 'Weekly study table', subject: 'Biology', goal: 'Review cell structure',
    accessType: 'public', participantLimit: 8,
    scheduledAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(), recurrence: 'weekly',
  }), 201).room;
  assert.equal(weeklyRoom.recurrence, 'weekly');

  // Calendar materializes independent recurring occurrences, RSVPs, reminders and attendance.
  const calendar = expectStatus(await call(member, 'GET', '/calendar'), 200);
  const weeklyOccurrences = calendar.occurrences.filter((item) => item.room_id === weeklyRoom.id);
  assert.ok(weeklyOccurrences.length >= 8);
  assert.notEqual(weeklyOccurrences[0].id, weeklyOccurrences[1].id);
  expectStatus(await call(member, 'POST', `/calendar/occurrences/${weeklyOccurrences[0].id}/rsvp`, {
    status: 'going', reminderEnabled: true,
  }), 200);
  let memberCalendar = expectStatus(await call(member, 'GET', '/calendar'), 200);
  const updatedWeekly = memberCalendar.occurrences.find((item) => item.id === weeklyOccurrences[0].id);
  assert.equal(updatedWeekly.my_rsvp, 'going');
  assert.equal(updatedWeekly.reminder_enabled, true);
  const originalNextWeeklyStart = weeklyOccurrences[1].starts_at;
  const movedStart = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
  expectStatus(await call(host, 'PATCH', `/calendar/occurrences/${weeklyOccurrences[0].id}`, { startsAt: movedStart }), 200);
  memberCalendar = expectStatus(await call(member, 'GET', '/calendar'), 200);
  const movedOccurrence = memberCalendar.occurrences.find((item) => item.id === weeklyOccurrences[0].id);
  assert.equal(movedOccurrence.starts_at, movedStart);
  assert.equal(memberCalendar.occurrences.find((item) => item.id === weeklyOccurrences[1].id).starts_at, originalNextWeeklyStart);
  assert.equal(movedOccurrence.my_rsvp, 'going');
  const reminderDeadline = Date.now() + 3500;
  while (Date.now() < reminderDeadline && await notificationCount(member, 'occurrence_reminder') === 0) await delay(100);
  assert.equal(await notificationCount(member, 'occurrence_reminder'), 1);

  const attendanceRoom = expectStatus(await call(host, 'POST', '/rooms', {
    title: 'Attendance test room', subject: 'Biology', course: 'BIO test', goal: 'Study',
    accessType: 'public', scheduledAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  }), 201).room;
  expectStatus(await call(member, 'POST', `/rooms/${attendanceRoom.id}/join`, {}), 201);
  const attendanceCalendar = expectStatus(await call(member, 'GET', '/calendar'), 200);
  const attendanceOccurrence = attendanceCalendar.occurrences.find((item) => item.room_id === attendanceRoom.id);
  assert.ok(attendanceOccurrence);
  expectStatus(await call(member, 'POST', `/calendar/occurrences/${attendanceOccurrence.id}/attendance`, {}), 200);
  const afterCheckIn = expectStatus(await call(member, 'GET', '/calendar'), 200).occurrences.find((item) => item.id === attendanceOccurrence.id);
  assert.equal(afterCheckIn.attended, true);
  assert.equal(afterCheckIn.attendance_count, 1);

  const cancelRoom = expectStatus(await call(host, 'POST', '/rooms', {
    title: 'Cancel test room', subject: 'Biology', goal: 'Study', accessType: 'public',
    scheduledAt: new Date(Date.now() + 45 * 60 * 1000).toISOString(),
  }), 201).room;
  const cancelOccurrence = expectStatus(await call(member, 'GET', '/calendar'), 200).occurrences.find((item) => item.room_id === cancelRoom.id);
  expectStatus(await call(member, 'POST', `/calendar/occurrences/${cancelOccurrence.id}/rsvp`, { status: 'going' }), 200);
  expectStatus(await call(host, 'POST', `/calendar/occurrences/${cancelOccurrence.id}/cancel`, {}), 200);
  assert.equal(await notificationCount(member, 'occurrence_cancelled'), 1);

  // Co-host powers are explicit. Room editing does not silently grant member or chat controls.
  expectStatus(await call(host, 'POST', `/rooms/${publicRoom.id}/members/${member.id}/cohost`, { enabled: true, permissions: ['manage_room'] }), 200);
  const cohostRoom = expectStatus(await call(member, 'GET', `/rooms/${publicRoom.id}`), 200);
  assert.equal(cohostRoom.role, 'cohost');
  assert.deepEqual(cohostRoom.permissions, { manage_room: true });
  expectStatus(await call(member, 'PATCH', `/rooms/${publicRoom.id}`, { title: 'Co-hosted practice room' }), 200);
  expectStatus(await call(member, 'DELETE', `/rooms/${publicRoom.id}/members/${invitee.id}`), 403);
  const scopeMessage = expectStatus(await call(member, 'POST', `/rooms/${publicRoom.id}/messages`, { body: 'A message without pin access' }), 201).message;
  expectStatus(await call(member, 'POST', `/rooms/${publicRoom.id}/messages/${scopeMessage.id}/pin`, {}), 403);
  expectStatus(await call(member, 'POST', `/rooms/${publicRoom.id}/sessions`, { preset: 'classic' }), 403);
  expectStatus(await call(host, 'POST', `/rooms/${publicRoom.id}/members/${member.id}/cohost`, { enabled: false }), 200);

  const scheduleDelegationRoom = expectStatus(await call(host, 'POST', '/rooms', {
    title: 'Schedule permissions', subject: 'Biology', goal: 'Study together', accessType: 'public',
    scheduledAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  }), 201).room;
  expectStatus(await call(member, 'POST', `/rooms/${scheduleDelegationRoom.id}/join`, {}), 201);
  const delegatedOccurrence = expectStatus(await call(member, 'GET', '/calendar'), 200).occurrences.find((item) => item.room_id === scheduleDelegationRoom.id);
  expectStatus(await call(host, 'POST', `/rooms/${scheduleDelegationRoom.id}/members/${member.id}/cohost`, { enabled: true, permissions: ['manage_schedule'] }), 200);
  assert.equal(expectStatus(await call(member, 'GET', '/calendar'), 200).occurrences.find((item) => item.id === delegatedOccurrence.id).can_manage, true);
  expectStatus(await call(member, 'PATCH', `/rooms/${scheduleDelegationRoom.id}`, { title: 'Not allowed to edit room details' }), 403);
  expectStatus(await call(member, 'POST', `/calendar/occurrences/${delegatedOccurrence.id}/cancel`, {}), 200);
  expectStatus(await call(host, 'POST', `/rooms/${scheduleDelegationRoom.id}/members/${member.id}/cohost`, { enabled: false }), 200);

  const attendanceDelegationRoom = expectStatus(await call(host, 'POST', '/rooms', {
    title: 'Attendance permissions', subject: 'Biology', goal: 'Study together', accessType: 'public',
    scheduledAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  }), 201).room;
  expectStatus(await call(member, 'POST', `/rooms/${attendanceDelegationRoom.id}/join`, {}), 201);
  const attendanceDelegationOccurrence = expectStatus(await call(member, 'GET', '/calendar'), 200).occurrences.find((item) => item.room_id === attendanceDelegationRoom.id);
  expectStatus(await call(host, 'POST', `/rooms/${attendanceDelegationRoom.id}/members/${member.id}/cohost`, { enabled: true, permissions: ['manage_attendance'] }), 200);
  const attendanceManagerOccurrence = expectStatus(await call(member, 'GET', '/calendar'), 200).occurrences.find((item) => item.id === attendanceDelegationOccurrence.id);
  assert.equal(attendanceManagerOccurrence.can_manage_attendance, true);
  expectStatus(await call(member, 'POST', `/calendar/occurrences/${attendanceDelegationOccurrence.id}/attendance`, { userId: host.id }), 200);
  expectStatus(await call(member, 'POST', `/calendar/occurrences/${attendanceDelegationOccurrence.id}/cancel`, {}), 403);
  expectStatus(await call(host, 'POST', `/rooms/${attendanceDelegationRoom.id}/members/${member.id}/cohost`, { enabled: false }), 200);

  const savedTemplate = expectStatus(await call(host, 'POST', '/room-templates', {
    title: 'Weekly biology circle', subject: 'Biology', course: 'BIO 101', goal: 'Review notes',
    accessType: 'public', participantLimit: 7, recurrence: 'weekly',
  }), 201).template;
  const templates = expectStatus(await call(host, 'GET', '/room-templates'), 200);
  assert.equal(templates.templates.some((template) => template.id === savedTemplate.id), true);
  expectStatus(await call(member, 'GET', '/room-templates'), 200);
  assert.equal(expectStatus(await call(member, 'GET', '/room-templates'), 200).templates.some((template) => template.id === savedTemplate.id), false);
  expectStatus(await call(member, 'DELETE', `/room-templates/${savedTemplate.id}`), 404);
  expectStatus(await call(host, 'POST', `/rooms/${weeklyRoom.id}/sessions`, { preset: 'classic' }), 409);
  await db.query("UPDATE rooms SET scheduled_at=NOW()-INTERVAL '30 minutes' WHERE id=$1", [weeklyRoom.id]);
  const inWindow = expectStatus(await call(host, 'POST', `/rooms/${weeklyRoom.id}/sessions`, { preset: 'classic' }), 201).session;
  expectStatus(await call(host, 'POST', `/sessions/${inWindow.id}/control`, { action: 'finish' }), 200);
  await db.query("UPDATE rooms SET scheduled_at=NOW()-INTERVAL '5 hours' WHERE id=$1", [weeklyRoom.id]);
  expectStatus(await call(host, 'POST', `/rooms/${weeklyRoom.id}/sessions`, { preset: 'classic' }), 409);
  const invalidRepeat = await call(host, 'POST', '/rooms', {
    title: 'No start time', subject: 'Biology', goal: 'Study together',
    accessType: 'public', recurrence: 'daily',
  });
  expectStatus(invalidRepeat, 400);

  // Shared task progress is per member; personal tasks remain owner-only.
  const sharedTask = expectStatus(await call(host, 'POST', `/rooms/${publicRoom.id}/tasks`, {
    title: 'Review scheduling notes',
  }), 201).task;
  expectStatus(await call(member, 'PATCH', `/tasks/${sharedTask.id}/completion`, { completed: true }), 200);
  let roomView = expectStatus(await call(host, 'GET', `/rooms/${publicRoom.id}`), 200);
  const sharedView = roomView.tasks.find((task) => task.id === sharedTask.id);
  assert.equal(sharedView.completions.length, 2);
  assert.equal(sharedView.completions.find((entry) => entry.userId === member.id).completedAt !== null, true);
  const privateTask = expectStatus(await call(host, 'POST', '/tasks/personal', { title: 'Private reading' }), 201).task;
  assert.equal(expectStatus(await call(member, 'GET', '/tasks/personal'), 200).tasks.some((task) => task.id === privateTask.id), false);
  expectStatus(await call(member, 'PATCH', `/tasks/${privateTask.id}/completion`, { completed: true }), 403);

  // A full room rejects another join instead of overbooking its participant limit.
  const cappedRoom = await room(host, 'public', 'Two seat room', 2);
  expectStatus(await call(member, 'POST', `/rooms/${cappedRoom.id}/join`, {}), 201);
  expectStatus(await call(invitee, 'POST', `/rooms/${cappedRoom.id}/join`, {}), 409);

  // Two live clients receive the same host-led session and coarse room presence.
  const hostSocket = await connectSocket(baseUrl, host.token);
  const memberSocket = await connectSocket(baseUrl, member.token);
  t.after(() => { hostSocket.close(); memberSocket.close(); });
  hostSocket.send('room:subscribe', { roomId: publicRoom.id });
  memberSocket.send('room:subscribe', { roomId: publicRoom.id });
  await hostSocket.waitForEvent('presence:snapshot', (event) => event.roomId === publicRoom.id);
  await memberSocket.waitForEvent('presence:snapshot', (event) => event.roomId === publicRoom.id);
  memberSocket.send('presence:update', { roomId: publicRoom.id, status: 'studying' });
  const presence = await hostSocket.waitForEvent('presence:snapshot', (event) => event.members?.[member.id] === 'studying');
  assert.equal(presence.members[member.id], 'studying');

  let started = expectStatus(await call(host, 'POST', `/rooms/${publicRoom.id}/sessions`, { preset: 'classic' }), 201).session;
  assert.equal(started.focusSeconds, 1500);
  assert.equal(started.breakSeconds, 300);
  const hostTimer = await hostSocket.waitForEvent('session:update', (event) => event.id === started.id);
  const memberTimer = await memberSocket.waitForEvent('session:update', (event) => event.id === started.id);
  assert.equal(hostTimer.status, 'running');
  assert.equal(memberTimer.status, 'running');
  assert.ok(Math.abs(hostTimer.remainingSeconds - memberTimer.remainingSeconds) < 2);
  expectStatus(await call(member, 'POST', `/sessions/${started.id}/control`, { action: 'pause' }), 403);
  started = expectStatus(await call(host, 'POST', `/sessions/${started.id}/control`, { action: 'pause' }), 200).session;
  assert.equal(started.status, 'paused');
  started = expectStatus(await call(host, 'POST', `/sessions/${started.id}/control`, { action: 'resume' }), 200).session;
  assert.equal(started.status, 'running');
  expectStatus(await call(host, 'POST', `/sessions/${started.id}/control`, { action: 'finish' }), 200);
  let session = expectStatus(await call(host, 'POST', `/rooms/${publicRoom.id}/sessions`, { preset: 'deep' }), 201).session;
  assert.equal(session.focusSeconds, 3000);
  assert.equal(session.breakSeconds, 600);
  expectStatus(await call(host, 'POST', `/sessions/${session.id}/control`, { action: 'finish' }), 200);
  session = expectStatus(await call(host, 'POST', `/rooms/${publicRoom.id}/sessions`, {
    preset: 'custom', focusMinutes: 35, breakMinutes: 7,
  }), 201).session;
  assert.equal(session.focusSeconds, 2100);
  assert.equal(session.breakSeconds, 420);
  expectStatus(await call(host, 'POST', `/sessions/${session.id}/control`, { action: 'finish' }), 200);

  // Room chat supports replies, pins, reactions, and idempotent offline retries.
  const mentionsBefore = await notificationCount(host, 'mention');
  const messageBody = `@${host.username} I finished the notes`;
  const firstMessage = expectStatus(await call(member, 'POST', `/rooms/${publicRoom.id}/messages`, {
    body: messageBody, clientMutationId: `room-retry-${suffix}`,
  }), 201).message;
  const retriedMessage = expectStatus(await call(member, 'POST', `/rooms/${publicRoom.id}/messages`, {
    body: messageBody, clientMutationId: `room-retry-${suffix}`,
  }), 201).message;
  assert.equal(retriedMessage.id, firstMessage.id);
  assert.equal(await notificationCount(host, 'mention'), mentionsBefore + 1);
  expectStatus(await call(host, 'POST', `/rooms/${publicRoom.id}/messages/${firstMessage.id}/pin`, {}), 200);
  expectStatus(await call(member, 'POST', `/messages/room/${firstMessage.id}/reactions`, { reaction: '👏' }), 201);
  const reply = expectStatus(await call(host, 'POST', `/rooms/${publicRoom.id}/messages`, {
    body: 'Thanks!', replyTo: firstMessage.id,
  }), 201).message;
  assert.equal(reply.reply_to, firstMessage.id);

  // DMs stay unavailable until approved, and retrying a queued send notifies once.
  const request = expectStatus(await call(member, 'POST', '/direct/requests', { username: host.username }), 201).request;
  expectStatus(await call(host, 'GET', `/direct/${request.id}/messages`), 403);
  expectStatus(await call(host, 'POST', `/direct/requests/${request.id}/respond`, { accept: true }), 200);
  const directNotificationsBefore = await notificationCount(member, 'direct_message');
  const directBody = 'Want to plan a shared focus block?';
  const direct = expectStatus(await call(host, 'POST', `/direct/${request.id}/messages`, {
    body: directBody, clientMutationId: `direct-retry-${suffix}`,
  }), 201).message;
  const duplicateDirect = expectStatus(await call(host, 'POST', `/direct/${request.id}/messages`, {
    body: directBody, clientMutationId: `direct-retry-${suffix}`,
  }), 201).message;
  assert.equal(duplicateDirect.id, direct.id);
  assert.equal(await notificationCount(member, 'direct_message'), directNotificationsBefore + 1);
  const directMentionsBefore = await notificationCount(member, 'mention');
  const mentionedDirect = expectStatus(await call(host, 'POST', `/direct/${request.id}/messages`, {
    body: `@${member.username} the shared focus block is ready`,
    clientMutationId: `direct-mention-${suffix}`,
  }), 201).message;
  assert.equal(mentionedDirect.body, `@${member.username} the shared focus block is ready`);
  assert.equal(await notificationCount(member, 'mention'), directMentionsBefore + 1);
  assert.equal(await notificationCount(member, 'direct_message'), directNotificationsBefore + 1);
  expectStatus(await call(member, 'POST', `/messages/direct/${direct.id}/reactions`, { reaction: '📚' }), 201);
  expectStatus(await call(member, 'POST', `/direct/${request.id}/messages/${direct.id}/pin`, {}), 200);
  let directHistory = expectStatus(await call(member, 'GET', `/direct/${request.id}/messages`), 200).messages;
  assert.equal(directHistory.find((message) => message.id === direct.id).is_pinned, true);
  expectStatus(await call(host, 'POST', `/direct/${request.id}/messages/${direct.id}/pin`, {}), 200);
  directHistory = expectStatus(await call(host, 'GET', `/direct/${request.id}/messages`), 200).messages;
  assert.equal(directHistory.find((message) => message.id === direct.id).is_pinned, false);
  const directReply = expectStatus(await call(member, 'POST', `/direct/${request.id}/messages`, {
    body: 'Yes, tomorrow works.', replyTo: direct.id,
  }), 201).message;
  assert.equal(directReply.reply_to, direct.id);

  // Stats use the requested local date, count only focus intervals, and require 25 minutes per day.
  expectStatus(await call(host, 'GET', '/stats?timezone=Not_A_Real_Zone'), 400);
  for (const [startOffset, endOffset] of [
    ['40 minutes', '10 minutes'],
    ['1 day 40 minutes', '1 day 10 minutes'],
    ['2 days 34 minutes', '2 days 10 minutes'],
  ]) {
    await db.query(
      `INSERT INTO focus_intervals(session_id,user_id,started_at,ended_at)
       VALUES($1,$2,NOW()-$3::interval,NOW()-$4::interval)`,
      [session.id, host.id, startOffset, endOffset],
    );
  }
  const stats = expectStatus(await call(host, 'GET', '/stats?timezone=UTC'), 200);
  assert.equal(stats.streakDays, 2);
  assert.equal(typeof stats.days.at(-1).day, 'string');
  assert.match(stats.days.at(-1).day, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(stats.days.some((day) => day.focusedSeconds === 1440), true);
  const history = expectStatus(await call(host, 'GET', '/sessions/history'), 200);
  assert.ok(history.sessions.length >= 3);

  // Private weekly planning stays scoped to one account and counts manual completion.
  const hostBlockStart = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const hostBlockEnd = new Date(hostBlockStart.getTime() + 60 * 60 * 1000);
  const hostBlock = expectStatus(await call(host, 'POST', '/planner/blocks', {
    title: 'HOST_PRIVATE_BLOCK', subject: 'Biology', startsAt: hostBlockStart.toISOString(), endsAt: hostBlockEnd.toISOString(), reminderEnabled: false,
  }), 201).block;
  const memberBlock = expectStatus(await call(member, 'POST', '/planner/blocks', {
    title: 'MEMBER_SECRET_BLOCK', subject: 'Mathematics', startsAt: hostBlockStart.toISOString(), endsAt: hostBlockEnd.toISOString(), reminderEnabled: false,
  }), 201).block;
  expectStatus(await call(host, 'PUT', '/planner/goal', { sessionsPerWeek: 5 }), 200);
  let hostPlan = expectStatus(await call(host, 'GET', `/planner/blocks?from=${encodeURIComponent(hostBlockStart.toISOString())}&to=${encodeURIComponent(new Date(hostBlockEnd.getTime() + 60_000).toISOString())}`), 200);
  assert.equal(hostPlan.goal, 5);
  assert.ok(hostPlan.blocks.some((block) => block.id === hostBlock.id));
  assert.equal(hostPlan.blocks.some((block) => block.id === memberBlock.id), false);
  expectStatus(await call(host, 'PATCH', `/planner/blocks/${hostBlock.id}`, { completed: true }), 200);
  hostPlan = expectStatus(await call(host, 'GET', '/planner/blocks'), 200);
  assert.ok(hostPlan.completedThisWeek >= 1);
  const copied = expectStatus(await call(host, 'POST', '/planner/blocks/carry-forward', { copies: [{ blockId: hostBlock.id, startsAt: new Date(hostBlockStart.getTime() + 7 * 86_400_000).toISOString(), endsAt: new Date(hostBlockEnd.getTime() + 7 * 86_400_000).toISOString() }] }), 201);
  assert.equal(copied.blocks.length, 1);

  // Matching only returns opted-in people and omits school and exact windows.
  for (const account of [host, member]) {
    expectStatus(await call(account, 'PUT', '/matching/preferences', {
      enabled: true, subjects: ['Computer science'], courses: ['CSC test'], availability: ['weekday_evening'],
    }), 200);
  }
  const recommendations = expectStatus(await call(host, 'GET', '/recommendations'), 200);
  const match = recommendations.people.find((person) => person.id === member.id);
  assert.ok(match);
  assert.equal('school' in match, false);
  assert.equal('availability' in match, false);
  assert.equal('email' in match, false);

  // Friend requests are independent of DM requests, and accepted friends persist.
  const friendRequest = expectStatus(await call(host, 'POST', '/friends/requests', { username: member.username }), 201).request;
  const memberRequests = expectStatus(await call(member, 'GET', '/friends/requests'), 200).requests;
  assert.ok(memberRequests.some((item) => item.id === friendRequest.id));
  expectStatus(await call(member, 'PATCH', `/friends/requests/${friendRequest.id}`, { action: 'accept' }), 200);
  assert.ok(expectStatus(await call(host, 'GET', '/friends'), 200).friends.some((item) => item.id === member.id));

  // Room files, notes, and the optimistic-version whiteboard require membership.
  const material = expectStatus(await call(host, 'POST', `/rooms/${publicRoom.id}/materials`, {
    title: 'Shared lecture notes', fileName: 'lecture.txt', contentType: 'text/plain', dataBase64: Buffer.from('A private room document about photosynthesis.').toString('base64'),
  }), 201).material;
  assert.equal(expectStatus(await call(member, 'GET', `/rooms/${publicRoom.id}/materials`), 200).materials.some((item) => item.id === material.id), true);
  expectStatus(await call(invitee, 'GET', `/rooms/${publicRoom.id}/materials`), 403);
  const download = await fetch(`${baseUrl}/rooms/${publicRoom.id}/materials/${material.id}/download`, { headers: { Authorization: `Bearer ${member.token}` } });
  assert.equal(download.status, 200);
  assert.match(await download.text(), /photosynthesis/);
  const note = expectStatus(await call(host, 'POST', `/rooms/${publicRoom.id}/notes`, { title: 'Shared outline', body: 'Chapter 4' }), 201).note;
  expectStatus(await call(member, 'PATCH', `/rooms/${publicRoom.id}/notes/${note.id}`, { version: 1, title: 'Shared outline', body: 'Chapter 4 with examples' }), 200);
  expectStatus(await call(host, 'PATCH', `/rooms/${publicRoom.id}/notes/${note.id}`, { version: 1, title: 'Stale edit', body: 'Should not overwrite' }), 409);
  assert.equal(expectStatus(await call(member, 'GET', `/rooms/${publicRoom.id}/whiteboard`), 200).whiteboard.version, 0);
  const boardBroadcast = memberSocket.waitForEvent('whiteboard:update', (event) => event.roomId === publicRoom.id);
  const board = expectStatus(await call(host, 'PUT', `/rooms/${publicRoom.id}/whiteboard`, { version: 0, strokes: [{ color: '003F52', width: 0.006, points: [{ x: 0.1, y: 0.2 }, { x: 0.4, y: 0.5 }] }] }), 200).whiteboard;
  assert.equal(board.version, 1);
  assert.equal((await boardBroadcast).whiteboard.version, 1);
  expectStatus(await call(member, 'PUT', `/rooms/${publicRoom.id}/whiteboard`, { version: 0, strokes: [] }), 409);
  expectStatus(await call(invitee, 'GET', `/rooms/${publicRoom.id}/whiteboard`), 403);

  // Nearby recovery summaries are private and idempotent; chat is never accepted here.
  const offlineSummary = { clientSessionId: `nearby-${suffix}`, focusedSeconds: 1500, completedCycles: 1, endedAt: new Date().toISOString() };
  expectStatus(await call(host, 'POST', '/offline/summaries', offlineSummary), 201);
  expectStatus(await call(host, 'POST', '/offline/summaries', offlineSummary), 201);
  const savedSummary = await db.query('SELECT COUNT(*)::int count FROM nearby_summaries WHERE user_id=$1 AND client_session_id=$2', [host.id, offlineSummary.clientSessionId]);
  assert.equal(savedSummary.rows[0].count, 1);
  assert.equal('messages' in offlineSummary, false);

  // An optional school email is separate from the login email; invite fallback is labelled.
  expectStatus(await call(admin, 'POST', '/admin/institutions', { name: 'Example Test University', domain: 'uni.example.test' }), 201);
  const schoolEmail = `host-${suffix}@uni.example.test`;
  expectStatus(await call(host, 'POST', '/communities/school-email/request', { email: schoolEmail }), 202);
  expectStatus(await call(host, 'POST', '/communities/school-email/verify', { email: schoolEmail, code: await mailboxCode(schoolEmail, 'Verify') }), 200);
  const hostCommunity = expectStatus(await call(host, 'GET', '/communities'), 200).communities[0];
  expectStatus(await call(host, 'POST', `/communities/${hostCommunity.id}/invites`, { username: invitee.username }), 201);
  const inviteeCommunity = expectStatus(await call(invitee, 'GET', '/communities'), 200).communities.find((item) => item.id === hostCommunity.id);
  assert.ok(inviteeCommunity.invite_id);
  expectStatus(await call(invitee, 'POST', `/communities/${hostCommunity.id}/join`), 201);
  assert.equal(expectStatus(await call(invitee, 'GET', '/communities'), 200).communities.find((item) => item.id === hostCommunity.id).verification_method, 'member_invite');
  expectStatus(await call(member, 'POST', '/communities/school-email/request', { email: `student@unsupported.example` }), 422);

  // Weekly public rankings are a separate opt-in and only disclose chosen names and scores.
  await db.query("INSERT INTO user_focus_activities(user_id,activity_key,source,focused_seconds,session_count,occurred_at) VALUES($1,$2,'timer',1500,4,NOW()),($3,$4,'timer',3000,8,NOW()) ON CONFLICT DO NOTHING", [host.id, `test-leader-${suffix}`, member.id, `test-opt-out-${suffix}`]);
  expectStatus(await call(host, 'PUT', '/leaderboard/settings', { enabled: true, displayName: 'Study captain' }), 200);
  expectStatus(await call(member, 'PUT', '/leaderboard/settings', { enabled: false, displayName: 'Hidden student' }), 200);
  const leaderboard = expectStatus(await call(host, 'GET', '/leaderboard/weekly'), 200).entries;
  assert.ok(leaderboard.some((entry) => entry.displayName === 'Study captain' && entry.weeklyScore >= 4));
  assert.equal(leaderboard.some((entry) => JSON.stringify(entry).includes(member.username)), false);
  assert.deepEqual(Object.keys(leaderboard[0]).sort(), ['displayName', 'rank', 'weeklyScore'].sort());

  // All integration AI traffic terminates at a local mock provider, never Google.
  assert.equal(expectStatus(await call(host, 'GET', '/ai/status'), 200).enabled, true);
  expectStatus(await call(host, 'POST', '/ai/requests', { operation: 'semantic_search', prompt: 'Find the reaction summary', roomId: publicRoom.id, materialIds: [material.id], confirmGoogleProcessing: true }), 400);
  const semantic = expectStatus(await call(host, 'POST', '/ai/requests', { operation: 'semantic_search', prompt: 'Find the reaction summary', roomId: publicRoom.id, materialIds: [material.id], confirmGoogleProcessing: true, confirmPersistentIndex: true }), 200);
  assert.match(semantic.answer, /Mocked study response/);
  const semanticCall = geminiRequests.findLast((item) => item.url?.includes(':generateContent'));
  assert.ok(semanticCall.payload.tools[0].file_search.file_search_store_names.length > 0);
  const clearedIndex = expectStatus(await call(host, 'DELETE', `/ai/material-index/${material.id}`), 200);
  assert.equal(clearedIndex.cleanupPending, false);
  assert.equal(geminiRequests.some((item) => item.method === 'DELETE' && item.url?.includes('fileSearchStores/test-private-store-')), true);
  const cleanupMaterial = expectStatus(await call(host, 'POST', `/rooms/${publicRoom.id}/materials`, {
    title: 'Index cleanup test', fileName: 'cleanup.txt', contentType: 'text/plain', dataBase64: Buffer.from('Remove the selected document index with its room file.').toString('base64'),
  }), 201).material;
  expectStatus(await call(host, 'POST', '/ai/requests', { operation: 'semantic_search', prompt: 'Find the cleanup note', roomId: publicRoom.id, materialIds: [cleanupMaterial.id], confirmGoogleProcessing: true, confirmPersistentIndex: true }), 200);
  const [cleanupStore] = (await db.query('SELECT store_name FROM ai_file_search_stores WHERE user_id=$1 AND material_id=$2', [host.id, cleanupMaterial.id])).rows;
  assert.ok(cleanupStore);
  expectStatus(await call(host, 'DELETE', `/rooms/${publicRoom.id}/materials/${cleanupMaterial.id}`), 200);
  const queuedCleanup = await db.query('SELECT 1 FROM ai_file_search_cleanup WHERE store_name=$1', [cleanupStore.store_name]);
  assert.equal(queuedCleanup.rowCount, 1);
  const ownPlan = expectStatus(await call(host, 'POST', '/ai/requests', { operation: 'assistant', prompt: 'Suggest a next step', includePlan: true, confirmGoogleProcessing: true }), 200);
  assert.match(ownPlan.answer, /Mocked study response/);
  const ownPlanCall = geminiRequests.findLast((item) => item.url?.includes(':generateContent'));
  const sentPrompt = ownPlanCall.payload.contents[0].parts[0].text;
  assert.match(sentPrompt, /HOST_PRIVATE_BLOCK/);
  assert.doesNotMatch(sentPrompt, /MEMBER_SECRET_BLOCK/);
  const planDraft = expectStatus(await call(host, 'POST', '/ai/requests', { operation: 'study_plan', prompt: 'Fit in biology review', confirmGoogleProcessing: true }), 200);
  assert.equal(JSON.parse(planDraft.answer).blocks.length, 1);
  expectStatus(await call(host, 'POST', '/ai/requests', { operation: 'assistant', prompt: 'force-provider-error', confirmGoogleProcessing: true }), 502);

  // The local guard stops calls before the configured protected budget; this
  // assertion is against the mock provider and never contacts Google.
  await db.query(
    "INSERT INTO ai_usage(user_id,request_id,operation,model,estimated_usd) VALUES($1,$2,'assistant','mock-model',38.5)",
    [host.id, `budget-cutoff-${suffix}`],
  );
  const callsBeforeCutoff = geminiRequests.length;
  expectStatus(await call(host, 'POST', '/ai/requests', { operation: 'assistant', prompt: 'must stop at the safety cutoff', confirmGoogleProcessing: true }), 429);
  assert.equal(geminiRequests.length, callsBeforeCutoff);
  await db.query('DELETE FROM ai_usage WHERE request_id=$1', [`budget-cutoff-${suffix}`]);

  // Blocking, report privacy, staff review actions, and notification ownership.
  expectStatus(await call(member, 'POST', `/users/${host.id}/block`, {}), 201);
  expectStatus(await call(member, 'POST', `/direct/${request.id}/messages`, { body: 'Blocked send' }), 403);
  const report = expectStatus(await call(member, 'POST', '/reports', {
    reportedUserId: invitee.id, roomId: inviteRoom.id, reason: 'Spam', details: 'Repeated unrelated messages',
  }), 201).report;
  expectStatus(await call(host, 'GET', '/admin/reports'), 403);
  const reportQueue = expectStatus(await call(admin, 'GET', '/admin/reports'), 200);
  assert.equal(reportQueue.reports.some((item) => item.id === report.id), true);
  expectStatus(await call(admin, 'PATCH', `/admin/reports/${report.id}`, { action: 'warned' }), 200);
  assert.equal(await notificationCount(invitee, 'moderation_warning'), 1);
  const memberNotifications = expectStatus(await call(member, 'GET', '/notifications'), 200).notifications;
  if (memberNotifications.length) {
    const unread = memberNotifications.find((notification) => !notification.is_read);
    if (unread) {
      expectStatus(await call(host, 'PATCH', `/notifications/${unread.id}/read`, {}), 200);
      const stillUnread = expectStatus(await call(member, 'GET', '/notifications'), 200).notifications
        .find((notification) => notification.id === unread.id);
      assert.equal(stillUnread.is_read, false);
    }
  }
  const suspendReport = expectStatus(await call(member, 'POST', '/reports', {
    reportedUserId: recovery.id, reason: 'Repeated abuse', details: 'Test moderation suspension',
  }), 201).report;
  expectStatus(await call(admin, 'PATCH', `/admin/reports/${suspendReport.id}`, { action: 'suspended' }), 200);
  expectStatus(await call(recovery, 'GET', '/me'), 401);
  const dismissReport = expectStatus(await call(member, 'POST', '/reports', {
    reportedUserId: host.id, reason: 'Other', details: 'Test dismissal',
  }), 201).report;
  expectStatus(await call(admin, 'PATCH', `/admin/reports/${dismissReport.id}`, { action: 'dismissed' }), 200);
});

async function availablePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForHealth(baseUrl, child, getOutput) {
  const until = Date.now() + 30_000;
  let lastError;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`API exited during startup:\n${getOutput()}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await delay(150);
  }
  throw new Error(`API did not become ready: ${lastError ?? ''}\n${getOutput()}`);
}

async function connectSocket(baseUrl, token) {
  const address = new URL(baseUrl);
  const socket = new WebSocket(`ws://${address.host}/socket.io/?EIO=4&transport=websocket`);
  const packets = [];
  const waiters = [];
  socket.on('message', (data) => {
    const packet = data.toString();
    if (packet === '2') {
      socket.send('3');
      return;
    }
    packets.push(packet);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(packet)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        clearTimeout(waiter.timeout);
        waiter.resolve(packet);
      }
    }
  });
  const waitForPacket = (predicate) => {
    const existing = packets.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        timeout: setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1);
          reject(new Error(`Timed out waiting for socket packet. Seen: ${packets.join(', ')}`));
        }, 5000),
      };
      waiters.push(waiter);
    });
  };
  await once(socket, 'open');
  await waitForPacket((packet) => packet.startsWith('0'));
  socket.send(`40${JSON.stringify({ token })}`);
  await waitForPacket((packet) => packet.startsWith('40{') || packet.startsWith('44'));
  if (packets.some((packet) => packet.startsWith('44'))) {
    throw new Error(`Socket authentication failed: ${packets.find((packet) => packet.startsWith('44'))}`);
  }
  return {
    send(event, payload) { socket.send(`42${JSON.stringify([event, payload])}`); },
    async waitForEvent(eventName, predicate = () => true) {
      const packet = await waitForPacket((raw) => {
        if (!raw.startsWith('42')) return false;
        try {
          const [name, payload] = JSON.parse(raw.slice(2));
          return name === eventName && predicate(payload);
        } catch {
          return false;
        }
      });
      return JSON.parse(packet.slice(2))[1];
    },
    close() {
      for (const waiter of waiters) clearTimeout(waiter.timeout);
      if (socket.readyState === WebSocket.OPEN) socket.close();
    },
  };
}
