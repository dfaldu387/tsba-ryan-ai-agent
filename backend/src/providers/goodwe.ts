import { env, goodweConfigured } from '../env.js';
import {
  ProviderError,
  ProviderNotConfiguredError,
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
  if (status === 1) return 'online';
  if (status === 2) return 'partial';
  if (status === -1 || status === 0) return 'offline';
  return 'unknown';
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
  // the detail view is derived from the station's own monitor record. Devices,
  // alerts and the intraday curve aren't exposed here yet.
  async stationDetail(stationId: string): Promise<NormalizedDetail> {
    const data = await semsPost<{ list?: SemsStation[] }>('PowerStationMonitor/QueryPowerStationMonitor', {
      page_index: 1,
      page_size: 100,
      key: '',
      orderby: '',
      powerstation_type: '',
      powerstation_status: '',
    });
    const s = (data.list ?? []).find((x) => x.powerstation_id === stationId);
    const info: StationInfoItem[] = [];
    if (s) {
      const push = (label: string, v: string | number | undefined | null) => {
        if (v != null && v !== '') info.push({ label, value: String(v) });
      };
      push('Status', s.status === 1 ? 'Online' : s.status === 2 ? 'Partial' : 'Offline');
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
      devices: [],
      alerts: [],
      power: [],
    };
  },
};
