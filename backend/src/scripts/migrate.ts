import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { pool } from '../db.js';
import { env } from '../env.js';

// Applies db/schema.sql (idempotent), then any db/migrations/*.sql not yet
// recorded in schema_migrations, in name order — each in its own transaction.
// (Migrations used to be applied by hand; now `npm run migrate` does it.)
// Embeddings are a plain real[] column (cosine computed in-app), so there is no
// fixed vector dimension to rewrite here.
const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(here, '../../../db/schema.sql');
const migrationsDir = resolve(here, '../../../db/migrations');

async function main(): Promise<void> {
  const sql = readFileSync(schemaPath, 'utf8');
  await pool.query(sql);
  console.log(`Schema applied (embedding dim ${env.embeddingDim}, stored as real[]).`);

  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const done = new Set((await pool.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const files = existsSync(migrationsDir) ? readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort() : [];
  for (const f of files) {
    if (done.has(f)) continue;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(readFileSync(resolve(migrationsDir, f), 'utf8'));
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
      await client.query('COMMIT');
      console.log(`Migration applied: ${f}`);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw new Error(`migration ${f} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }
  await pool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
