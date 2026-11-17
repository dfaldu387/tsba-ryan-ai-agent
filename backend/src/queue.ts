import PgBoss from 'pg-boss';
import { env } from './env.js';
import { query } from './db.js';
import { embeddingProvider, entryEmbeddingText } from './embeddings.js';

// Durable background jobs, backed by the same Postgres (pg-boss creates its own schema).
// The embedding backfill runs here so ingest can return immediately and embeddings
// fill in asynchronously — the "background jobs + durable queue" piece of the stack.

export const EMBED_ENTRY = 'embed-entry';

let boss: PgBoss | null = null;
let starting: Promise<PgBoss> | null = null;

export function startQueue(): Promise<PgBoss> {
  // Share one start: callers (enqueue during ingest) must not use the queue
  // before start() has resolved.
  starting ??= (async () => {
    const b = new PgBoss({ connectionString: env.databaseUrl });
    b.on('error', (err) => console.error('[pg-boss]', err));
    await b.start();
    await b.createQueue(EMBED_ENTRY);

    // One job per batch: a single bad entry fails (and retries) only itself,
    // not the nine healthy jobs that happened to share its batch.
    await b.work<{ id: string }>(EMBED_ENTRY, { batchSize: 1 }, async (jobs) => {
      for (const job of jobs) await embedEntry(job.data.id);
    });

    boss = b;
    console.log('[pg-boss] queue started, worker listening on', EMBED_ENTRY);
    return b;
  })().catch((err) => {
    starting = null; // allow a later retry
    throw err;
  });
  return starting;
}

async function embedEntry(id: string): Promise<void> {
  const res = await query<{
    id: string;
    brand: string;
    model: string;
    topic: string;
    title: string;
    body: string;
  }>('SELECT id, brand, model, topic, title, body FROM knowledge_entries WHERE id = $1', [id]);
  const row = res.rows[0];
  if (!row) return;

  const [vec] = await embeddingProvider.embed([entryEmbeddingText({ ...row, text: row.body })]);
  await query('UPDATE knowledge_entries SET embedding = $1::real[], embedded_at = now() WHERE id = $2', [
    vec,
    id,
  ]);
}

/** Enqueue one embed job per entry id. Used by the ingest script. */
export async function enqueueEmbedJobs(ids: string[]): Promise<void> {
  const b = await startQueue();
  await Promise.all(ids.map((id) => b.send(EMBED_ENTRY, { id })));
}

export async function stopQueue(): Promise<void> {
  if (boss) await boss.stop({ graceful: true });
  boss = null;
  starting = null;
}
