import { config } from 'dotenv';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// Load .env from the repository root, wherever the process was started from.
function findEnv(): string | undefined {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = resolve(dir, '.env');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

const envPath = findEnv();
if (envPath) config({ path: envPath });

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}. Copy .env.example to .env and fill it in.`);
  return v;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export const env = {
  port: Number(optional('PORT', '8080')),
  nodeEnv: optional('NODE_ENV', 'development'),
  isProd: optional('NODE_ENV', 'development') === 'production',

  appPassword: required('APP_PASSWORD'),
  sessionSecret: required('SESSION_SECRET'),

  // 'memory' (default) runs with no database at all; 'postgres' uses Postgres + pgvector + pg-boss.
  storage: optional('STORAGE', 'memory') as 'memory' | 'postgres',
  databaseUrl: process.env.DATABASE_URL ?? '',

  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  anthropicModel: optional('ANTHROPIC_MODEL', 'claude-sonnet-5-5'),

  embeddingProvider: optional('EMBEDDING_PROVIDER', 'local') as 'local' | 'voyage' | 'openai',
  embeddingDim: Number(optional('EMBEDDING_DIM', '1024')),
  voyageApiKey: process.env.VOYAGE_API_KEY ?? '',
  voyageModel: optional('VOYAGE_MODEL', 'voyage-3.5'),
  openaiApiKey: process.env.OPENAI_API_KEY ?? '',
  openaiEmbeddingModel: optional('OPENAI_EMBEDDING_MODEL', 'text-embedding-3-small'),

  retrievalTopK: Number(optional('RETRIEVAL_TOP_K', '8')),
  webOrigin: optional('WEB_ORIGIN', 'http://localhost:5173'),
};

if (env.storage === 'postgres' && !env.databaseUrl) {
  throw new Error('STORAGE=postgres but DATABASE_URL is empty. Set DATABASE_URL, or use STORAGE=memory to run without a database.');
}
