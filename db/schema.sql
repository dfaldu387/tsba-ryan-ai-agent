-- TSBA preview schema. Postgres + pgvector.
-- Applied by `npm run migrate`. Idempotent.

CREATE EXTENSION IF NOT EXISTS vector;

-- The knowledge base: verified rules + manufacturer answers.
-- `embedding` is filled in the background by the pg-boss worker (dim must match EMBEDDING_DIM, default 1024).
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
  embedding   vector(1024),               -- null until the embed job runs
  embedded_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Approximate-nearest-neighbour index for cosine distance over manufacturer answers.
-- (ivfflat needs rows present before it's well-populated; harmless to create early.)
CREATE INDEX IF NOT EXISTS knowledge_embedding_idx
  ON knowledge_entries USING ivfflat (embedding vector_cosine_ops) WITH (lists = 20);

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
