import pg from 'pg';
import { env } from './env.js';

// pgvector returns `vector` columns as a string like "[0.1,0.2,...]".
// We mostly write embeddings, not read them, so the default text parse is fine.
export const pool = new pg.Pool({ connectionString: env.databaseUrl, max: 10 });

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params as never);
}

/** Format a number[] as a pgvector literal, e.g. '[0.1,0.2]'. */
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(',')}]`;
}

export async function closePool(): Promise<void> {
  await pool.end();
}
