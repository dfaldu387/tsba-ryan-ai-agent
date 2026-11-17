import pg from 'pg';
import { env } from './env.js';

// Plain PostgreSQL (no pgvector). Embeddings live in a `real[]` column, which
// node-pg parses to/from a JS number[] automatically — no custom codec needed.
export const pool = new pg.Pool({ connectionString: env.databaseUrl, max: 10 });
// An idle client losing its connection (DB restart, network blip) emits 'error'
// on the pool; without a listener that would be an uncaught exception.
pool.on('error', (err) => console.error('[db] idle client error:', err.message));

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params as never);
}

let closing: Promise<void> | null = null;
export function closePool(): Promise<void> {
  closing ??= pool.end(); // idempotent: a second shutdown signal mustn't end the pool twice
  return closing;
}

/**
 * Run `fn` inside BEGIN/COMMIT on one pooled client (ROLLBACK on any error), so
 * multi-statement writes land together or not at all.
 */
export type TxQuery = <R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params?: unknown[]) => Promise<pg.QueryResult<R>>;

export async function withTransaction<T>(fn: (q: TxQuery) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn((text, params) => client.query(text, params as never));
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
