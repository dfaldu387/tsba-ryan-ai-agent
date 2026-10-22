-- Migration 0001 — outbound delivery of approved replies + document text quality.
-- Idempotent: safe to run more than once. Apply after db/schema.sql.
--   psql "$DATABASE_URL" -f db/migrations/0001_delivery_and_text_quality.sql

-- Outbound delivery: where an approved reply is sent, and the dispatch outcome.
ALTER TABLE drafts    ADD COLUMN IF NOT EXISTS recipient    TEXT;   -- email / phone / chat id
ALTER TABLE drafts    ADD COLUMN IF NOT EXISTS delivery     JSONB;  -- {status, channel, detail, at}

-- Quality of a document's extracted text: 'ok' | 'low' | 'corrupted' (needs OCR re-ingest).
ALTER TABLE documents ADD COLUMN IF NOT EXISTS text_quality TEXT;
