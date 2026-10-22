import pg from 'pg';
import { env } from './env.js';

// Plain PostgreSQL (no pgvector). Embeddings live in a `real[]` column, which
// node-pg parses to/from a JS number[] automatically — no custom codec needed.
export const pool = new pg.Pool({ connectionString: env.databaseUrl, max: 10 });

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params as never);
}

export async function closePool(): Promise<void> {
  await pool.end();
}
