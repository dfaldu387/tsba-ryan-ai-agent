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
