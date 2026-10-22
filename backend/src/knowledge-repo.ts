import type { KnowledgeEntry } from '@tsba/shared';
import { query } from './db.js';
import { embeddingProvider, entryEmbeddingText } from './embeddings.js';

// Runtime writes to knowledge_entries (used by Drive ingestion). Mirrors the
// upsert in scripts/ingest.ts but embeds inline so the chunks are immediately
// retrievable by the vector search in retrieval.ts.

export async function addEntries(entries: KnowledgeEntry[]): Promise<void> {
  if (!entries.length) return;
  for (const e of entries) {
    await query(
      `INSERT INTO knowledge_entries (id, kind, brand, model, topic, title, body, source, confidence)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO UPDATE SET
         kind=EXCLUDED.kind, brand=EXCLUDED.brand, model=EXCLUDED.model, topic=EXCLUDED.topic,
         title=EXCLUDED.title, body=EXCLUDED.body, source=EXCLUDED.source, confidence=EXCLUDED.confidence,
         embedding=NULL, embedded_at=NULL`,
      [e.id, e.kind, e.brand || 'All', e.model || '', e.topic || '', e.title, e.text, e.source, e.confidence ?? null],
    );
  }
  const vectors = await embeddingProvider.embed(entries.map((e) => entryEmbeddingText(e)));
  for (let i = 0; i < entries.length; i++) {
    // node-pg encodes a number[] as a Postgres array literal for the real[] column.
    await query('UPDATE knowledge_entries SET embedding = $1::real[], embedded_at = now() WHERE id = $2', [
      vectors[i],
      entries[i].id,
    ]);
  }
}

export async function removeEntriesByPrefix(idPrefix: string): Promise<void> {
  await query('DELETE FROM knowledge_entries WHERE id LIKE $1', [`${idPrefix}%`]);
}

export async function getEntryTextByPrefix(idPrefix: string): Promise<string> {
  const res = await query<{ body: string }>(
    `SELECT body FROM knowledge_entries WHERE id LIKE $1 ORDER BY id`,
    [`${idPrefix}%`],
  );
  return res.rows.map((r) => r.body).join('\n');
}
