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
