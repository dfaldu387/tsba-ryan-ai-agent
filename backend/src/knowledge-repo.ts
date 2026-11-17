import type { KnowledgeEntry } from '@tsba/shared';
import { query, withTransaction } from './db.js';
import { likePrefix } from './sql-like.js';
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


/**
 * Replace a document's chunks atomically. Embeddings are computed BEFORE the
 * transaction (a slow/failed embedding call must not hold locks or leave the
 * document half-replaced); the delete and the insert then commit together, so
 * retrieval sees either the old chunks or the new ones, never a gap.
 */
export async function replaceEntriesByPrefix(idPrefix: string, entries: KnowledgeEntry[]): Promise<void> {
  if (!idPrefix) throw new Error('replaceEntriesByPrefix: empty prefix');
  const vectors = entries.length ? await embeddingProvider.embed(entries.map((e) => entryEmbeddingText(e))) : [];
  await withTransaction(async (q) => {
    await q(String.raw`DELETE FROM knowledge_entries WHERE id LIKE $1 ESCAPE '\'`, [likePrefix(idPrefix)]);
    if (!entries.length) return;
    const COLS = 10;
    const values: unknown[] = [];
    const tuples = entries.map((e, i) => {
      values.push(e.id, e.kind, e.brand || 'All', e.model || '', e.topic || '', e.title, e.text, e.source, e.confidence ?? null, vectors[i]);
      const b = i * COLS;
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10}::real[], now())`;
    });
    await q(
      `INSERT INTO knowledge_entries (id, kind, brand, model, topic, title, body, source, confidence, embedding, embedded_at)
       VALUES ${tuples.join(',')}
       ON CONFLICT (id) DO UPDATE SET
         kind=EXCLUDED.kind, brand=EXCLUDED.brand, model=EXCLUDED.model, topic=EXCLUDED.topic,
         title=EXCLUDED.title, body=EXCLUDED.body, source=EXCLUDED.source, confidence=EXCLUDED.confidence,
         embedding=EXCLUDED.embedding, embedded_at=EXCLUDED.embedded_at`,
      values,
    );
  });
}

export async function removeEntriesByPrefix(idPrefix: string): Promise<void> {
  if (!idPrefix) return; // an empty prefix would match every entry
  await query(String.raw`DELETE FROM knowledge_entries WHERE id LIKE $1 ESCAPE '\'`, [likePrefix(idPrefix)]);
}

export async function getEntryTextByPrefix(idPrefix: string): Promise<string> {
  // Chunk ids end in ":<n>" — order numerically so chunk 10 follows 9, not 1.
  const res = await query<{ body: string }>(
    String.raw`SELECT body FROM knowledge_entries WHERE id LIKE $1 ESCAPE '\'
      ORDER BY NULLIF(substring(id from ':(\d+)$'), '')::int NULLS LAST, id`,
    [likePrefix(idPrefix)],
  );
  return res.rows.map((r) => r.body).join('\n');
}
