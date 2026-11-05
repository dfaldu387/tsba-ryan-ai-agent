import { env, sigenConfigured } from './env.js';

/**
 * Sigenergy SigenCloud OpenAPI client (developer.sigencloud.com → openapi-*.
 * sigencloud.com). Replaces the old portal scraper with the official API.
 *
 * Auth model: POST /openapi/auth/login/password with the Sigen account email +
 * password returns a Bearer access token (~12h). The token is cached in memory
 * and re-minted near expiry or when a call reports an auth error. Every response
 * is the envelope { code, msg, timestamp, data } where code 0 means success;
 * `data` is sometimes a JSON *string* that must be parsed a second time.
 *
 * Rate limits are strict: the system list is capped at once per 5 minutes per
 * account, and per-station summary / energyFlow at once per 5 minutes per
 * station. Callers MUST cache (see sigen-provider.ts); this module is a thin
 * transport that does not cache anything but the token.
 */

const TOKEN_PATH = '/openapi/auth/login/password';
// Re-mint a little before the real expiry to avoid racing the boundary.
const EXPIRY_SKEW_MS = 5 * 60 * 1000;
// Business codes (and HTTP 401) that mean "token invalid/expired" → re-auth once.
// 2090 = "token invalid or expired" (seen with HTTP 424); 401/40001 = unauthorized.
const AUTH_FAIL_CODES = new Set(['11003', '11004', '11005', '401', '40001', '2090']);

export class SigenError extends Error {
  constructor(message: string, public code?: string) {
    super(message);
    this.name = 'SigenError';
  }
}
export class SigenNotConfiguredError extends SigenError {
  constructor() {
    super('sigen_not_configured');
    this.name = 'SigenNotConfiguredError';
  }
}

interface Envelope<T = unknown> {
  code?: string | number;
  msg?: string;
  timestamp?: number;
  data?: T;
}

/** Sigen returns `data` as either an object or a JSON-encoded string. */
function unwrap<T>(data: unknown): T | undefined {
  if (typeof data === 'string') {
    try {
      return JSON.parse(data) as T;
    } catch {
      return undefined;
    }
  }
  return data as T | undefined;
}

const ok = (code: unknown): boolean => String(code) === '0';

interface CachedToken {
  token: string;
  expiresAt: number; // epoch ms
}
let tokenCache: CachedToken | null = null;

/** Acquire a fresh bearer token and cache it. */
async function authenticate(): Promise<string> {
  if (!sigenConfigured()) throw new SigenNotConfiguredError();

  let res: Response;
  try {
    res = await fetch(`${env.sigenBaseUrl}${TOKEN_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: env.sigenEmail, password: env.sigenPassword }),
    });
  } catch (err) {
    throw new SigenError(`sigen_network_error: ${(err as Error).message}`);
  }

  const envelope = (await res.json().catch(() => ({}))) as Envelope;
  const payload = unwrap<{ accessToken?: string; expiresIn?: number; tokenType?: string }>(envelope.data);
  if (!res.ok || !ok(envelope.code) || !payload?.accessToken) {
    throw new SigenError(
      `sigen_auth_failed: ${envelope.msg || `HTTP ${res.status}`}`,
      envelope.code != null ? String(envelope.code) : undefined,
    );
  }

  // expiresIn is in seconds; default to 12h if the field is missing.
  const ttlMs = (Number(payload.expiresIn) || 12 * 3600) * 1000;
  tokenCache = { token: payload.accessToken, expiresAt: Date.now() + ttlMs };
  return payload.accessToken;
}

/** Return a valid cached token, authenticating if needed. */
async function getToken(forceRefresh = false): Promise<string> {
  if (!forceRefresh && tokenCache && tokenCache.expiresAt - EXPIRY_SKEW_MS > Date.now()) {
    return tokenCache.token;
  }
  return authenticate();
}

/**
 * GET a Sigen OpenAPI endpoint with the bearer token. Retries once with a fresh
 * token if the API reports an auth error (HTTP 401 or an auth business code).
 */
async function sigenGet<T>(path: string): Promise<T | undefined> {
  if (!sigenConfigured()) throw new SigenNotConfiguredError();

  const run = async (token: string): Promise<{ res: Response; envelope: Envelope }> => {
    let res: Response;
    try {
      res = await fetch(`${env.sigenBaseUrl}${path}`, {
        headers: { authorization: `Bearer ${token}` },
      });
    } catch (err) {
      throw new SigenError(`sigen_network_error: ${(err as Error).message}`);
    }
    const envelope = (await res.json().catch(() => ({}))) as Envelope;
    return { res, envelope };
  };

  let { res, envelope } = await run(await getToken());

  // Re-auth once on an auth error (HTTP 401 or an auth business code).
  const code = envelope.code != null ? String(envelope.code) : undefined;
  if (res.status === 401 || (code && AUTH_FAIL_CODES.has(code))) {
    ({ res, envelope } = await run(await getToken(true)));
  }

  if (!res.ok || !ok(envelope.code)) {
    throw new SigenError(
      `sigen_request_failed (${path}): ${envelope.msg || `HTTP ${res.status}`}`,
      envelope.code != null ? String(envelope.code) : undefined,
    );
  }
  return unwrap<T>(envelope.data);
}

// ─── Typed shapes (fields are best-effort; the API may omit some) ────────────

export interface SigenSystem {
  systemId: string;
  systemName?: string;
  addr?: string;
  /** e.g. "Normal" / "Disconnection". */
  status?: string;
  isActivate?: boolean;
  /** e.g. "onGrid" / "offGrid". */
  onOffGridStatus?: string;
  timeZone?: string;
  /** Epoch MILLISECONDS. */
  gridConnectedTime?: number;
  /** PV (peak) capacity, kW. */
  pvCapacity?: number;
  /** Battery capacity, kWh. */
  batteryCapacity?: number;
}

export interface SigenSummary {
  dailyPowerGeneration?: number; // kWh
  monthlyPowerGeneration?: number; // kWh
  annualPowerGeneration?: number; // kWh
  lifetimePowerGeneration?: number; // kWh
  lifetimeCo2?: number; // tons
  lifetimeCoal?: number; // tons
  lifetimeTreeEquivalent?: number;
}

export interface SigenEnergyFlow {
  pvPower?: number; // kW
  gridPower?: number; // kW (+ export / − import)
  evPower?: number; // kW
  acPower?: number; // kW
  loadPower?: number; // kW
  heatPumpPower?: number; // kW
  batteryPower?: number; // kW (+ charge / − discharge)
  batterySoc?: number; // %
}

// ─── Endpoint wrappers ───────────────────────────────────────────────────────

/** All power stations under the account's authority. */
export async function listSystems(): Promise<SigenSystem[]> {
  const data = await sigenGet<SigenSystem[]>('/openapi/system');
  return Array.isArray(data) ? data : [];
}

/** Energy totals + emission-reduction summary for one station. */
export async function systemSummary(systemId: string): Promise<SigenSummary> {
  return (await sigenGet<SigenSummary>(`/openapi/systems/${encodeURIComponent(systemId)}/summary`)) ?? {};
}

/** Real-time energy-flow snapshot (PV/grid/battery power + SOC) for one station. */
export async function systemEnergyFlow(systemId: string): Promise<SigenEnergyFlow> {
  return (await sigenGet<SigenEnergyFlow>(`/openapi/systems/${encodeURIComponent(systemId)}/energyFlow`)) ?? {};
}
