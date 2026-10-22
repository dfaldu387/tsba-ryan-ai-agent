import type { KnowledgeEntry } from '@tsba/shared';
import { pool, query } from '../db.js';
import { embeddingProvider, entryEmbeddingText } from '../embeddings.js';
import { enqueueEmbedJobs, stopQueue } from '../queue.js';
import { loadKnowledgeEntries } from '../knowledge-data.js';

// Loads the knowledge JSON into Postgres, then either enqueues durable embed
// jobs (default — processed by the running backend's pg-boss worker) or embeds
// inline (`--inline`, handy for a one-shot setup with no server running).
// NOTE: only needed for STORAGE=postgres. In the default memory mode the backend
// loads knowledge straight from the JSON on startup — no ingest step.

async function upsert(e: KnowledgeEntry): Promise<void> {
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

async function embedInline(entries: KnowledgeEntry[]): Promise<void> {
  const vectors = await embeddingProvider.embed(entries.map((e) => entryEmbeddingText(e)));
  for (let i = 0; i < entries.length; i++) {
    await query('UPDATE knowledge_entries SET embedding = $1::real[], embedded_at = now() WHERE id = $2', [
      vectors[i],
      entries[i].id,
    ]);
  }
}

async function main(): Promise<void> {
  const inline = process.argv.includes('--inline');
  const entries = loadKnowledgeEntries();
  for (const e of entries) await upsert(e);
  console.log(`Upserted ${entries.length} knowledge entries (${entries.filter((e) => e.kind === 'rule').length} rules, ${entries.filter((e) => e.kind === 'maker').length} manufacturer answers).`);

  if (inline) {
    await embedInline(entries);
    console.log(`Embedded ${entries.length} entries inline via '${embeddingProvider.name}' provider.`);
  } else {
    await enqueueEmbedJobs(entries.map((e) => e.id));
    console.log(`Enqueued ${entries.length} embed jobs. Start the backend (npm run dev) to process them, or re-run with --inline.`);
    await stopQueue();
  }

  await pool.end();
}

main().catch((err) => {
  console.error('Ingest failed:', err);
  process.exit(1);
});
