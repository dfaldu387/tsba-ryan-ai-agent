import { env, goodweConfigured } from '../env.js';
import {
  ProviderError,
  ProviderNotConfiguredError,
  type NormalizedAlert,
  type NormalizedDevice,
  type NormalizedPowerPoint,
  type NormalizedStation,
  type NormalizedDetail,
  type SolarProvider,
  type StationInfoItem,
  type StationStatus,
} from './types.js';

/**
 * GoodWe SEMS Portal client (semsportal.com).
 *
 * Auth: POST /api/v2/Common/CrossLogin with the account email + password and a
 * minimal `Token` header. The response `data` object (uid, timestamp, token, …)
 * is itself serialised into the `Token` header on every subsequent call. The
 * SEMS token is short-lived, so we cache the login payload and re-login once if
 * a request comes back with an auth error.
 */

const REGION_HOSTS: Record<string, string> = {
  au: 'https://au.semsportal.com',
  eu: 'https://eu.semsportal.com',
  us: 'https://us.semsportal.com',
  global: 'https://www.semsportal.com',
};

function baseUrl(): string {
  return REGION_HOSTS[(env.goodweRegion || 'global').toLowerCase()] ?? REGION_HOSTS.global;
}

/**
 * SEMS timestamps come as "YYYY-MM-DD HH:mm:ss" (station-local, no zone) or an
 * MM/DD/YYYY variant. Parse to epoch seconds; return undefined if unparseable.
 */
function parseSemsTime(v?: string): number | undefined {
  if (!v) return undefined;
  const iso = v.includes('T') ? v : v.replace(' ', 'T');
  const ms = Date.parse(iso);
  if (!Number.isNaN(ms)) return Math.floor(ms / 1000);
  const alt = Date.parse(v);
  return Number.isNaN(alt) ? undefined : Math.floor(alt / 1000);
}

interface LoginData {
  uid?: string;
  timestamp?: number;
  token?: string;
  client?: string;
  version?: string;
  language?: string;
  [k: string]: unknown;
}

let loginCache: LoginData | null = null;

async function login(): Promise<LoginData> {
  if (!goodweConfigured()) throw new ProviderNotConfiguredError('goodwe');
  const res = await fetch(`${baseUrl()}/api/v2/Common/CrossLogin`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Token: JSON.stringify({ version: 'v2.1.0', client: 'ios', language: 'en' }),
    },
    body: JSON.stringify({ account: env.goodweEmail, pwd: env.goodwePassword, agreement_agreement: 0, is_local: true }),
  }).catch((err) => {
    throw new ProviderError(`goodwe_network_error: ${(err as Error).message}`);
  });

  const data = (await res.json().catch(() => ({}))) as { hasError?: boolean; code?: number; msg?: string; data?: LoginData };
  if (data.hasError || !data.data?.token) {
    throw new ProviderError(`goodwe_auth_failed: ${data.msg || `HTTP ${res.status}`}`, data.code != null ? String(data.code) : undefined);
  }
  loginCache = data.data;
  return data.data;
}

async function getLogin(force = false): Promise<LoginData> {
  if (!force && loginCache) return loginCache;
  return login();
}

interface SemsEnvelope<T> {
  hasError?: boolean;
  code?: number | string;
  msg?: string;
  data?: T;
}

/** POST a SEMS endpoint with the cached login token, re-logging in once on auth failure. */
async function semsPost<T>(path: string, body: Record<string, unknown>): Promise<T> {
  if (!goodweConfigured()) throw new ProviderNotConfiguredError('goodwe');

  const run = async (auth: LoginData): Promise<SemsEnvelope<T>> => {
    const res = await fetch(`${baseUrl()}/api/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Token: JSON.stringify(auth) },
      body: JSON.stringify(body),
    }).catch((err) => {
      throw new ProviderError(`goodwe_network_error: ${(err as Error).message}`);
    });
    return (await res.json().catch(() => ({}))) as SemsEnvelope<T>;
  };

  let data = await run(await getLogin());
  // Token expired / invalid → re-login once and retry. SEMS signals this with
  // code 100001 or 100002 and messages like "authorization has expired, please
  // log in again", so match the codes and a broad set of phrasings.
  const code = data.code != null ? String(data.code) : '';
  if (code === '100001' || code === '100002' || /token|log ?in|expire|authoriz/i.test(data.msg || '')) {
    loginCache = null;
    data = await run(await getLogin(true));
  }
  // SEMS uses code "0" for success on data endpoints.
  if (data.hasError || (data.code != null && String(data.code) !== '0')) {
    throw new ProviderError(`goodwe_request_failed (${path}): ${data.msg || 'error'}`, data.code != null ? String(data.code) : undefined);
  }
  return (data.data ?? ({} as T)) as T;
}

interface SemsStation {
  powerstation_id: string;
  stationname?: string;
  status?: number;
  pac?: number; // W
  capacity?: number; // kWp
  eday?: number; // kWh today
  emonth?: number; // kWh this month
  etotal?: number; // kWh all-time
  eday_income?: number;
  total_income?: number;
  location?: string;
  longitude?: string | number;
  latitude?: string | number;
  powerstation_type?: string;
  org_name?: string;
  currency?: string;
  to_hour?: number;
}

function mapStatus(status?: number): StationStatus {
  // SEMS status codes: 1 = generating/normal, 0 = waiting (standby — connected
  // but not producing, e.g. night / heavy cloud), 2 = fault/alarm, -1 = offline
  // (not communicating). Mapping 0 → offline (the previous behaviour) falsely
  // marked every healthy plant "Offline" overnight, so 0 gets its own state.
  if (status === 1) return 'online';
  if (status === 0) return 'waiting';
  if (status === 2) return 'partial';
  if (status === -1) return 'offline';
  return 'unknown';
}

// ─── Detail-level SEMS shapes (warnings query + intraday power chart) ────────

/** One active warning on an inverter (fields vary by firmware — all optional). */
interface SemsWarning {
  warning_message?: string;
  warningmessage?: string;
  device_sn?: string;
  sn?: string;
  happen_time?: string;
  time?: string;
  warning_level?: number | string;
  level?: number | string;
  error_code?: string;
  code?: string;
}
/** Per-inverter group returned by PowerstationWarningsQuery. */
interface SemsWarningStation {
  sn?: string;
  sn_name?: string;
  status?: number;
  warning?: SemsWarning[];
}
interface SemsWarningsResult {
  pw_id?: string;
  list?: SemsWarningStation[];
}
/** A single point on the intraday power curve. */
interface SemsPac {
  date?: string;
  pac?: number;
  x?: string;
  y?: number;
}
interface SemsPacResult {
  today_power?: number;
  pacs?: SemsPac[];
}

function toStation(s: SemsStation): NormalizedStation {
  return {
    id: s.powerstation_id,
    name: s.stationname || s.powerstation_id,
    status: mapStatus(s.status),
    currentPowerW: s.pac,
    dailyEnergyKwh: s.eday,
    monthlyEnergyKwh: s.emonth,
    totalEnergyKwh: s.etotal,
    capacityKw: s.capacity,
    location: s.location,
  };
}

export const goodweProvider: SolarProvider = {
  id: 'goodwe',
  name: 'GoodWe (SEMS)',
  configured: goodweConfigured,

  async listStations(): Promise<NormalizedStation[]> {
    const data = await semsPost<{ list?: SemsStation[] }>('PowerStationMonitor/QueryPowerStationMonitor', {
      page_index: 1,
      page_size: 100,
      key: '',
      orderby: '',
      powerstation_type: '',
      powerstation_status: '',
    });
    return (data.list ?? []).map(toStation);
  },

  // SEMS's monitor-detail endpoint returns no body for this (shared) account, so
  // the detail view is derived from the station's own monitor record, enriched
  // with the per-inverter warnings query (which also yields the inverter roster)
  // and the intraday power curve.
  async stationDetail(stationId: string): Promise<NormalizedDetail> {
    const today = new Date().toISOString().slice(0, 10);
    const [data, warnings, pac] = await Promise.all([
      semsPost<{ list?: SemsStation[] }>('PowerStationMonitor/QueryPowerStationMonitor', {
        page_index: 1,
        page_size: 100,
        key: '',
        orderby: '',
        powerstation_type: '',
        powerstation_status: '',
      }),
      // Per-inverter active warnings. Also the only roster of the plant's
      // inverters available on this account (monitor-detail comes back empty).
      semsPost<SemsWarningsResult>('v3/Warning/PowerstationWarningsQuery', {
        pw_id: stationId,
        page_index: 1,
        page_size: 100,
      }).catch((): SemsWarningsResult => ({})),
      // Today's AC-power curve (Watts by time).
      semsPost<SemsPacResult>('PowerStationMonitor/GetPowerStationPacByDayForApp', {
        id: stationId,
        date: today,
      }).catch((): SemsPacResult => ({})),
    ]);
    const s = (data.list ?? []).find((x) => x.powerstation_id === stationId);
    const info: StationInfoItem[] = [];
    if (s) {
      const push = (label: string, v: string | number | undefined | null) => {
        if (v != null && v !== '') info.push({ label, value: String(v) });
      };
      push(
        'Status',
        s.status === 1 ? 'Online' : s.status === 0 ? 'Waiting' : s.status === 2 ? 'Partial' : 'Offline',
      );
      push('Location', s.location);
      push(
        'Coordinates',
        s.latitude != null && s.longitude != null ? `${s.latitude}, ${s.longitude}` : undefined,
      );
      push('Installed capacity', s.capacity != null ? `${s.capacity} kWp` : undefined);
      push('Type', s.powerstation_type);
      push('Today', s.eday != null ? `${s.eday} kWh` : undefined);
      push('This month', s.emonth != null ? `${s.emonth} kWh` : undefined);
      push('Total', s.etotal != null ? `${s.etotal} kWh` : undefined);
      push('Today income', s.eday_income != null ? `${s.eday_income} ${s.currency ?? ''}`.trim() : undefined);
      push('Total income', s.total_income != null ? `${s.total_income} ${s.currency ?? ''}`.trim() : undefined);
      push('Full-power hours', s.to_hour != null ? `${s.to_hour} h` : undefined);
      push('Organisation', s.org_name);
      push('Station ID', s.powerstation_id);
    }
    // Inverter roster from the warnings query. SEMS doesn't give a per-inverter
    // comms flag here, so treat an inverter as online unless the whole plant is
    // offline (status -1) — i.e. if the plant is reporting, so is its inverter.
    const plantOffline = s?.status === -1;
    const warnStations = warnings.list ?? [];
    const devices: NormalizedDevice[] = warnStations
      .filter((w) => w.sn)
      .map((w) => ({
        sn: w.sn as string,
        type: 'Inverter',
        online: w.status != null ? w.status !== -1 : !plantOffline,
      }));

    // Active warnings across all inverters → normalized alerts.
    const alerts: NormalizedAlert[] = [];
    for (const w of warnStations) {
      for (const a of w.warning ?? []) {
        alerts.push({
          id: `goodwe-${w.sn ?? ''}-${a.error_code ?? a.code ?? alerts.length}`,
          name: a.warning_message || a.warningmessage || a.error_code || a.code || 'Warning',
          code: a.error_code ?? a.code,
          deviceSn: a.device_sn ?? a.sn ?? w.sn,
          start: parseSemsTime(a.happen_time ?? a.time),
          level: a.warning_level != null ? String(a.warning_level) : a.level != null ? String(a.level) : undefined,
        });
      }
    }

    // Intraday power curve (Watts by time).
    const power: NormalizedPowerPoint[] = (pac.pacs ?? [])
      .map((p) => {
        const t = parseSemsTime(p.date ?? p.x);
        const w = p.pac ?? p.y;
        return t != null && w != null ? { t, powerW: w } : null;
      })
      .filter((p): p is NormalizedPowerPoint => p !== null);

    return {
      info,
      latest: s
        ? {
            currentPowerW: s.pac,
            dailyEnergyKwh: s.eday,
            monthlyEnergyKwh: s.emonth,
            totalEnergyKwh: s.etotal,
          }
        : null,
      devices,
      alerts,
      power,
    };
  },
};
