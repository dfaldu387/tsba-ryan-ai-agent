import { createHmac, createHash } from 'node:crypto';
import { env, dynessConfigured } from '../env.js';
import { cached } from './cache.js';
import {
  ProviderError,
  ProviderNotConfiguredError,
  type NormalizedAlert,
  type NormalizedDevice,
  type NormalizedDetail,
  type NormalizedStation,
  type StationInfoItem,
  type SolarProvider,
  type StationStatus,
} from './types.js';

/**
 * Dyness Open API v1.1 (battery energy-storage monitoring).
 *
 * Base URL is regional and the API lives under /openapi/ems-device:
 *   APAC (AU/NZ/Asia) → https://apacopen-api.dyness.com
 *   Europe            → https://open-api.dyness.com
 * Credentials: an App ID + Secret from the Dyness portal → Developer Center →
 * API Management.
 *
 * Auth is Aliyun-style HMAC-SHA1 request signing (the same scheme as SolisCloud):
 *   stringToSign = "POST\n{Content-MD5}\napplication/json\n{Date}\n{path}"
 *   signature    = base64( HMAC-SHA1( appSecret, stringToSign ) )
 *   Authorization: API {appId}:{signature}
 * where `path` is the endpoint path WITHOUT the /openapi/ems-device prefix,
 * Content-MD5 is base64(md5(body)) over the exact bytes sent, and Date is RFC-1123
 * GMT. Every response is HTTP 200 with an envelope { code, info, data }; code 0/200
 * means success. Verified live: auth returns code 200 "Request successful".
 *
 * IMPORTANT: the Open API only returns devices that have been BOUND to the app
 * (in the Developer Center, or via POST /v1/device/bindSn). An app with no bound
 * devices gets an empty list — the provider then simply reports no stations.
 */

const PREFIX = '/openapi/ems-device';
const md5Base64 = (s: string): string => createHash('md5').update(s, 'utf8').digest('base64');
const hmacSha1Base64 = (key: string, s: string): string => createHmac('sha1', key).update(s, 'utf8').digest('base64');

interface Envelope<T> {
  code?: number | string;
  info?: string;
  msg?: string;
  data?: T;
}

const isOk = (code: unknown): boolean => {
  const c = String(code ?? '');
  return c === '0' || c === '200';
};

/** Signed POST to a Dyness Open API endpoint (`path` excludes the PREFIX). */
async function post<T>(path: string, body: Record<string, unknown> = {}): Promise<T> {
  if (!dynessConfigured()) throw new ProviderNotConfiguredError('dyness');
  const payload = JSON.stringify(body);
  const date = new Date().toUTCString(); // RFC-1123 GMT
  const contentMd5 = md5Base64(payload);
  const stringToSign = `POST\n${contentMd5}\napplication/json\n${date}\n${path}`;
  const signature = hmacSha1Base64(env.dynessAppSecret, stringToSign);

  const res = await fetch(`${env.dynessBaseUrl}${PREFIX}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      'Content-MD5': contentMd5,
      Date: date,
      Authorization: `API ${env.dynessAppId}:${signature}`,
    },
    body: payload,
  }).catch((err) => {
    throw new ProviderError(`dyness_network_error: ${(err as Error).message}`);
  });

  const data = (await res.json().catch(() => ({}))) as Envelope<T>;
  if (!isOk(data.code)) {
    throw new ProviderError(
      `dyness_request_failed (${path}): ${data.info || data.msg || `HTTP ${res.status}`}`,
      data.code != null ? String(data.code) : undefined,
    );
  }
  return (data.data ?? ({} as T)) as T;
}

// ─── Shapes ──────────────────────────────────────────────────────────────────

interface DynessDevice {
  deviceSn?: string;
  collectorSn?: string;
  deviceModelName?: string;
  stationName?: string;
  workStatus?: number | string;
  deviceCommunicationStatus?: number | string;
}
interface DynessRealtimePoint {
  pointId?: number | string;
  pointValue?: number | string;
}

const num = (v: unknown): number | undefined => {
  if (v == null || v === '') return undefined;
  const n = parseFloat(String(v)); // tolerates "-11W", "231.6V"
  return Number.isFinite(n) ? n : undefined;
};

// Realtime point IDs (Dyness Open API v1.1). SOC/power are the headline battery
// figures; 7300/7400 are lifetime/today discharge (energy delivered).
const PT = { soc: '800', powerW: '900', soh: '1200', chargedToday: '7200', chargedTotal: '7100', dischargedToday: '7400', dischargedTotal: '7300', sub: 'SUB' } as const;

function mapStatus(comm?: number | string, work?: number | string): StationStatus {
  const c = String(comm ?? '').toLowerCase();
  if (c === '0' || c === '-1' || c === 'offline') return 'offline';
  const w = String(work ?? '').toLowerCase();
  if (w === '3' || w === 'fault' || w === 'alarm') return 'partial';
  if (c === '1' || c === 'online' || c === 'normal' || w === '1') return 'online';
  return 'unknown';
}

/** Realtime point map for a device, cached briefly (respects the 1 req/s limit). */
function realtimeOf(sn: string, collectorSn?: string): Promise<Record<string, string>> {
  return cached(`dyness:rt:${sn}`, 60_000, async () => {
    const pts = await post<DynessRealtimePoint[]>('/v1/device/realTime/data', collectorSn ? { deviceSn: sn, collectorSn } : { deviceSn: sn });
    const byId: Record<string, string> = {};
    for (const p of pts ?? []) if (p.pointId != null) byId[String(p.pointId)] = String(p.pointValue ?? '');
    return byId;
  }).catch((): Record<string, string> => ({}));
}

function toStation(d: DynessDevice, rt: Record<string, string>): NormalizedStation {
  return {
    id: String(d.deviceSn ?? ''),
    name: (d.stationName || d.deviceModelName || d.deviceSn || 'Dyness device').trim(),
    status: mapStatus(d.deviceCommunicationStatus, d.workStatus),
    currentPowerW: num(rt[PT.powerW]),
    dailyEnergyKwh: num(rt[PT.dischargedToday]),
    totalEnergyKwh: num(rt[PT.dischargedTotal]),
    batterySoc: num(rt[PT.soc]),
  };
}

/** All devices bound to the app. */
async function listDevices(): Promise<DynessDevice[]> {
  const data = await post<{ list?: DynessDevice[]; records?: DynessDevice[] }>('/v1/device/storage/list', { pageNo: 1, pageSize: 200 });
  return (data.list ?? data.records ?? []).filter((d) => d.deviceSn);
}

export const dynessProvider: SolarProvider = {
  id: 'dyness',
  name: 'Dyness',
  configured: dynessConfigured,

  async listStations(): Promise<NormalizedStation[]> {
    const devices = await listDevices();
    // Enrich each device with its (cached) realtime snapshot for SOC/power/energy.
    return Promise.all(
      devices.map(async (d) => {
        const rt = d.deviceSn ? await realtimeOf(d.deviceSn, d.collectorSn) : {};
        return toStation(d, rt);
      }),
    );
  },

  async stationDetail(stationId: string): Promise<NormalizedDetail> {
    const devices = await listDevices().catch((): DynessDevice[] => []);
    const dev = devices.find((d) => d.deviceSn === stationId);
    const collectorSn = dev?.collectorSn;

    const [rt, stationInfo, alarms] = await Promise.all([
      realtimeOf(stationId, collectorSn),
      post<{ batteryCapacity?: number | string }>('/v1/station/info', { deviceSn: stationId }).catch((): { batteryCapacity?: number | string } => ({})),
      post<{ list?: { alarmName?: string; alarmCode?: string; alarmLevel?: string | number; occurTime?: string | number; deviceSn?: string }[]; records?: unknown[] }>(
        '/v1/alarm/query',
        { deviceSnList: [stationId], pageNum: 1, pageSize: 50 },
      ).catch((): { list?: never[] } => ({ list: [] })),
    ]);

    const info: StationInfoItem[] = [];
    const push = (label: string, v: string | number | undefined | null) => {
      if (v != null && v !== '') info.push({ label, value: String(v) });
    };
    push('Status', STATUS_LABEL[mapStatus(dev?.deviceCommunicationStatus, dev?.workStatus)]);
    push('Model', dev?.deviceModelName);
    push('Serial number', stationId);
    push('Collector SN', collectorSn);
    push('Battery SOC', num(rt[PT.soc]) != null ? `${num(rt[PT.soc])}%` : undefined);
    push('Battery SOH', num(rt[PT.soh]) != null ? `${num(rt[PT.soh])}%` : undefined);
    push('Battery capacity', stationInfo.batteryCapacity != null ? `${stationInfo.batteryCapacity} kWh` : undefined);
    push('Current power', num(rt[PT.powerW]) != null ? `${num(rt[PT.powerW])} W` : undefined);
    push('Charged today', num(rt[PT.chargedToday]) != null ? `${num(rt[PT.chargedToday])} kWh` : undefined);
    push('Charged total', num(rt[PT.chargedTotal]) != null ? `${num(rt[PT.chargedTotal])} kWh` : undefined);
    push('Discharged today', num(rt[PT.dischargedToday]) != null ? `${num(rt[PT.dischargedToday])} kWh` : undefined);
    push('Discharged total', num(rt[PT.dischargedTotal]) != null ? `${num(rt[PT.dischargedTotal])} kWh` : undefined);

    // The battery itself is the one device; sub-module SNs arrive in the "SUB" point.
    const devices2: NormalizedDevice[] = [];
    if (dev?.deviceSn) devices2.push({ sn: dev.deviceSn, type: dev.deviceModelName || 'Battery', online: mapStatus(dev.deviceCommunicationStatus, dev.workStatus) !== 'offline' });
    for (const subSn of (rt[PT.sub] || '').split(',').map((s) => s.trim()).filter(Boolean)) {
      devices2.push({ sn: subSn, type: 'Battery module', online: true });
    }

    const alarmList = (alarms.list ?? []) as { alarmName?: string; alarmCode?: string; alarmLevel?: string | number; occurTime?: string | number; deviceSn?: string }[];
    const normalizedAlerts: NormalizedAlert[] = alarmList.map((a, i) => ({
      id: `${a.alarmCode ?? i}`,
      name: a.alarmName || a.alarmCode || 'Alarm',
      code: a.alarmCode,
      deviceSn: a.deviceSn ?? stationId,
      level: a.alarmLevel != null ? String(a.alarmLevel) : undefined,
      start: num(a.occurTime),
    }));

    return {
      info,
      latest: {
        currentPowerW: num(rt[PT.powerW]),
        batterySoc: num(rt[PT.soc]),
        dailyEnergyKwh: num(rt[PT.dischargedToday]),
        totalEnergyKwh: num(rt[PT.dischargedTotal]),
      },
      devices: devices2,
      alerts: normalizedAlerts,
      power: [],
    };
  },
};

const STATUS_LABEL: Record<StationStatus, string> = {
  online: 'Online',
  waiting: 'Waiting',
  partial: 'Partial',
  offline: 'Offline',
  unknown: 'Unknown',
};
