import { env, elekeeperConfigured } from '../env.js';
import {
  ProviderError,
  ProviderNotConfiguredError,
  type NormalizedStation,
  type NormalizedDetail,
  type SolarProvider,
  type StationStatus,
} from './types.js';

/**
 * Elekeeper (SAJ eSolar) Open API v2.
 *
 * Credentials: a developer App ID + Secret, authorized by the plant owner /
 * distributor in the Elekeeper web portal (Developer Management). Auth is
 * token-based (fetch an access token, then call plant endpoints with it).
 *
 * ⚠️ UNVERIFIED: SAJ's "Quick Guidelines of Elekeeper API" PDF isn't
 * text-extractable here, so the token path, header name and plant endpoints are
 * best-guess. Confirm against the SAJ developer docs, then adjust. Gated by
 * config, so dormant until keys are set.
 */

let token: { value: string; expiresAt: number } | null = null;

interface Envelope<T> {
  code?: number | string;
  msg?: string;
  data?: T;
}

async function authenticate(): Promise<string> {
  if (!elekeeperConfigured()) throw new ProviderNotConfiguredError('elekeeper');
  // VERIFY: token endpoint + param names.
  const res = await fetch(`${env.elekeeperBaseUrl}/open/api/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId: env.elekeeperAppId, appSecret: env.elekeeperAppSecret }),
  }).catch((err) => {
    throw new ProviderError(`elekeeper_network_error: ${(err as Error).message}`);
  });
  const data = (await res.json().catch(() => ({}))) as Envelope<{ access_token?: string; expires_in?: number }>;
  const tok = data.data?.access_token;
  if (!tok) throw new ProviderError(`elekeeper_auth_failed: ${data.msg || `HTTP ${res.status}`}`, data.code != null ? String(data.code) : undefined);
  token = { value: tok, expiresAt: Date.now() + (Number(data.data?.expires_in) || 3600) * 1000 - 60_000 };
  return tok;
}

async function getToken(force = false): Promise<string> {
  if (!force && token && token.expiresAt > Date.now()) return token.value;
  return authenticate();
}

async function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
  if (!elekeeperConfigured()) throw new ProviderNotConfiguredError('elekeeper');
  const run = async (t: string) => {
    const res = await fetch(`${env.elekeeperBaseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', accessToken: t },
      body: JSON.stringify(body),
    }).catch((err) => {
      throw new ProviderError(`elekeeper_network_error: ${(err as Error).message}`);
    });
    return (await res.json().catch(() => ({}))) as Envelope<T>;
  };
  let data = await run(await getToken());
  if (String(data.code) !== '0' && /token|auth/i.test(`${data.msg || ''}${data.code || ''}`)) {
    data = await run(await getToken(true));
  }
  if (String(data.code) !== '0' && data.data == null) {
    throw new ProviderError(`elekeeper_request_failed (${path}): ${data.msg || 'error'}`, data.code != null ? String(data.code) : undefined);
  }
  return (data.data ?? ({} as T)) as T;
}

interface SajPlant {
  plantId?: string | number;
  plantName?: string;
  runningState?: number | string;
  nowPower?: number; // W or kW
  totalPlantCapacity?: number; // kWp
  todayEnergy?: number;
  monthEnergy?: number;
  totalEnergy?: number;
  plantAddress?: string;
}

function mapStatus(state?: number | string): StationStatus {
  const v = String(state ?? '').toLowerCase();
  if (v === '1' || v === 'normal' || v === 'online') return 'online';
  if (v === '2' || v === 'alarm' || v === 'partial') return 'partial';
  if (v === '0' || v === 'offline') return 'offline';
  return 'unknown';
}

export const elekeeperProvider: SolarProvider = {
  id: 'elekeeper',
  name: 'Elekeeper (SAJ)',
  configured: elekeeperConfigured,

  async listStations(): Promise<NormalizedStation[]> {
    // VERIFY: plant list path + pagination param names.
    const data = await post<{ list?: SajPlant[]; rows?: SajPlant[] }>('/open/api/plant/page', { pageNum: 1, pageSize: 100 });
    const list = data.list ?? data.rows ?? [];
    return list.map((p) => ({
      id: String(p.plantId),
      name: p.plantName || `Plant ${p.plantId}`,
      status: mapStatus(p.runningState),
      currentPowerW: p.nowPower,
      capacityKw: p.totalPlantCapacity,
      dailyEnergyKwh: p.todayEnergy,
      monthlyEnergyKwh: p.monthEnergy,
      totalEnergyKwh: p.totalEnergy,
      location: p.plantAddress,
    }));
  },

  async stationDetail(stationId: string): Promise<NormalizedDetail> {
    const rec = await post<SajPlant>('/open/api/plant/detail', { plantId: stationId }).catch(() => null);
    return {
      info: [],
      latest: rec
        ? {
            currentPowerW: rec.nowPower,
            dailyEnergyKwh: rec.todayEnergy,
            monthlyEnergyKwh: rec.monthEnergy,
            totalEnergyKwh: rec.totalEnergy,
          }
        : null,
      devices: [],
      alerts: [],
      power: [],
    };
  },
};
