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

  // ─── Deye Cloud (solar monitoring) ────────────────────────────────────────
  // Developer-portal app credentials + the Deye Cloud account that owns the
  // stations. The password is stored in plain text here but sent SHA-256-hashed
  // (the API requires the hash). Base URL is regional — EU or US. Leave blank to
  // show the Solar tab as "not configured".
  deyeAppId: process.env.DEYE_APP_ID ?? '',
  deyeAppSecret: process.env.DEYE_APP_SECRET ?? '',
  deyeEmail: process.env.DEYE_EMAIL ?? '',
  deyePassword: process.env.DEYE_PASSWORD ?? '',
  deyeBaseUrl: (optional('DEYE_BASE_URL', 'https://eu1-developer.deyecloud.com')).replace(/\/+$/, ''),
  // Optional: select a business-member/company login when the account has one.
  deyeCompanyId: process.env.DEYE_COMPANY_ID ?? '',

  // ─── GoodWe SEMS (solar monitoring provider) ──────────────────────────────
  // SEMS Portal account login. No app key needed. Region picks the SEMS host
  // (au / eu / us / global). Leave blank to show the provider as not connected.
  goodweEmail: process.env.GOODWE_EMAIL ?? '',
  goodwePassword: process.env.GOODWE_PASSWORD ?? '',
  goodweRegion: optional('GOODWE_REGION', 'global'),

  // ─── Solarman Business (same engine as Deye) ──────────────────────────────
  solarmanAppId: process.env.SOLARMAN_APP_ID ?? '',
  solarmanAppSecret: process.env.SOLARMAN_APP_SECRET ?? '',
  solarmanEmail: process.env.SOLARMAN_EMAIL ?? '',
  solarmanPassword: process.env.SOLARMAN_PASSWORD ?? '',
  solarmanOrgId: process.env.SOLARMAN_ORG_ID ?? '',
  solarmanBaseUrl: optional('SOLARMAN_BASE_URL', 'https://globalapi.solarmanpv.com').replace(/\/+$/, ''),

  // ─── SolisCloud (KeyId/KeySecret, HMAC-SHA1) ──────────────────────────────
  solisKeyId: process.env.SOLIS_KEY_ID ?? '',
  solisKeySecret: process.env.SOLIS_KEY_SECRET ?? '',
  solisBaseUrl: optional('SOLIS_BASE_URL', 'https://www.soliscloud.com:13333').replace(/\/+$/, ''),

  // ─── Growatt (OpenAPI v1 token) ───────────────────────────────────────────
  growattToken: process.env.GROWATT_TOKEN ?? '',
  growattBaseUrl: optional('GROWATT_BASE_URL', 'https://openapi.growatt.com').replace(/\/+$/, ''),

  // ─── Sungrow iSolarCloud (appkey + x-access-key + account) ────────────────
  sungrowAppKey: process.env.SUNGROW_APP_KEY ?? '',
  sungrowSecretKey: process.env.SUNGROW_SECRET_KEY ?? '',
  sungrowEmail: process.env.SUNGROW_EMAIL ?? '',
  sungrowPassword: process.env.SUNGROW_PASSWORD ?? '',
  sungrowBaseUrl: optional('SUNGROW_BASE_URL', 'https://gateway.isolarcloud.com').replace(/\/+$/, ''),

  // ─── Sigenergy (SigenCloud OpenAPI) ───────────────────────────────────────
  // Official developer OpenAPI (replaces the old portal scraper). Account-based
  // auth: the same Sigen account email + password used on the portal. Base URL
  // is regional — openapi-aus for AU/NZ, openapi-eu / openapi-us elsewhere. The
  // email/password fall back to the old SCRAPER_SIGEN_* vars so an existing .env
  // keeps working after the scraper is removed.
  sigenEmail: process.env.SIGEN_EMAIL ?? process.env.SCRAPER_SIGEN_USER ?? '',
  sigenPassword: process.env.SIGEN_PASSWORD ?? process.env.SCRAPER_SIGEN_PASS ?? '',
  sigenBaseUrl: optional('SIGEN_BASE_URL', 'https://openapi-aus.sigencloud.com').replace(/\/+$/, ''),

  // ─── Dyness Open API v1.1 (App ID/Secret, HMAC-SHA1 signed) ───────────────
  // Regional gateway: APAC (AU/NZ/Asia) → https://apacopen-api.dyness.com,
  // Europe → https://open-api.dyness.com. The API lives under /openapi/ems-device.
  dynessAppId: process.env.DYNESS_APP_ID ?? '',
  dynessAppSecret: process.env.DYNESS_APP_SECRET ?? '',
  dynessBaseUrl: optional('DYNESS_BASE_URL', 'https://apacopen-api.dyness.com').replace(/\/+$/, ''),

  // ─── Elekeeper / SAJ eSolar (App ID/Secret, token) — endpoints unverified ─
  elekeeperAppId: process.env.ELEKEEPER_APP_ID ?? '',
  elekeeperAppSecret: process.env.ELEKEEPER_APP_SECRET ?? '',
  elekeeperBaseUrl: optional('ELEKEEPER_BASE_URL', 'https://intl-developer.saj-electric.com').replace(/\/+$/, ''),

  // ─── WHES / ECOS Hub — no public API mapped yet ───────────────────────────
  whesBaseUrl: (process.env.WHES_BASE_URL ?? '').replace(/\/+$/, ''),

  // ─── Solar snapshot recorder ──────────────────────────────────────────────
  // How often to persist a fleet snapshot (station readings + aggregate) to the
  // database, in minutes. 0 disables the recorder. Readings older than the
  // retention window are pruned. Storage must be 'postgres' for durability; in
  // 'memory' mode the recorder still runs but history is lost on restart.
  solarSnapshotIntervalMin: Number(optional('SOLAR_SNAPSHOT_INTERVAL_MIN', '15')),
  solarRetentionDays: Number(optional('SOLAR_RETENTION_DAYS', '400')),
};

/** True once Deye Cloud credentials are configured — gates the Deye provider. */
export function deyeConfigured(): boolean {
  return Boolean(env.deyeAppId && env.deyeAppSecret && env.deyeEmail && env.deyePassword);
}

/** True once GoodWe SEMS credentials are configured — gates the GoodWe provider. */
export function goodweConfigured(): boolean {
  return Boolean(env.goodweEmail && env.goodwePassword);
}

export function solarmanConfigured(): boolean {
  return Boolean(env.solarmanAppId && env.solarmanAppSecret && env.solarmanEmail && env.solarmanPassword);
}
export function solisConfigured(): boolean {
  return Boolean(env.solisKeyId && env.solisKeySecret);
}
export function growattConfigured(): boolean {
  return Boolean(env.growattToken);
}
export function sungrowConfigured(): boolean {
  return Boolean(env.sungrowAppKey && env.sungrowSecretKey && env.sungrowEmail && env.sungrowPassword);
}
export function dynessConfigured(): boolean {
  return Boolean(env.dynessAppId && env.dynessAppSecret);
}
/** True once Sigenergy OpenAPI credentials are configured — gates the Sigen provider. */
export function sigenConfigured(): boolean {
  return Boolean(env.sigenEmail && env.sigenPassword);
}
export function elekeeperConfigured(): boolean {
  return Boolean(env.elekeeperAppId && env.elekeeperAppSecret);
}
export function whesConfigured(): boolean {
  return Boolean(env.whesBaseUrl);
}

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
