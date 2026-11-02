import { createHash, createHmac } from 'node:crypto';
import { env, solisConfigured } from '../env.js';
import {
  ProviderError,
  ProviderNotConfiguredError,
  type NormalizedStation,
  type NormalizedDetail,
  type SolarProvider,
  type StationStatus,
} from './types.js';

/**
 * SolisCloud API (www.soliscloud.com:13333).
 *
 * Auth: generate a KeyId + KeySecret in SolisCloud → API Management. Each
 * request is signed: Authorization = "API {keyId}:{sign}", where sign is the
 * base64 HMAC-SHA1 (with KeySecret) of
 *   "POST\n{Content-MD5}\napplication/json\n{Date}\n{resourcePath}".
 *
 * Status: paths are the documented SolisCloud ones; energy/power UNITS vary by
 * account (power may be kW; totals may carry a unit string) — verify against
 * live data once keys are in.
 */

const md5B64 = (s: string): string => createHash('md5').update(s, 'utf8').digest('base64');
const hmacSha1B64 = (key: string, s: string): string => createHmac('sha1', key).update(s, 'utf8').digest('base64');

interface Envelope<T> {
  success?: boolean | string;
  code?: string | number;
  msg?: string;
  data?: T;
}

async function post<T>(path: string, payload: Record<string, unknown>): Promise<T> {
  if (!solisConfigured()) throw new ProviderNotConfiguredError('solis');
  const body = JSON.stringify(payload);
  const contentMd5 = md5B64(body);
  const date = new Date().toUTCString();
  const toSign = `POST\n${contentMd5}\napplication/json\n${date}\n${path}`;
  const sign = hmacSha1B64(env.solisKeySecret, toSign);

  const res = await fetch(`${env.solisBaseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      'Content-MD5': contentMd5,
      Date: date,
      Authorization: `API ${env.solisKeyId}:${sign}`,
    },
    body,
  }).catch((err) => {
    throw new ProviderError(`solis_network_error: ${(err as Error).message}`);
  });

  const data = (await res.json().catch(() => ({}))) as Envelope<T>;
  const ok = data.success === true || data.success === 'true' || String(data.code) === '0';
  if (!ok) {
    throw new ProviderError(`solis_request_failed (${path}): ${data.msg || `HTTP ${res.status}`}`, data.code != null ? String(data.code) : undefined);
  }
  return (data.data ?? ({} as T)) as T;
}

interface SolisStation {
  id: string | number;
  stationName?: string;
  capacity?: number; // kWp
  power?: number; // current, usually kW
  dayEnergy?: number; // kWh
  monthEnergy?: number;
  allEnergy?: number; // total
  batteryPercent?: number;
  state?: number; // 1 online, 2 offline, 3 alarm
}

function mapStatus(state?: number): StationStatus {
  if (state === 1) return 'online';
  if (state === 3) return 'partial';
  if (state === 2) return 'offline';
  return 'unknown';
}

export const solisProvider: SolarProvider = {
  id: 'solis',
  name: 'SolisCloud',
  configured: solisConfigured,

  async listStations(): Promise<NormalizedStation[]> {
    const data = await post<{ page?: { records?: SolisStation[] } }>('/v1/api/userStationList', {
      pageNo: 1,
      pageSize: 100,
    });
    const records = data.page?.records ?? [];
    return records.map((s) => ({
      id: String(s.id),
      name: s.stationName || `Station ${s.id}`,
      status: mapStatus(s.state),
      // Solis `power` is typically kW → Watts.
      currentPowerW: s.power != null ? s.power * 1000 : undefined,
      capacityKw: s.capacity,
      dailyEnergyKwh: s.dayEnergy,
      monthlyEnergyKwh: s.monthEnergy,
      totalEnergyKwh: s.allEnergy,
      batterySoc: s.batteryPercent,
    }));
  },

  async stationDetail(stationId: string): Promise<NormalizedDetail> {
    const [detail, inverters] = await Promise.all([
      post<SolisStation & { power?: number; dayEnergy?: number; monthEnergy?: number; allEnergy?: number; batteryPercent?: number }>(
        '/v1/api/stationDetail',
        { id: stationId },
      ).catch(() => null),
      post<{ page?: { records?: { sn?: string; model?: string; state?: number }[] } }>('/v1/api/inverterList', {
        stationId,
        pageNo: 1,
        pageSize: 100,
      }).catch(() => null),
    ]);
    return {
      info: [],
      latest: detail
        ? {
            currentPowerW: detail.power != null ? detail.power * 1000 : undefined,
            dailyEnergyKwh: detail.dayEnergy,
            monthlyEnergyKwh: detail.monthEnergy,
            totalEnergyKwh: detail.allEnergy,
            batterySoc: detail.batteryPercent,
          }
        : null,
      devices: (inverters?.page?.records ?? []).map((d, i) => ({
        sn: d.sn || String(i),
        type: d.model,
        online: d.state === 1,
      })),
      alerts: [],
      power: [],
    };
  },
};
