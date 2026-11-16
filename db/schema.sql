-- TSBA preview schema. Plain PostgreSQL (no pgvector required).
-- Applied by `npm run migrate`. Idempotent.
--
-- Embeddings are stored as a float array (`real[]`) and cosine similarity is
-- computed in the application layer (see backend/src/retrieval.ts). This keeps
-- the setup to a stock PostgreSQL install — no extension to build on Windows.

-- Who can sign in to the admin panel. Exactly one role per user; permissions are
-- derived from the role in shared code. `password_hash` is scrypt: `salt:hash`
-- (both hex) — never a plaintext password. The first admin is seeded from
-- ADMIN_EMAIL / ADMIN_PASSWORD on startup.
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin', 'manager', 'viewer')),
  password_hash TEXT NOT NULL,
  disabled      BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS users_email_idx ON users (lower(email));

-- The knowledge base: verified rules + manufacturer answers.
-- `embedding` is filled inline on ingest (dim matches EMBEDDING_DIM, default 1024).
CREATE TABLE IF NOT EXISTS knowledge_entries (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('rule', 'maker')),
  brand       TEXT NOT NULL DEFAULT 'All',
  model       TEXT NOT NULL DEFAULT '',
  topic       TEXT NOT NULL DEFAULT '',
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  source      TEXT NOT NULL,
  confidence  TEXT,                       -- 'high' | 'medium' for maker answers; null for rules
  embedding   real[],                     -- null until embedded; cosine done in-app
  embedded_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Only maker answers are vector-searched, and the set is small, so a plain scan
-- over rows that have an embedding is fast enough. This partial index keeps that
-- "has an embedding" filter cheap.
CREATE INDEX IF NOT EXISTS knowledge_embedded_idx
  ON knowledge_entries (kind) WHERE embedding IS NOT NULL;

-- The approval queue. The brief's three lists (waiting / team / sent) plus 'rejected'
-- are derived from `status`. Server-side so the DB is the source of truth.
CREATE TABLE IF NOT EXISTS drafts (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  question      TEXT NOT NULL,
  audience      TEXT NOT NULL CHECK (audience IN ('customer', 'installer', 'sales')),
  channel       TEXT NOT NULL CHECK (channel  IN ('chat', 'text', 'email')),
  outcome       TEXT NOT NULL CHECK (outcome  IN ('answer', 'handover', 'decline', 'clarify')),
  reply         TEXT NOT NULL,            -- current text (may be edited before approval)
  reply_original TEXT NOT NULL,           -- model's untouched draft
  sources       JSONB NOT NULL DEFAULT '[]',
  note_for_ryan TEXT NOT NULL DEFAULT '',
  team_handover JSONB,                    -- {summary, needed[]} when outcome='handover'
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'sent', 'team', 'rejected')),
  edited        BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS drafts_status_idx ON drafts (status, created_at DESC);

-- Connected external accounts (Google Drive knowledge source + Gmail channel).
-- One row per provider. OAuth tokens are stored ENCRYPTED (AES-256-GCM, keyed off
-- SESSION_SECRET) — never in plaintext. See backend/src/google-oauth.ts.
CREATE TABLE IF NOT EXISTS connections (
  provider          TEXT PRIMARY KEY CHECK (provider IN ('google-drive', 'gmail')),
  account_email     TEXT,
  scopes            JSONB NOT NULL DEFAULT '[]',
  access_token_enc  TEXT NOT NULL,
  refresh_token_enc TEXT NOT NULL DEFAULT '',
  expires_at        TIMESTAMPTZ NOT NULL,
  connected_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Documents ingested from a connected source (currently Google Drive). The
-- extracted text is chunked into knowledge_entries with ids `drive:<id>:<n>`
-- (kind 'maker'); this table is the catalogue + ingest status for the admin UI.
-- Removing a row also deletes its chunks (handled in the app, by id prefix).
CREATE TABLE IF NOT EXISTS documents (
  id           TEXT PRIMARY KEY,          -- the Drive file id
  source       TEXT NOT NULL DEFAULT 'google-drive',
  title        TEXT NOT NULL,
  mime_type    TEXT NOT NULL,
  web_url      TEXT,
  chunk_count  INTEGER NOT NULL DEFAULT 0,
  byte_size    BIGINT,
  status       TEXT NOT NULL DEFAULT 'ingested' CHECK (status IN ('ingested', 'skipped', 'failed')),
  ingested_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Drive folders selected as knowledge-base sources. Adding or syncing one
-- ingests its supported files (recursively when `recursive`). The ingested
-- files themselves are tracked per-document in `documents`.
CREATE TABLE IF NOT EXISTS drive_folders (
  id              TEXT PRIMARY KEY,        -- the Drive folder id
  name            TEXT NOT NULL,
  web_url         TEXT,
  recursive       BOOLEAN NOT NULL DEFAULT true,
  added_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_synced_at  TIMESTAMPTZ,
  last_file_count INTEGER
);

-- ─── Solar monitoring: persisted snapshots of live provider-API data ──────────
-- Solar data is otherwise a live pass-through (fetched on demand, never stored).
-- A background recorder (backend/src/solar-recorder.ts) writes a periodic
-- snapshot of every station and a fleet aggregate, so: (1) the dashboard can
-- fall back to the last-known reading when a provider API is unreachable, and
-- (2) historical trends (e.g. monthly production) can be charted — including for
-- providers whose own API exposes no history (Sigenergy/Sungrow), because the
-- trend is derived from our stored total-energy series rather than theirs.

-- One row per station per capture. total_kwh is the station's lifetime energy;
-- monthly production for a trend is the delta of total_kwh across the period.
CREATE TABLE IF NOT EXISTS solar_station_readings (
  id              BIGSERIAL PRIMARY KEY,
  provider        TEXT NOT NULL,             -- provider id, e.g. 'deye'
  station_id      TEXT NOT NULL,             -- provider-local station id
  name            TEXT NOT NULL,
  status          TEXT NOT NULL,             -- online | waiting | partial | offline | unknown
  current_power_w   DOUBLE PRECISION,
  daily_kwh         DOUBLE PRECISION,
  monthly_kwh       DOUBLE PRECISION,
  total_kwh         DOUBLE PRECISION,
  capacity_kw       DOUBLE PRECISION,
  battery_soc       DOUBLE PRECISION,
  location        TEXT,
  captured_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_solar_station_readings_lookup
  ON solar_station_readings (provider, station_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_solar_station_readings_time
  ON solar_station_readings (captured_at DESC);

-- One row per capture: fleet-wide aggregate (powers the dashboard trend cheaply
-- without scanning the per-station table).
CREATE TABLE IF NOT EXISTS solar_fleet_readings (
  id                 BIGSERIAL PRIMARY KEY,
  systems            INTEGER NOT NULL,
  online             INTEGER NOT NULL DEFAULT 0,
  waiting            INTEGER NOT NULL DEFAULT 0,
  partial            INTEGER NOT NULL DEFAULT 0,
  offline            INTEGER NOT NULL DEFAULT 0,
  total_power_w      DOUBLE PRECISION,
  total_daily_kwh    DOUBLE PRECISION,
  total_energy_kwh   DOUBLE PRECISION,       -- sum of station lifetime totals
  total_capacity_kw  DOUBLE PRECISION,
  total_devices      INTEGER,
  online_devices     INTEGER,
  captured_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_solar_fleet_readings_time
  ON solar_fleet_readings (captured_at DESC);

-- ─── Generic application settings (admin-editable, JSON per key) ─────────────
-- Currently holds the solar alert-monitor configuration under key 'solar_alerts'
-- (see backend/src/solar-alert-settings.ts). Kept generic so other admin-tunable
-- settings can reuse it without a migration.
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Sales follow-up agent (Keepwarm) ────────────────────────────────────────
-- Reps voice-note client meetings, set a follow-up rhythm, and approve every
-- AI-drafted text. A rep only ever sees their own rows (user_id).
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'manager', 'viewer', 'rep'));

-- One per rep: who is texting, how they sound, and what the AI understood of
-- their business. `understood` is the AI's play-back the rep confirmed.
CREATE TABLE IF NOT EXISTS kw_profiles (
  user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  company      TEXT NOT NULL DEFAULT 'TSBA',
  sign_off     TEXT NOT NULL,
  about        TEXT NOT NULL DEFAULT '',
  understood   JSONB NOT NULL DEFAULT '{}'::jsonb,
  tone         TEXT NOT NULL DEFAULT 'friendly' CHECK (tone IN ('relaxed', 'friendly', 'direct')),
  send_time    TEXT NOT NULL DEFAULT '09:00',
  timezone     TEXT NOT NULL DEFAULT 'Australia/Sydney',
  sms_from     TEXT NOT NULL DEFAULT '',
  targets      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A rep's client. `notes` = [{id, cat, text}] sorted by the AI into
-- want / situation / decides / personal / promised. cadence_days NULL = no rhythm.
CREATE TABLE IF NOT EXISTS kw_clients (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  phone           TEXT NOT NULL DEFAULT '',
  phone_norm      TEXT NOT NULL DEFAULT '',
  email           TEXT NOT NULL DEFAULT '',
  stage           TEXT NOT NULL DEFAULT '',
  notes           JSONB NOT NULL DEFAULT '[]'::jsonb,
  transcripts     JSONB NOT NULL DEFAULT '[]'::jsonb,
  cadence_days    INT,
  mix             TEXT NOT NULL DEFAULT 'business' CHECK (mix IN ('business', 'friendly', 'mix')),
  next_type       TEXT NOT NULL DEFAULT 'business' CHECK (next_type IN ('business', 'friendly')),
  send_time       TEXT,
  next_due        DATE,
  paused          BOOLEAN NOT NULL DEFAULT false,
  opted_out_at    TIMESTAMPTZ,
  last_contact_at TIMESTAMPTZ,
  last_reply_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Deal pipeline (worked by the pipeline agent). `stage` above stays as the
-- free-text label from voice notes; deal_stage is the structured stage.
ALTER TABLE kw_clients ADD COLUMN IF NOT EXISTS deal_stage TEXT NOT NULL DEFAULT 'lead'
  CHECK (deal_stage IN ('lead', 'contacted', 'meeting', 'quoted', 'negotiating', 'won', 'lost'));
ALTER TABLE kw_clients ADD COLUMN IF NOT EXISTS deal_value NUMERIC;
ALTER TABLE kw_clients ADD COLUMN IF NOT EXISTS stage_changed_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE kw_clients ADD COLUMN IF NOT EXISTS expected_close DATE;
ALTER TABLE kw_clients ADD COLUMN IF NOT EXISTS lost_reason TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS kw_clients_user_idx ON kw_clients (user_id);
CREATE INDEX IF NOT EXISTS kw_clients_phone_idx ON kw_clients (phone_norm);

-- Every text, both directions. Outbound life-cycle:
-- draft → (rep approves) → scheduled → sent | failed ; or skipped / held.
-- `held` = a client replied after approval, so it was never sent.
CREATE TABLE IF NOT EXISTS kw_messages (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id     TEXT NOT NULL REFERENCES kw_clients(id) ON DELETE CASCADE,
  direction     TEXT NOT NULL CHECK (direction IN ('out', 'in')),
  kind          TEXT NOT NULL DEFAULT 'due' CHECK (kind IN ('due', 'reply', 'new', 'adhoc', 'inbound')),
  type          TEXT NOT NULL DEFAULT 'business' CHECK (type IN ('business', 'friendly')),
  status        TEXT NOT NULL CHECK (status IN ('draft', 'scheduled', 'sent', 'failed', 'skipped', 'held', 'received')),
  body          TEXT NOT NULL DEFAULT '',
  ai_body       TEXT NOT NULL DEFAULT '',
  used_notes    JSONB NOT NULL DEFAULT '[]'::jsonb,
  approved_at   TIMESTAMPTZ,
  scheduled_for TIMESTAMPTZ,
  sent_at       TIMESTAMPTZ,
  provider_id   TEXT,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kw_messages_client_idx ON kw_messages (client_id, created_at);
CREATE INDEX IF NOT EXISTS kw_messages_status_idx ON kw_messages (status, scheduled_for);

-- "Stop means stop, forever": a number that opted out is never texted again,
-- even if a rep re-adds the contact later.
CREATE TABLE IF NOT EXISTS kw_optouts (
  phone_norm TEXT PRIMARY KEY,
  source     TEXT NOT NULL DEFAULT 'sms',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Hand-logged scoreboard inputs (calls, conversations, meetings, proposals,
-- revenue). Follow-ups and pipeline additions are derived, never logged here.
CREATE TABLE IF NOT EXISTS kw_score_events (
  id         BIGSERIAL PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day        DATE NOT NULL,
  metric     TEXT NOT NULL CHECK (metric IN ('calls', 'convos', 'booked', 'attended', 'proposals', 'revenue')),
  value      NUMERIC NOT NULL,
  source     TEXT NOT NULL DEFAULT 'tap',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kw_score_user_day_idx ON kw_score_events (user_id, day);

-- The pipeline agent's to-do list for each rep. One open task per client+kind.
CREATE TABLE IF NOT EXISTS kw_agent_tasks (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id   TEXT NOT NULL REFERENCES kw_clients(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('move_stage', 'chase', 'call', 'log_outcome', 'set_rhythm', 'add_value', 'close_lost')),
  title       TEXT NOT NULL,
  reason      TEXT NOT NULL DEFAULT '',
  priority    INT NOT NULL DEFAULT 2,
  payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'dismissed')),
  snooze_until TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS kw_agent_tasks_open_uq ON kw_agent_tasks (client_id, kind) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS kw_agent_tasks_user_idx ON kw_agent_tasks (user_id, status);

-- Audit trail: everything the agent and the rep did to a deal, newest first.
-- `undo` holds what to restore for agent changes the rep can take back.
CREATE TABLE IF NOT EXISTS kw_activity (
  id         BIGSERIAL PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id  TEXT REFERENCES kw_clients(id) ON DELETE CASCADE,
  actor      TEXT NOT NULL CHECK (actor IN ('agent', 'rep')),
  action     TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT '',
  undo       JSONB,
  undone_at  TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kw_activity_user_idx ON kw_activity (user_id, created_at DESC);

-- AI-led conversations with human takeover (Sales settings → auto-replies, off
-- by default). `convo` says who answers the client's next message:
--   idle  = no live conversation (the agent may pick it up if auto-replies are on)
--   agent = the agent is answering routine messages itself
--   rep   = a human took over; the agent only drafts until the rep hands back
ALTER TABLE kw_clients ADD COLUMN IF NOT EXISTS convo TEXT NOT NULL DEFAULT 'idle' CHECK (convo IN ('idle', 'agent', 'rep'));
ALTER TABLE kw_clients ADD COLUMN IF NOT EXISTS convo_since TIMESTAMPTZ;
ALTER TABLE kw_clients ADD COLUMN IF NOT EXISTS convo_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE kw_clients ADD COLUMN IF NOT EXISTS rep_typing_at TIMESTAMPTZ;
-- Who sent an outbound text: the rep (approved it) or the agent (auto-reply).
ALTER TABLE kw_messages ADD COLUMN IF NOT EXISTS sent_by TEXT NOT NULL DEFAULT 'rep' CHECK (sent_by IN ('rep', 'agent'));
ALTER TABLE kw_agent_tasks DROP CONSTRAINT IF EXISTS kw_agent_tasks_kind_check;
ALTER TABLE kw_agent_tasks ADD CONSTRAINT kw_agent_tasks_kind_check
  CHECK (kind IN ('move_stage', 'chase', 'call', 'log_outcome', 'set_rhythm', 'add_value', 'close_lost', 'handback'));
