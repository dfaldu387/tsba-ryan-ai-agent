import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { pool } from '../db.js';
import { env } from '../env.js';

// Applies db/schema.sql. The vector column dimension is fixed at 1024 in the
// schema; if EMBEDDING_DIM is set to something else we rewrite it on the way in.
const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(here, '../../../db/schema.sql');

async function main(): Promise<void> {
  let sql = readFileSync(schemaPath, 'utf8');
  if (env.embeddingDim !== 1024) {
    sql = sql.replace(/vector\(1024\)/g, `vector(${env.embeddingDim})`);
  }
  await pool.query(sql);
  console.log(`Schema applied (vector dim ${env.embeddingDim}).`);
  await pool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
