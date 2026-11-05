import { env, sungrowConfigured } from '../env.js';
import { cached } from './cache.js';
import {
  ProviderError,
  ProviderNotConfiguredError,
  type NormalizedAlert,
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
  // Health signal carried on the station record (iSolarCloud doesn't authorise a
  // detailed alarm-list endpoint for this app's scope, so these counts are the
  // fault signal we have): number of active alarms / device faults.
  alarm_count?: number;
  fault_count?: number;
  ps_fault_status?: number;
}

/** /openapi/getPowerStationDetail — richer attributes than the list record. */
interface SungrowStationDetail {
  ps_name?: string;
  ps_type_name?: string;
  design_capacity?: Metric; // PV capacity
  design_capacity_battery?: Metric; // battery capacity
  install_date?: string;
  alarm_count?: number;
  ps_fault_status?: number;
  ps_price?: number | string;
  param_income_unit_name?: string;
}

/** A Sungrow device row from /openapi/getDeviceList. */
interface SungrowDevice {
  device_sn?: string;
  sn?: string;
  device_type?: number | string;
  device_type_name?: string;
  type_name?: string;
  device_name?: string;
  dev_status?: number | string;
  device_state?: number | string;
  dev_fault_status?: number | string;
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

function buildInfo(s: SungrowStation, detail?: SungrowStationDetail | null): StationInfoItem[] {
  const items: [string, string | number | undefined][] = [
    ['Status', s.ps_status === 1 ? 'Online' : s.ps_status === 2 || s.ps_status === 3 ? 'Partial' : 'Offline'],
    ['Location', s.ps_location],
    [
      'Coordinates',
      s.latitude != null && s.longitude != null ? `${s.latitude}, ${s.longitude}` : undefined,
    ],
    ['System type', detail?.ps_type_name],
    ['Installed capacity', fmtMetric(s.total_capcity) ?? fmtMetric(detail?.design_capacity)],
    ['Battery capacity', fmtMetric(detail?.design_capacity_battery)],
    ['Today', fmtMetric(s.today_energy)],
    ['Total', fmtMetric(s.total_energy)],
    ['Today income', fmtMetric(s.today_income)],
    ['Total income', fmtMetric(s.total_income)],
    ['CO₂ reduced', fmtMetric(s.co2_reduce_total)],
    ['Equivalent hours', fmtMetric(s.equivalent_hour)],
    // Fault signal from the station record (the detailed alarm list isn't
    // exposed to this app's API scope).
    ['Active alarms', s.alarm_count != null ? String(s.alarm_count) : detail?.alarm_count != null ? String(detail.alarm_count) : undefined],
    ['Device faults', s.fault_count != null ? String(s.fault_count) : undefined],
    ['Install date', s.install_date ?? detail?.install_date],
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

// iSolarCloud returns device_type as a numeric code and type_name in Chinese.
// Normalise both to the English labels the UI/agent use (and that the
// devicesByType breakdown groups on), so a Sungrow plant's devices read as
// "Battery / Inverter / Logger" instead of "43 / 14 / 22".
const SUNGROW_DEVICE_TYPE: Record<string, string> = {
  '1': 'Inverter',
  '11': 'Inverter',
  '14': 'Inverter', // energy-storage (hybrid) inverter
  '22': 'Logger', // communication module
  '43': 'Battery',
  '35': 'Meter',
};
const SUNGROW_DEVICE_TYPE_CN: Record<string, string> = {
  电池: 'Battery',
  逆变器: 'Inverter',
  储能逆变器: 'Inverter',
  通信模块: 'Logger',
  电表: 'Meter',
};
function sungrowDeviceType(code?: number | string, name?: string): string | undefined {
  if (code != null && SUNGROW_DEVICE_TYPE[String(code)]) return SUNGROW_DEVICE_TYPE[String(code)];
  if (name && SUNGROW_DEVICE_TYPE_CN[name]) return SUNGROW_DEVICE_TYPE_CN[name];
  return name || (code != null ? String(code) : undefined);
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
    const [list, deviceRes, detailRes] = await Promise.all([
      post<{ pageList?: SungrowStation[] }>('/openapi/getPowerStationList', { curPage: 1, size: 100 }).catch(() => null),
      post<{ pageList?: SungrowDevice[] }>('/openapi/getDeviceList', { ps_id: stationId, curPage: 1, size: 100 }).catch(() => null),
      // Richer attributes (battery capacity, system type, …). Cached 10 min —
      // these change rarely and it keeps the detail view snappy.
      cached(`sungrow:detail:${stationId}`, 600_000, () =>
        post<SungrowStationDetail>('/openapi/getPowerStationDetail', { ps_id: stationId }),
      ).catch((): SungrowStationDetail | null => null),
    ]);
    const s = (list?.pageList ?? []).find((x) => String(x.ps_id) === stationId);
    const rawDevices = deviceRes?.pageList ?? [];
    const devices = rawDevices.map((d, i) => ({
      sn: d.device_sn || d.sn || d.device_name || String(i),
      type: sungrowDeviceType(d.device_type, d.device_type_name ?? d.type_name),
      online: String(d.dev_status ?? d.device_state ?? '') === '1',
    }));

    // iSolarCloud doesn't expose a detailed alarm list to this app's scope, so
    // synthesise alerts from the fault/alarm counts on the station record and
    // from any device the device list reports as not communicating.
    const alerts: NormalizedAlert[] = [];
    const alarmCount = s?.alarm_count ?? detailRes?.alarm_count ?? 0;
    const faultCount = s?.fault_count ?? 0;
    if (alarmCount > 0) {
      alerts.push({ id: `sungrow-alarm-${stationId}`, name: `${alarmCount} active alarm${alarmCount > 1 ? 's' : ''}`, level: 'alarm' });
    }
    if (faultCount > 0) {
      alerts.push({ id: `sungrow-fault-${stationId}`, name: `${faultCount} device fault${faultCount > 1 ? 's' : ''}`, level: 'fault' });
    }
    for (const d of devices.filter((d) => !d.online)) {
      alerts.push({ id: `sungrow-dev-${d.sn}`, name: `${d.type ?? 'Device'} offline`, deviceSn: d.sn, level: 'device' });
    }

    return {
      info: s ? buildInfo(s, detailRes) : [],
      latest: s
        ? {
            currentPowerW: powerW(s.curr_power),
            dailyEnergyKwh: energyKwh(s.today_energy),
            totalEnergyKwh: energyKwh(s.total_energy),
          }
        : null,
      devices,
      alerts,
      // iSolarCloud's intraday power-curve endpoints aren't enabled for this
      // app's API scope (they return E900 "Unauthorized access"), so the curve
      // is left empty rather than guessed.
      power: [],
    };
  },
};
