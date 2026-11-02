import { env, sungrowConfigured } from '../env.js';
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
 * Sungrow iSolarCloud OpenAPI (AU gateway: augateway.isolarcloud.com).
 *
 * Auth: create an app in the iSolarCloud Developer Portal (Authorize with
 * OAuth2 = No) → Appkey + Secret Key. Secret Key goes in the `x-access-key`
 * header; a token comes from /openapi/login (plaintext account password). The
 * gateway is behind CloudFront, which 403s requests with no User-Agent/Accept.
 *
 * getPowerStationList already carries current power + today/total energy +
 * capacity, each as a {unit, value} object with Chinese energy units
 * (度 = kWh, 万度 = 10,000 kWh), so we parse those and skip getStationRealKpi.
 */

let token: string | null = null;

interface Envelope<T> {
  result_code?: string;
  result_msg?: string;
  result_data?: T;
}

/** A Sungrow metric: either a {unit, value} pair or a bare number/string. */
type Metric = { unit?: string; value?: string | number } | number | string | null | undefined;

const toNum = (v: unknown): number | undefined => {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

function metricValue(m: Metric): { value?: number; unit?: string } {
  if (m == null) return {};
  if (typeof m === 'object') return { value: toNum(m.value), unit: m.unit };
  return { value: toNum(m) };
}

/** Power → Watts. */
function powerW(m: Metric): number | undefined {
  const { value, unit } = metricValue(m);
  if (value == null) return undefined;
  const u = (unit || 'W').toLowerCase();
  if (u === 'kw') return value * 1000;
  if (u === 'mw') return value * 1_000_000;
  return value; // W
}

/** Energy → kWh (handles Chinese 度/万度 and English kWh/MWh/Wh/GWh). */
function energyKwh(m: Metric): number | undefined {
  const { value, unit } = metricValue(m);
  if (value == null) return undefined;
  switch (unit) {
    case '万度':
      return value * 10_000; // 万 = 10k, 度 = kWh
    case '度':
    case 'kWh':
      return value;
    case 'Wh':
      return value / 1000;
    case 'MWh':
    case '兆瓦时':
      return value * 1000;
    case 'GWh':
      return value * 1_000_000;
    default:
      return value; // assume kWh
  }
}

/** Capacity → kW. */
function capacityKw(m: Metric): number | undefined {
  const { value, unit } = metricValue(m);
  if (value == null) return undefined;
  const u = (unit || 'kWp').toLowerCase();
  if (u === 'wp' || u === 'w') return value / 1000;
  if (u === 'mwp' || u === 'mw') return value * 1000;
  return value; // kWp
}

function headers(): Record<string, string> {
  return {
    'Content-Type': 'application/json;charset=UTF-8',
    'x-access-key': env.sungrowSecretKey,
    sys_code: '901',
    // iSolarCloud sits behind CloudFront, which 403s requests with no UA/Accept.
    'User-Agent': 'tsba-ai-agent/1.0',
    Accept: 'application/json',
  };
}

async function rawPost<T>(path: string, body: Record<string, unknown>): Promise<Envelope<T>> {
  const res = await fetch(`${env.sungrowBaseUrl}${path}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ appkey: env.sungrowAppKey, ...body }),
  }).catch((err) => {
    throw new ProviderError(`sungrow_network_error: ${(err as Error).message}`);
  });
  return (await res.json().catch(() => ({}))) as Envelope<T>;
}

async function loginToken(): Promise<string> {
  if (!sungrowConfigured()) throw new ProviderNotConfiguredError('sungrow');
  const data = await rawPost<{ token?: string }>('/openapi/login', {
    user_account: env.sungrowEmail,
    user_password: env.sungrowPassword,
    login_type: '1',
  });
  if (data.result_code !== '1' || !data.result_data?.token) {
    throw new ProviderError(`sungrow_auth_failed: ${data.result_msg || data.result_code}`, data.result_code);
  }
  token = data.result_data.token;
  return token;
}

async function getToken(force = false): Promise<string> {
  if (!force && token) return token;
  return loginToken();
}

async function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
  if (!sungrowConfigured()) throw new ProviderNotConfiguredError('sungrow');
  let data = await rawPost<T>(path, { token: await getToken(), ...body });
  if (data.result_code !== '1' && /token|login|E912|expire/i.test(`${data.result_msg || ''}${data.result_code || ''}`)) {
    data = await rawPost<T>(path, { token: await getToken(true), ...body });
  }
  if (data.result_code !== '1') {
    throw new ProviderError(`sungrow_request_failed (${path}): ${data.result_msg || data.result_code}`, data.result_code);
  }
  return (data.result_data ?? ({} as T)) as T;
}

interface SungrowStation {
  ps_id?: number | string;
  ps_name?: string;
  ps_location?: string;
  ps_status?: number;
  curr_power?: Metric;
  today_energy?: Metric;
  total_energy?: Metric;
  total_capcity?: Metric; // Sungrow's own spelling
  latitude?: number | string;
  longitude?: number | string;
  install_date?: string;
  grid_connection_time?: string;
  ps_current_time_zone?: string;
  today_income?: Metric;
  total_income?: Metric;
  co2_reduce_total?: Metric;
  equivalent_hour?: Metric;
  ps_type?: number | string;
}

// iSolarCloud returns some unit labels in Chinese — translate for display.
const UNIT_MAP: Record<string, string> = {
  '度': 'kWh',
  '澳元': 'AUD',
  '元': 'CNY',
  '美元': 'USD',
  '欧元': 'EUR',
  '千克': 'kg',
  '吨': 't',
  '小时': 'h',
  '瓦': 'W',
  '千瓦': 'kW',
};

/** Format a {unit,value} metric for display (converts Chinese energy units). */
function fmtMetric(m: Metric): string | undefined {
  const { value, unit } = metricValue(m);
  if (value == null) return undefined;
  if (unit === '万度') return `${(value * 10_000).toLocaleString()} kWh`;
  const u = unit ? UNIT_MAP[unit] ?? unit : '';
  return u ? `${value} ${u}` : String(value);
}

function buildInfo(s: SungrowStation): StationInfoItem[] {
  const items: [string, string | number | undefined][] = [
    ['Status', s.ps_status === 1 ? 'Online' : s.ps_status === 2 || s.ps_status === 3 ? 'Partial' : 'Offline'],
    ['Location', s.ps_location],
    [
      'Coordinates',
      s.latitude != null && s.longitude != null ? `${s.latitude}, ${s.longitude}` : undefined,
    ],
    ['Installed capacity', fmtMetric(s.total_capcity)],
    ['Today', fmtMetric(s.today_energy)],
    ['Total', fmtMetric(s.total_energy)],
    ['Today income', fmtMetric(s.today_income)],
    ['Total income', fmtMetric(s.total_income)],
    ['CO₂ reduced', fmtMetric(s.co2_reduce_total)],
    ['Equivalent hours', fmtMetric(s.equivalent_hour)],
    ['Install date', s.install_date],
    ['Grid connection', s.grid_connection_time],
    ['Timezone', s.ps_current_time_zone],
    ['Station ID', s.ps_id != null ? String(s.ps_id) : undefined],
  ];
  return items
    .filter(([, v]) => v != null && v !== '')
    .map(([label, v]) => ({ label, value: String(v) }));
}

function mapStatus(status?: number): StationStatus {
  if (status === 1) return 'online';
  if (status === 2 || status === 3) return 'partial';
  if (status === 0 || status === -1) return 'offline';
  return 'unknown';
}

function toStation(s: SungrowStation): NormalizedStation {
  return {
    id: String(s.ps_id),
    name: s.ps_name || `Station ${s.ps_id}`,
    status: mapStatus(s.ps_status),
    currentPowerW: powerW(s.curr_power),
    dailyEnergyKwh: energyKwh(s.today_energy),
    totalEnergyKwh: energyKwh(s.total_energy),
    capacityKw: capacityKw(s.total_capcity),
    location: s.ps_location,
  };
}

export const sungrowProvider: SolarProvider = {
  id: 'sungrow',
  name: 'Sungrow (iSolarCloud)',
  configured: sungrowConfigured,

  async listStations(): Promise<NormalizedStation[]> {
    const data = await post<{ pageList?: SungrowStation[] }>('/openapi/getPowerStationList', { curPage: 1, size: 100 });
    return (data.pageList ?? []).map(toStation);
  },

  async stationDetail(stationId: string): Promise<NormalizedDetail> {
    const [list, devices] = await Promise.all([
      post<{ pageList?: SungrowStation[] }>('/openapi/getPowerStationList', { curPage: 1, size: 100 }).catch(() => null),
      post<{ pageList?: { device_sn?: string; sn?: string; device_type?: number | string; device_name?: string; dev_status?: number | string; device_state?: number | string }[] }>(
        '/openapi/getDeviceList',
        { ps_id: stationId, curPage: 1, size: 100 },
      ).catch(() => null),
    ]);
    const s = (list?.pageList ?? []).find((x) => String(x.ps_id) === stationId);
    return {
      info: s ? buildInfo(s) : [],
      latest: s
        ? {
            currentPowerW: powerW(s.curr_power),
            dailyEnergyKwh: energyKwh(s.today_energy),
            totalEnergyKwh: energyKwh(s.total_energy),
          }
        : null,
      devices: (devices?.pageList ?? []).map((d, i) => ({
        sn: d.device_sn || d.sn || d.device_name || String(i),
        type: d.device_type != null ? String(d.device_type) : undefined,
        online: String(d.dev_status ?? d.device_state ?? '') === '1',
      })),
      alerts: [],
      power: [],
    };
  },
};
