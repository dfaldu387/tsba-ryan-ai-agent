import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { pool } from '../db.js';
import { env } from '../env.js';

// Applies db/schema.sql. Embeddings are a plain real[] column (cosine computed
// in-app), so there is no fixed vector dimension to rewrite here.
const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(here, '../../../db/schema.sql');

async function main(): Promise<void> {
  const sql = readFileSync(schemaPath, 'utf8');
  await pool.query(sql);
  console.log(`Schema applied (embedding dim ${env.embeddingDim}, stored as real[]).`);
  await pool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
