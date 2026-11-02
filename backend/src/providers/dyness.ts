import { createHmac, randomUUID } from 'node:crypto';
import { env, dynessConfigured } from '../env.js';
import {
  ProviderError,
  ProviderNotConfiguredError,
  type NormalizedStation,
  type NormalizedDetail,
  type SolarProvider,
  type StationStatus,
} from './types.js';

/**
 * Dyness Open API v1.1 (ems.dyness.com).
 *
 * Credentials: App ID + Secret from ems.dyness.com → Developer Center → API
 * Management. Auth is HmacSHA1.
 *
 * ⚠️ UNVERIFIED: the exact signing string and endpoint paths come from the
 * "DYNESS Open API interface protocol" PDF, which I don't have yet. This is a
 * scaffold using the documented HmacSHA1 scheme and best-guess paths; confirm
 * the sign format + paths from the protocol doc, then adjust `sign()` and the
 * endpoints below. Gated by config, so it stays dormant until keys are set.
 */

const hmacSha1B64 = (key: string, s: string): string => createHmac('sha1', key).update(s, 'utf8').digest('base64');

interface Envelope<T> {
  code?: number | string;
  msg?: string;
  success?: boolean;
  data?: T;
}

// VERIFY against the protocol doc: likely signs appId + timestamp + nonce.
function sign(appId: string, secret: string, timestamp: string, nonce: string): string {
  return hmacSha1B64(secret, `${appId}${timestamp}${nonce}`);
}

async function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
  if (!dynessConfigured()) throw new ProviderNotConfiguredError('dyness');
  const timestamp = String(Date.now());
  const nonce = randomUUID();
  const res = await fetch(`${env.dynessBaseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'App-Id': env.dynessAppId,
      Timestamp: timestamp,
      Nonce: nonce,
      Sign: sign(env.dynessAppId, env.dynessAppSecret, timestamp, nonce),
    },
    body: JSON.stringify(body),
  }).catch((err) => {
    throw new ProviderError(`dyness_network_error: ${(err as Error).message}`);
  });
  const data = (await res.json().catch(() => ({}))) as Envelope<T>;
  const ok = data.success === true || String(data.code) === '0' || String(data.code) === '200';
  if (!ok) throw new ProviderError(`dyness_request_failed (${path}): ${data.msg || `HTTP ${res.status}`}`, data.code != null ? String(data.code) : undefined);
  return (data.data ?? ({} as T)) as T;
}

interface DynessStation {
  stationId?: string | number;
  id?: string | number;
  stationName?: string;
  name?: string;
  status?: number | string;
  power?: number;
  capacity?: number;
  dayEnergy?: number;
  totalEnergy?: number;
  soc?: number;
  address?: string;
}

function mapStatus(status?: number | string): StationStatus {
  const v = String(status ?? '').toLowerCase();
  if (v === '1' || v === 'online' || v === 'normal') return 'online';
  if (v === '0' || v === 'offline') return 'offline';
  return 'unknown';
}

export const dynessProvider: SolarProvider = {
  id: 'dyness',
  name: 'Dyness',
  configured: dynessConfigured,

  async listStations(): Promise<NormalizedStation[]> {
    // VERIFY path: /v1/station/list (protocol doc also shows /v1/station/info).
    const data = await post<{ list?: DynessStation[]; records?: DynessStation[] }>('/v1/station/list', {
      page: 1,
      size: 100,
    });
    const list = data.list ?? data.records ?? [];
    return list.map((s) => ({
      id: String(s.stationId ?? s.id),
      name: s.stationName || s.name || `Station ${s.stationId ?? s.id}`,
      status: mapStatus(s.status),
      currentPowerW: s.power,
      capacityKw: s.capacity,
      dailyEnergyKwh: s.dayEnergy,
      totalEnergyKwh: s.totalEnergy,
      batterySoc: s.soc,
      location: s.address,
    }));
  },

  async stationDetail(stationId: string): Promise<NormalizedDetail> {
    const rec = await post<DynessStation>('/v1/station/info', { stationId }).catch(() => null);
    return {
      info: [],
      latest: rec
        ? {
            currentPowerW: rec.power,
            dailyEnergyKwh: rec.dayEnergy,
            totalEnergyKwh: rec.totalEnergy,
            batterySoc: rec.soc,
          }
        : null,
      devices: [],
      alerts: [],
      power: [],
    };
  },
};
