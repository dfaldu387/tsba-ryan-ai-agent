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

// Repo root (where .env lives) — used to anchor on-disk data files.
const repoRoot = envPath ? dirname(envPath) : process.cwd();

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

  // Legacy single-password gate is retired in favour of user accounts, but we
  // keep APP_PASSWORD optional so an existing .env doesn't break on boot.
  appPassword: optional('APP_PASSWORD', ''),
  sessionSecret: required('SESSION_SECRET'),

  // The first admin, seeded on startup if no users exist yet. After first run
  // you can manage users in the admin panel; these can then be removed.
  adminEmail: optional('ADMIN_EMAIL', 'admin@tsba.local'),
  adminPassword: optional('ADMIN_PASSWORD', 'changeme-admin'),
  adminName: optional('ADMIN_NAME', 'TSBA Admin'),

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

  // ─── AI token-usage tracking (hidden, URL-only report) ────────────────────
  // Every Claude call's input/output token counts are appended to USAGE_LOG_FILE.
  // The report lives at /usage?key=<USAGE_TOKEN> — an unlisted page (not in the
  // admin nav) gated purely by this secret token. Leave USAGE_TOKEN blank to
  // disable the page entirely (it 404s). Logging still happens regardless.
  usageToken: process.env.USAGE_TOKEN ?? '',
  usageLogFile: optional('USAGE_LOG_FILE', resolve(repoRoot, 'data/usage.jsonl')),

  // ─── Outbound delivery of approved replies ────────────────────────────────
  // 'console' (default) is a safe dry-run: approved replies are logged, never
  // sent off the box. 'webhook' POSTs the approved reply to DELIVERY_WEBHOOK_URL
  // (an email/WhatsApp/SMS gateway, automation tool, etc.) — the real channel.
  deliveryProvider: optional('DELIVERY_PROVIDER', 'console') as 'console' | 'webhook',
  deliveryWebhookUrl: process.env.DELIVERY_WEBHOOK_URL ?? '',
  // Optional bearer token sent as `Authorization: Bearer <token>` to the webhook.
  deliveryWebhookToken: process.env.DELIVERY_WEBHOOK_TOKEN ?? '',
  deliveryTimeoutMs: Number(optional('DELIVERY_TIMEOUT_MS', '10000')),

  // ─── Google OAuth (Drive + Gmail connectors) ──────────────────────────────
  // One OAuth client in Google Cloud serves both connectors (different scopes).
  // Leave blank to run the app with the connectors shown as "not configured".
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
  // Must exactly match an Authorized redirect URI in the Google Cloud console.
  googleRedirectUri: optional(
    'GOOGLE_REDIRECT_URI',
    `http://localhost:${optional('PORT', '8080')}/api/oauth/google/callback`,
  ),
};

/** True once a Google OAuth client is configured — gates the connect buttons. */
export function googleOAuthConfigured(): boolean {
  return Boolean(env.googleClientId && env.googleClientSecret);
}

/** Where to send the browser back to after an OAuth callback. */
export function appWebUrl(): string {
  // Dev: the SPA is on another origin. Prod: same origin, so a relative path.
  return env.isProd ? '' : env.webOrigin;
}

if (env.storage === 'postgres' && !env.databaseUrl) {
  throw new Error('STORAGE=postgres but DATABASE_URL is empty. Set DATABASE_URL, or use STORAGE=memory to run without a database.');
}
