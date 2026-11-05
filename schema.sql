CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  is_verified BOOLEAN NOT NULL DEFAULT FALSE,
  is_suspended BOOLEAN NOT NULL DEFAULT FALSE,
  profile JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS email_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('verify', 'reset')),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS local_mailbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS rooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id UUID NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  subject TEXT NOT NULL,
  course TEXT NOT NULL DEFAULT '',
  goal TEXT NOT NULL,
  access_type TEXT NOT NULL CHECK (access_type IN ('public', 'link', 'invite')),
  access_code TEXT,
  participant_limit INTEGER NOT NULL DEFAULT 8 CHECK (participant_limit BETWEEN 2 AND 50),
  language TEXT NOT NULL DEFAULT 'English',
  scheduled_at TIMESTAMPTZ,
  recurrence TEXT NOT NULL DEFAULT 'none' CHECK (recurrence IN ('none', 'daily', 'weekly')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE rooms ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS recurrence TEXT NOT NULL DEFAULT 'none'
  CHECK (recurrence IN ('none', 'daily', 'weekly'));

CREATE TABLE IF NOT EXISTS room_members (
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('host', 'cohost', 'member')),
  permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (room_id, user_id)
);

ALTER TABLE room_members ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE room_members DROP CONSTRAINT IF EXISTS room_members_role_check;
ALTER TABLE room_members ADD CONSTRAINT room_members_role_check CHECK (role IN ('host', 'cohost', 'member'));

CREATE TABLE IF NOT EXISTS room_occurrences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  starts_at TIMESTAMPTZ NOT NULL,
  schedule_key TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'cancelled', 'completed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE room_occurrences ADD COLUMN IF NOT EXISTS schedule_key TIMESTAMPTZ;
UPDATE room_occurrences SET schedule_key=starts_at WHERE schedule_key IS NULL;
ALTER TABLE room_occurrences ALTER COLUMN schedule_key SET NOT NULL;
ALTER TABLE room_occurrences DROP CONSTRAINT IF EXISTS room_occurrences_room_id_starts_at_key;
CREATE UNIQUE INDEX IF NOT EXISTS room_occurrences_schedule_key_unique ON room_occurrences(room_id, schedule_key);

CREATE TABLE IF NOT EXISTS occurrence_rsvps (
  occurrence_id UUID NOT NULL REFERENCES room_occurrences(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('going', 'maybe', 'declined')),
  reminder_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  reminder_sent_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (occurrence_id, user_id)
);

CREATE TABLE IF NOT EXISTS occurrence_attendance (
  occurrence_id UUID NOT NULL REFERENCES room_occurrences(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  checked_in_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  marked_by UUID REFERENCES users(id),
  PRIMARY KEY (occurrence_id, user_id)
);

CREATE TABLE IF NOT EXISTS room_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  subject TEXT NOT NULL,
  course TEXT NOT NULL DEFAULT '',
  goal TEXT NOT NULL,
  access_type TEXT NOT NULL DEFAULT 'public' CHECK (access_type IN ('public', 'link', 'invite')),
  participant_limit INTEGER NOT NULL DEFAULT 8 CHECK (participant_limit BETWEEN 2 AND 50),
  recurrence TEXT NOT NULL DEFAULT 'none' CHECK (recurrence IN ('none', 'daily', 'weekly')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS room_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  invited_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invited_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(room_id, invited_user_id)
);

CREATE TABLE IF NOT EXISTS study_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  host_id UUID NOT NULL REFERENCES users(id),
  preset TEXT NOT NULL CHECK (preset IN ('classic', 'deep', 'custom')),
  focus_seconds INTEGER NOT NULL,
  break_seconds INTEGER NOT NULL,
  phase TEXT NOT NULL DEFAULT 'focus' CHECK (phase IN ('focus', 'break', 'finished')),
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'paused', 'finished')),
  phase_started_at TIMESTAMPTZ,
  remaining_seconds INTEGER NOT NULL,
  cycle INTEGER NOT NULL DEFAULT 1,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS session_participants (
  session_id UUID NOT NULL REFERENCES study_sessions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  focused_seconds INTEGER NOT NULL DEFAULT 0,
  last_focus_started_at TIMESTAMPTZ,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (session_id, user_id)
);

CREATE TABLE IF NOT EXISTS focus_intervals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES study_sessions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cycle INTEGER NOT NULL DEFAULT 1,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ
);

ALTER TABLE focus_intervals ADD COLUMN IF NOT EXISTS cycle INTEGER NOT NULL DEFAULT 1;

CREATE UNIQUE INDEX IF NOT EXISTS focus_interval_open_idx ON focus_intervals(session_id,user_id) WHERE ended_at IS NULL;

CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  is_personal BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS task_completions (
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (task_id, user_id)
);

CREATE TABLE IF NOT EXISTS room_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  reply_to UUID REFERENCES room_messages(id) ON DELETE SET NULL,
  client_mutation_id TEXT,
  is_pinned BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS direct_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(sender_id, recipient_id)
);

CREATE TABLE IF NOT EXISTS direct_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES direct_requests(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  reply_to UUID REFERENCES direct_messages(id) ON DELETE SET NULL,
  client_mutation_id TEXT,
  is_pinned BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS is_pinned BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS message_reactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_kind TEXT NOT NULL CHECK (message_kind IN ('room', 'direct')),
  message_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reaction TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(message_kind, message_id, user_id, reaction)
);

CREATE TABLE IF NOT EXISTS user_blocks (
  blocker_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(blocker_id, blocked_id)
);

CREATE TABLE IF NOT EXISTS reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id UUID NOT NULL REFERENCES users(id),
  reported_user_id UUID NOT NULL REFERENCES users(id),
  room_id UUID REFERENCES rooms(id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'warned', 'suspended', 'dismissed')),
  reviewed_by UUID REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  kind TEXT NOT NULL,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS client_mutations (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mutation_id TEXT NOT NULL,
  result JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(user_id, mutation_id)
);

-- V2.1: private weekly planner and user-selected matching.
CREATE TABLE IF NOT EXISTS planner_goals (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  sessions_per_week INTEGER NOT NULL DEFAULT 3 CHECK (sessions_per_week BETWEEN 1 AND 21),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS planner_blocks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  reminder_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  completed_at TIMESTAMPTZ,
  copied_from UUID REFERENCES planner_blocks(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (ends_at > starts_at),
  CHECK (ends_at - starts_at <= INTERVAL '12 hours')
);

CREATE INDEX IF NOT EXISTS planner_blocks_user_schedule_idx ON planner_blocks(user_id, starts_at);

CREATE TABLE IF NOT EXISTS matching_preferences (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  subjects JSONB NOT NULL DEFAULT '[]'::jsonb,
  courses JSONB NOT NULL DEFAULT '[]'::jsonb,
  availability JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A completed, idempotent unit of meaningful study. Activity keys are created
-- by the source system so retries from offline clients cannot inflate totals.
CREATE TABLE IF NOT EXISTS user_focus_activities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  activity_key TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('timer', 'planner_block', 'room_checkin', 'nearby')),
  focused_seconds INTEGER NOT NULL DEFAULT 0 CHECK (focused_seconds >= 0),
  session_count INTEGER NOT NULL DEFAULT 1 CHECK (session_count >= 0),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, activity_key)
);

CREATE INDEX IF NOT EXISTS user_focus_activities_week_idx ON user_focus_activities(user_id, occurred_at);

-- V2.2: accepted friendships, achievements, and explicitly public rankings.
CREATE TABLE IF NOT EXISTS friend_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (sender_id <> recipient_id),
  UNIQUE(sender_id, recipient_id)
);

CREATE TABLE IF NOT EXISTS friendships (
  user_a UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(user_a, user_b),
  CHECK (user_a < user_b)
);

CREATE TABLE IF NOT EXISTS achievements (
  code TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  threshold INTEGER NOT NULL CHECK (threshold > 0),
  metric TEXT NOT NULL CHECK (metric IN ('sessions', 'focused_seconds', 'streak_days'))
);

INSERT INTO achievements(code,title,description,threshold,metric) VALUES
  ('first-focus', 'First focus', 'Finish your first focused study session.', 1, 'sessions'),
  ('five-focus-sessions', 'Finding a rhythm', 'Finish five focused sessions.', 5, 'sessions'),
  ('ten-focus-sessions', 'Showing up', 'Finish ten focused sessions.', 10, 'sessions'),
  ('deep-work-hour', 'Deep work', 'Build up one hour of focused study.', 3600, 'focused_seconds'),
  ('week-of-study', 'A steady week', 'Keep a seven-day study streak.', 7, 'streak_days')
ON CONFLICT(code) DO UPDATE SET title=EXCLUDED.title,description=EXCLUDED.description,
  threshold=EXCLUDED.threshold,metric=EXCLUDED.metric;

CREATE TABLE IF NOT EXISTS user_achievements (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  achievement_code TEXT NOT NULL REFERENCES achievements(code) ON DELETE CASCADE,
  unlocked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(user_id, achievement_code)
);

CREATE TABLE IF NOT EXISTS leaderboard_settings (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  display_name TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- V2.3: room-scoped documents and a shared, versioned note board.
CREATE TABLE IF NOT EXISTS room_materials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  uploader_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 8388608),
  data BYTEA NOT NULL,
  ai_document_name TEXT,
  ai_index_status TEXT NOT NULL DEFAULT 'not_indexed' CHECK (ai_index_status IN ('not_indexed', 'indexing', 'indexed', 'failed', 'deleting')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS room_materials_room_idx ON room_materials(room_id, created_at DESC);

-- Private documents belong to one account and are not visible in a room.
CREATE TABLE IF NOT EXISTS personal_study_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/pdf' CHECK (content_type = 'application/pdf'),
  byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 8388608),
  data BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS personal_study_documents_user_idx
  ON personal_study_documents(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS room_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  author_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS room_notes_room_idx ON room_notes(room_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS room_whiteboards (
  room_id UUID PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
  strokes JSONB NOT NULL DEFAULT '[]'::jsonb,
  version INTEGER NOT NULL DEFAULT 1,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ai_file_search_stores (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  material_id UUID NOT NULL REFERENCES room_materials(id) ON DELETE CASCADE,
  store_name TEXT NOT NULL UNIQUE,
  document_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(user_id, material_id)
);

-- Google File Search keeps indexed copies until the owning API key deletes
-- them. Keep a durable cleanup queue so deleting a room file still removes
-- the external copy, including when credentials or network are temporarily
-- unavailable.
CREATE TABLE IF NOT EXISTS ai_file_search_cleanup (
  id BIGSERIAL PRIMARY KEY,
  store_name TEXT NOT NULL UNIQUE,
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_until TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION enqueue_ai_file_search_cleanup() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO ai_file_search_cleanup(store_name) VALUES(OLD.store_name)
  ON CONFLICT(store_name) DO NOTHING;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ai_file_search_store_cleanup ON ai_file_search_stores;
CREATE TRIGGER ai_file_search_store_cleanup AFTER DELETE ON ai_file_search_stores
FOR EACH ROW EXECUTE FUNCTION enqueue_ai_file_search_cleanup();

CREATE TABLE IF NOT EXISTS ai_personal_document_search_stores (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES personal_study_documents(id) ON DELETE CASCADE,
  store_name TEXT NOT NULL UNIQUE,
  document_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(user_id, document_id)
);

DROP TRIGGER IF EXISTS ai_personal_document_store_cleanup ON ai_personal_document_search_stores;
CREATE TRIGGER ai_personal_document_store_cleanup AFTER DELETE ON ai_personal_document_search_stores
FOR EACH ROW EXECUTE FUNCTION enqueue_ai_file_search_cleanup();

-- Nearby data is never kept in the shared room history. Only a private,
-- idempotent focus summary is uploaded when an account reconnects.
CREATE TABLE IF NOT EXISTS nearby_summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_session_id TEXT NOT NULL,
  focused_seconds INTEGER NOT NULL CHECK (focused_seconds >= 0),
  completed_cycles INTEGER NOT NULL CHECK (completed_cycles >= 0),
  ended_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, client_session_id)
);

-- V3: optional school verification and university communities.
ALTER TABLE email_tokens ADD COLUMN IF NOT EXISTS target_email TEXT;
UPDATE email_tokens SET target_email=users.email FROM users WHERE email_tokens.user_id=users.id AND email_tokens.target_email IS NULL;
ALTER TABLE email_tokens DROP CONSTRAINT IF EXISTS email_tokens_purpose_check;
ALTER TABLE email_tokens ADD CONSTRAINT email_tokens_purpose_check CHECK (purpose IN ('verify', 'reset', 'school_verify'));

CREATE TABLE IF NOT EXISTS institutions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS institution_domains (
  domain TEXT PRIMARY KEY,
  institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  added_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_school_emails (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  domain TEXT NOT NULL REFERENCES institution_domains(domain),
  institution_id UUID NOT NULL REFERENCES institutions(id),
  verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS communities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id UUID NOT NULL UNIQUE REFERENCES institutions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS community_members (
  community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  verification_method TEXT NOT NULL CHECK (verification_method IN ('school_email', 'member_invite')),
  invited_by UUID REFERENCES users(id),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(community_id, user_id)
);

CREATE TABLE IF NOT EXISTS community_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  invited_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invited_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(community_id, invited_user_id)
);

-- AI calls are recorded by opaque request ID for a per-accounting-period
-- cutoff. Prompts and generated document contents are deliberately not stored.
CREATE TABLE IF NOT EXISTS ai_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL UNIQUE,
  operation TEXT NOT NULL CHECK (operation IN ('assistant', 'quiz', 'study_plan', 'semantic_search', 'index_material')),
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_usd NUMERIC(12,8) NOT NULL DEFAULT 0 CHECK (estimated_usd >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ai_usage_period_idx ON ai_usage(created_at);

CREATE INDEX IF NOT EXISTS rooms_discovery_idx ON rooms(status, access_type, created_at DESC);
CREATE INDEX IF NOT EXISTS rooms_schedule_idx ON rooms(scheduled_at) WHERE scheduled_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS room_occurrences_schedule_idx ON room_occurrences(starts_at) WHERE status='scheduled';
CREATE INDEX IF NOT EXISTS occurrence_rsvps_reminder_idx ON occurrence_rsvps(reminder_enabled,reminder_sent_at);
CREATE INDEX IF NOT EXISTS room_messages_recent_idx ON room_messages(room_id, created_at DESC);
CREATE INDEX IF NOT EXISTS direct_messages_recent_idx ON direct_messages(request_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications(user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS room_message_client_mutation_idx ON room_messages(sender_id, client_mutation_id) WHERE client_mutation_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS direct_message_client_mutation_idx ON direct_messages(sender_id, client_mutation_id) WHERE client_mutation_id IS NOT NULL;
