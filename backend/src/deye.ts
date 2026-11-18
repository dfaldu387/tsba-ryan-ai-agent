import { createHash } from 'node:crypto';
import { env, deyeConfigured } from './env.js';
import { isBackground } from './providers/priority.js';

/**
 * Minimal Deye Cloud (developer.deyecloud.com) client.
 *
 * Auth model: POST /v1.0/account/token with the app secret + account email and
 * the SHA-256 hex of the password. The returned bearer token is long-lived
 * (~60 days) so we cache it in memory and only re-auth when it's near expiry or
 * the API reports an invalid-token error (Deye returns that with HTTP 200 and
 * success:false, not a 401).
 */

const TOKEN_PATH = '/v1.0/account/token';
// Refresh a bit before the real expiry to avoid racing the boundary.
const EXPIRY_SKEW_MS = 5 * 60 * 1000;
// Deye's own "invalid/expired token" business code (returned with success:false).
const INVALID_TOKEN_CODES = new Set(['2101019']);

export class DeyeError extends Error {
  constructor(message: string, public code?: string) {
    super(message);
    this.name = 'DeyeError';
  }
}
export class DeyeNotConfiguredError extends DeyeError {
  constructor() {
    super('deye_not_configured');
    this.name = 'DeyeNotConfiguredError';
  }
}

interface Envelope {
  requestId?: string;
  success?: boolean;
  code?: string | number;
  msg?: string;
  [k: string]: unknown;
}

// ─── Request queue ───────────────────────────────────────────────────────────
// Deye rejects ANY concurrent requests from an account with "too many requests"
// (measured: 12/12 sequential calls succeed at ~3/s; 0/12 succeed at 2-wide
// concurrency), and token minting is limited the same way. Before this queue,
// the fleet energy scan (3 history calls × every plant) collided with the plant
// page's detail calls, whose failures were swallowed into empty devices/power.
// So every Deye HTTP call goes through one serial lane, with interactive calls
// (plant detail) jumping ahead of background ones (energy totals), and
// rate-limit rejections retried with backoff.
//
// Deye ALSO enforces a rolling request quota (measured 2026-11-18: ~40 calls in
// ~20s, then every call rejected). Retrying each rejected call while the rest of
// the queue kept firing meant the account never recovered — every plant page
// then took 10–15s and came back empty. So a rate-limit rejection now PAUSES THE
// WHOLE LANE (2s, doubling to 60s, reset on the next success), and background
// calls are paced more slowly to leave headroom for interactive ones.
type Job = () => void;
const lane: { hi: Job[]; lo: Job[] } = { hi: [], lo: [] };
let laneBusy = false;
const MIN_GAP_MS = 120; // after an interactive (plant page) call
const LO_GAP_MS = 450; // after a background call (~2/s max)
const COOLDOWN_START_MS = 2_000;
const COOLDOWN_MAX_MS = 60_000;
const DEYE_CALL_TIMEOUT_MS = 20_000;
let cooldownUntil = 0;
let cooldownMs = 0;
let cooldownTimer: NodeJS.Timeout | null = null;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function pump(): void {
  if (laneBusy) return;
  const wait = cooldownUntil - Date.now();
  if (wait > 0) {
    // Account is rate-limited: hold every queued call until the pause ends.
    if (!cooldownTimer) {
      cooldownTimer = setTimeout(() => {
        cooldownTimer = null;
        pump();
      }, wait);
      cooldownTimer.unref?.();
    }
    return;
  }
  const job = lane.hi.shift() ?? lane.lo.shift();
  if (!job) return;
  laneBusy = true;
  job();
}

/** Run `fn` alone on the Deye lane. `front` puts a retry ahead of its queue. */
function enqueue<T>(fn: () => Promise<T>, low = false, front = false): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const q = low ? lane.lo : lane.hi;
    const job: Job = () => {
      fn().then(resolve, reject).finally(async () => {
        await sleep(low ? LO_GAP_MS : MIN_GAP_MS);
        laneBusy = false;
        pump();
      });
    };
    if (front) q.unshift(job);
    else q.push(job);
    pump();
  });
}

const isRateLimited = (status: number, msg?: string) => status === 429 || /too many/i.test(msg ?? '');

/** Rate-limited: pause the whole lane, doubling the pause on repeated hits. */
function startCooldown(): void {
  cooldownMs = cooldownMs ? Math.min(cooldownMs * 2, COOLDOWN_MAX_MS) : COOLDOWN_START_MS;
  cooldownUntil = Date.now() + cooldownMs;
  console.warn(`[deye] rate-limited — pausing all Deye calls for ${Math.round(cooldownMs / 1000)}s`);
}

/**
 * fetch + JSON on the lane. A rate-limit rejection pauses the lane and the call
 * is retried at the front of its queue once the pause ends (up to 3 times).
 * Calls made inside `inBackground()` (fleet scans) run at low priority.
 */
async function deyeFetch<T>(url: string, init: RequestInit, lowHint = false): Promise<{ res: Response; data: T }> {
  const low = lowHint || isBackground();
  for (let attempt = 0; ; attempt++) {
    const out = await enqueue(async () => {
      // Hard per-call timeout (headers AND body): the lane runs one call at a
      // time, so a single connection Deye holds open without answering would
      // otherwise freeze every Deye call behind it — plant list, plant pages
      // and the alert scan — until the server restarts.
      const signal = AbortSignal.timeout(DEYE_CALL_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetch(url, { ...init, signal });
      } catch (err) {
        throw new DeyeError(`deye_network_error: ${signal.aborted ? `no answer within ${DEYE_CALL_TIMEOUT_MS / 1000}s` : (err as Error).message}`);
      }
      const data = (await res.json().catch(() => ({}))) as T;
      return { res, data };
    }, low, attempt > 0);
    const msg = (out.data as Envelope).msg;
    if (isRateLimited(out.res.status, typeof msg === 'string' ? msg : undefined)) {
      // Starts before the lane's post-call gap ends, so no other call slips out.
      startCooldown();
      // Background scans can afford to wait out the quota (they keep the alert
      // scan's view of Deye faults current); interactive calls give up sooner.
      if (attempt < (low ? 8 : 3)) continue;
      return out;
    }
    cooldownMs = 0; // the account is accepting calls again
    return out;
  }
}

interface CachedToken {
  token: string;
  expiresAt: number; // epoch ms
}
let tokenCache: CachedToken | null = null;

// A Deye account that belongs to a business organization only sees that org's
// stations when its token is minted with the org's `companyId`. A token minted
// WITHOUT a companyId is scoped to the login's personal stations only (e.g. 12
// of an org's 61). We resolve the companyId dynamically via /v1.0/account/info
// (see `resolveCompanyId`) and cache it so it costs one extra call per re-auth,
// not per request. An explicit DEYE_COMPANY_ID overrides the lookup.
let resolvedCompanyId: string | null = null;

const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** Mint a bearer token, optionally scoped to a business organization. */
async function mintToken(companyId?: string): Promise<{ token: string; ttlMs: number }> {
  const url = `${env.deyeBaseUrl}${TOKEN_PATH}?appId=${encodeURIComponent(env.deyeAppId)}`;
  const body: Record<string, unknown> = {
    appSecret: env.deyeAppSecret,
    email: env.deyeEmail,
    password: sha256Hex(env.deyePassword),
  };
  // The API types companyId as an integer; send it as a number when numeric.
  if (companyId) body.companyId = /^\d+$/.test(companyId) ? Number(companyId) : companyId;

  const { res, data } = await deyeFetch<Envelope & { accessToken?: string; expiresIn?: number }>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok || data.success === false || !data.accessToken) {
    throw new DeyeError(
      `deye_auth_failed: ${data.msg || `HTTP ${res.status}`}`,
      data.code != null ? String(data.code) : undefined,
    );
  }
  // expiresIn is in seconds; default to 30 days if the field is missing.
  return { token: data.accessToken, ttlMs: (Number(data.expiresIn) || 30 * 24 * 3600) * 1000 };
}

/**
 * Look up the organization the account belongs to and return its companyId.
 * `/v1.0/account/info` returns `orgInfoList` (business-member list); we take the
 * first org. Returns undefined for a personal account with no org, in which
 * case the personal-scope token is already the correct scope.
 */
async function resolveCompanyId(token: string): Promise<string | undefined> {
  const { data } = await deyeFetch<Envelope & {
    orgInfoList?: Array<{ companyId?: number | string; companyName?: string }>;
  }>(`${env.deyeBaseUrl}/v1.0/account/info`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token}` },
    body: '{}',
  });
  const org = data.orgInfoList?.find((o) => o.companyId != null);
  return org?.companyId != null ? String(org.companyId) : undefined;
}

/** Acquire a fresh bearer token (org-scoped when the account has an org) and cache it. */
async function authenticate(): Promise<string> {
  if (!deyeConfigured()) throw new DeyeNotConfiguredError();

  // Priority: explicit env override → previously resolved org → dynamic lookup.
  let companyId = env.deyeCompanyId || resolvedCompanyId || undefined;

  if (!companyId) {
    // Mint a personal token, then discover the org from /v1.0/account/info.
    const personal = await mintToken();
    companyId = await resolveCompanyId(personal.token).catch(() => undefined);
    if (!companyId) {
      // No org: the personal token is the right (and only) scope.
      tokenCache = { token: personal.token, expiresAt: Date.now() + personal.ttlMs };
      return personal.token;
    }
    resolvedCompanyId = companyId;
  }

  const scoped = await mintToken(companyId);
  tokenCache = { token: scoped.token, expiresAt: Date.now() + scoped.ttlMs };
  return scoped.token;
}

/** Return a valid cached token, authenticating if needed. */
async function getToken(forceRefresh = false): Promise<string> {
  if (!forceRefresh && tokenCache && tokenCache.expiresAt - EXPIRY_SKEW_MS > Date.now()) {
    return tokenCache.token;
  }
  // Share one in-flight login: parallel callers used to each mint a token,
  // which Deye rate-limits ("deye_auth_failed: too many requests").
  authInFlight ??= authenticate().finally(() => { authInFlight = null; });
  return authInFlight;
}
let authInFlight: Promise<string> | null = null;

/**
 * POST a Deye API endpoint with the bearer token. Retries once with a fresh
 * token if the API reports an invalid-token business code.
 */
async function deyePost<T extends Envelope>(path: string, body: Record<string, unknown>, low = false): Promise<T> {
  if (!deyeConfigured()) throw new DeyeNotConfiguredError();

  const run = (token: string) =>
    deyeFetch<T>(`${env.deyeBaseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }, low);

  let { res, data } = await run(await getToken());

  // Re-auth once on an invalid-token business code (HTTP 200 + success:false).
  const code = data.code != null ? String(data.code) : undefined;
  if (data.success === false && code && INVALID_TOKEN_CODES.has(code)) {
    ({ res, data } = await run(await getToken(true)));
  }

  if (!res.ok || data.success === false) {
    throw new DeyeError(
      `deye_request_failed (${path}): ${data.msg || `HTTP ${res.status}`}`,
      data.code != null ? String(data.code) : undefined,
    );
  }
  return data;
}

// ─── Typed shapes (fields are best-effort; the API may omit some) ────────────

export interface DeyeStation {
  id: number;
  name?: string;
  connectionStatus?: string; // e.g. ALL_ONLINE / PART_ONLINE / ALL_OFFLINE
  generationPower?: number; // W, current
  batterySOC?: number; // %
  installedCapacity?: number; // W (peak)
  locationLat?: number;
  locationLng?: number;
  locationAddress?: string;
  regionTimezone?: string;
  gridInterconnectionType?: string;
  startOperatingTime?: number;
  createdDate?: number; // epoch seconds
  lastUpdateTime?: number; // epoch seconds
  ownerName?: string;
  contactPhone?: string;
  countryCode?: string;
}

export interface DeyeStationLatest {
  generationPower?: number;
  consumptionPower?: number;
  gridPower?: number;
  purchasePower?: number;
  wirePower?: number;
  chargePower?: number;
  dischargePower?: number;
  batteryPower?: number;
  batterySOC?: number;
  irradiateIntensity?: number;
  lastUpdateTime?: number;
}

export interface DeyeDevice {
  deviceSn?: string;
  deviceType?: string;
  deviceId?: number;
  stationId?: number;
  // The /v1.0/station/device endpoint reports online state as `connectStatus`
  // (1 = online, 0 = offline), NOT `deviceState`. `deviceState` is kept as a
  // fallback in case other Deye-engine tenants return it under that name.
  connectStatus?: number | string;
  deviceState?: number | string;
  /** Epoch seconds of the device's last data upload. */
  collectionTime?: number;
}

export interface DeyeAlert {
  alertId?: number | string;
  alertName?: string;
  alertCode?: string;
  deviceSn?: string;
  deviceType?: string;
  alertStartTime?: number;
  alertEndTime?: number;
  level?: number | string;
  impact?: string;
  status?: number | string;
  protocolName?: string;
}

export interface DeyePowerPoint {
  timeStamp?: number; // epoch seconds
  generationPower?: number;
  consumptionPower?: number;
  gridPower?: number;
  batteryPower?: number;
  [k: string]: unknown;
}

// ─── Endpoint wrappers ───────────────────────────────────────────────────────

/** All stations under the account (paginated; we pull up to `size`). */
export async function listStations(page = 1, size = 100): Promise<DeyeStation[]> {
  const data = await deyePost<Envelope & { stationList?: DeyeStation[] }>('/v1.0/station/list', {
    page,
    size,
  });
  return data.stationList ?? [];
}

/** Current realtime power snapshot for one station. */
export async function stationLatest(stationId: number): Promise<DeyeStationLatest> {
  const data = await deyePost<Envelope & DeyeStationLatest>('/v1.0/station/latest', { stationId });
  const { requestId, success, code, msg, ...rest } = data;
  return rest;
}

/** Devices (inverters/loggers) under one station. */
export async function listStationDevices(stationId: number, page = 1, size = 100): Promise<DeyeDevice[]> {
  const data = await deyePost<Envelope & { deviceListItems?: DeyeDevice[] }>('/v1.0/station/device', {
    stationIds: [stationId],
    page,
    size,
  });
  return data.deviceListItems ?? [];
}

/**
 * Alerts/faults for one station over a time window (defaults to the last
 * `days` days, capped by the API at 180).
 */
export async function listStationAlerts(stationId: number, days = 30, page = 1, size = 100): Promise<DeyeAlert[]> {
  const endTimestamp = Math.floor(Date.now() / 1000);
  const startTimestamp = endTimestamp - Math.min(days, 180) * 24 * 3600;
  const data = await deyePost<Envelope & { stationAlertItems?: DeyeAlert[] }>('/v1.0/station/alertList', {
    stationId,
    startTimestamp,
    endTimestamp,
    page,
    size,
  });
  return data.stationAlertItems ?? [];
}

/**
 * Intraday power curve for one station (timestamp-based). `startTs`/`endTs` are
 * epoch seconds; defaults to midnight-today → now in the server's timezone.
 */
export async function stationPowerCurve(
  stationId: number,
  startTs?: number,
  endTs?: number,
): Promise<DeyePowerPoint[]> {
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const start = startTs ?? Math.floor(midnight.getTime() / 1000);
  const end = endTs ?? Math.floor(now.getTime() / 1000);
  const data = await deyePost<Envelope & { stationDataItems?: DeyePowerPoint[] }>(
    '/v1.0/station/history/power',
    { stationId, startTimestamp: start, endTimestamp: end },
  );
  return data.stationDataItems ?? [];
}

export interface DeyeEnergy {
  /** kWh generated today / this month / this year. */
  daily?: number;
  monthly?: number;
  yearly?: number;
}

interface DeyeHistoryItem {
  generationValue?: number;
}

/**
 * Energy totals for one station via the history endpoint. The station list has
 * no energy figures, so these come from `/v1.0/station/history` at day (2),
 * month (3) and year (4) granularity. Each call is best-effort — a failure
 * leaves that figure undefined rather than failing the whole station.
 */
export async function stationEnergy(stationId: number): Promise<DeyeEnergy> {
  const fmtDay = (dt: Date) =>
    `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  // Daily: a single-day query (startAt == endAt) returns nothing, and the
  // server's timezone can differ from the station's, so query a 3-day window
  // (yesterday → tomorrow) and take the most recent day's value as "today".
  const yesterday = new Date(now.getTime() - 86_400_000);
  const tomorrow = new Date(now.getTime() + 86_400_000);

  const history = async (granularity: number, startAt: string, endAt: string): Promise<DeyeHistoryItem[]> => {
    const data = await deyePost<Envelope & { stationDataItems?: DeyeHistoryItem[] }>('/v1.0/station/history', {
      stationId,
      granularity,
      startAt,
      endAt,
    }, true); // background fleet scan: yields to plant-page calls
    return data.stationDataItems ?? [];
  };
  const sumGen = (items: DeyeHistoryItem[]): number | undefined =>
    items.length ? items.reduce((acc, it) => acc + (it.generationValue ?? 0), 0) : undefined;

  let failed = 0;
  const soft = (p: Promise<DeyeHistoryItem[]>) => p.catch(() => { failed++; return [] as DeyeHistoryItem[]; });
  const [dayItems, monthItems, yearItems] = await Promise.all([
    soft(history(2, fmtDay(yesterday), fmtDay(tomorrow))),
    soft(history(3, `${y}-${m}`, `${y}-${m}`)),
    soft(history(4, `${y}`, `${y}`)),
  ]);
  // All three failed (rate-limited): throw so the empty result isn't cached
  // for 5 min — the caller keeps serving the last good totals instead.
  if (failed === 3) throw new DeyeError('deye_energy_unavailable');

  return {
    // Most recent day in the window = today (items are ascending by date).
    daily: dayItems.length ? dayItems[dayItems.length - 1].generationValue : undefined,
    monthly: sumGen(monthItems),
    yearly: sumGen(yearItems),
  };
}
