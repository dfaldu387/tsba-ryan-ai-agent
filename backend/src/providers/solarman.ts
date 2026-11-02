import { createHash } from 'node:crypto';
import { env, solarmanConfigured } from '../env.js';
import {
  ProviderError,
  ProviderNotConfiguredError,
  type NormalizedStation,
  type NormalizedDetail,
  type SolarProvider,
  type StationStatus,
} from './types.js';

/**
 * Solarman Business Open API (globalapi.solarmanpv.com).
 *
 * Solarman is the platform that powers Deye, so the auth model mirrors it:
 * POST /account/v1.0/token with the app secret + account email and the SHA-256
 * hex of the password. Passing an orgId yields a business-scoped token. The
 * bearer token is cached and re-acquired on an invalid-token response.
 *
 * Status: endpoints are from Solarman community integrations; verify against
 * your business API docs once credentials are in (paths may differ by plan).
 */

const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

let token: { value: string; expiresAt: number } | null = null;

interface Envelope {
  success?: boolean;
  code?: string | number;
  msg?: string;
  [k: string]: unknown;
}

async function authenticate(): Promise<string> {
  if (!solarmanConfigured()) throw new ProviderNotConfiguredError('solarman');
  const url = `${env.solarmanBaseUrl}/account/v1.0/token?appId=${encodeURIComponent(env.solarmanAppId)}&language=en`;
  const body: Record<string, unknown> = {
    appSecret: env.solarmanAppSecret,
    email: env.solarmanEmail,
    password: sha256Hex(env.solarmanPassword),
  };
  if (env.solarmanOrgId) body.orgId = Number(env.solarmanOrgId) || env.solarmanOrgId;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch((err) => {
    throw new ProviderError(`solarman_network_error: ${(err as Error).message}`);
  });
  const data = (await res.json().catch(() => ({}))) as Envelope & { access_token?: string; expires_in?: number };
  if (data.success === false || !data.access_token) {
    throw new ProviderError(`solarman_auth_failed: ${data.msg || `HTTP ${res.status}`}`, data.code != null ? String(data.code) : undefined);
  }
  token = { value: data.access_token, expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000 - 60_000 };
  return data.access_token;
}

async function getToken(force = false): Promise<string> {
  if (!force && token && token.expiresAt > Date.now()) return token.value;
  return authenticate();
}

async function post<T extends Envelope>(path: string, body: Record<string, unknown>): Promise<T> {
  if (!solarmanConfigured()) throw new ProviderNotConfiguredError('solarman');
  const run = async (t: string) => {
    const res = await fetch(`${env.solarmanBaseUrl}${path}?language=en`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
      body: JSON.stringify(body),
    }).catch((err) => {
      throw new ProviderError(`solarman_network_error: ${(err as Error).message}`);
    });
    return (await res.json().catch(() => ({}))) as T;
  };
  let data = await run(await getToken());
  const code = data.code != null ? String(data.code) : '';
  if (data.success === false && /token|auth/i.test(`${data.msg || ''}${code}`)) {
    data = await run(await getToken(true));
  }
  if (data.success === false) {
    throw new ProviderError(`solarman_request_failed (${path}): ${data.msg || 'error'}`, code || undefined);
  }
  return data;
}

interface SolarmanStation {
  id: number;
  name?: string;
  networkStatus?: string;
  connectionStatus?: string;
  generationPower?: number;
  installedCapacity?: number;
  batterySoc?: number;
  locationAddress?: string;
  lastUpdateTime?: number;
}

function mapStatus(s?: string): StationStatus {
  const v = (s || '').toUpperCase();
  if (v.includes('ALL_ON') || v === 'NORMAL' || v === 'ONLINE') return 'online';
  if (v.includes('PART')) return 'partial';
  if (v.includes('OFF')) return 'offline';
  return 'unknown';
}

export const solarmanProvider: SolarProvider = {
  id: 'solarman',
  name: 'Solarman Business',
  configured: solarmanConfigured,

  async listStations(): Promise<NormalizedStation[]> {
    const data = await post<Envelope & { stationList?: SolarmanStation[] }>('/station/v1.0/list', { page: 1, size: 100 });
    return (data.stationList ?? []).map((s) => ({
      id: String(s.id),
      name: s.name || `Station ${s.id}`,
      status: mapStatus(s.networkStatus || s.connectionStatus),
      currentPowerW: s.generationPower,
      capacityKw: s.installedCapacity,
      batterySoc: s.batterySoc,
      location: s.locationAddress,
      lastUpdate: s.lastUpdateTime,
    }));
  },

  async stationDetail(stationId: string): Promise<NormalizedDetail> {
    const id = Number(stationId);
    const [latest, devices] = await Promise.all([
      post<Envelope & { generationPower?: number; usePower?: number; gridPower?: number; batteryPower?: number; batterySoc?: number; generationValue?: number; lastUpdateTime?: number }>(
        '/station/v1.0/realTime',
        { stationId: id },
      ).catch(() => null),
      post<Envelope & { deviceListItems?: { deviceSn?: string; deviceType?: string; connectStatus?: number | string }[] }>(
        '/station/v1.0/device',
        { stationId: id, page: 1, size: 100 },
      ).catch(() => null),
    ]);
    return {
      info: [],
      latest: latest
        ? {
            currentPowerW: latest.generationPower,
            consumptionPowerW: latest.usePower,
            gridPowerW: latest.gridPower,
            batteryPowerW: latest.batteryPower,
            batterySoc: latest.batterySoc,
            dailyEnergyKwh: latest.generationValue,
            lastUpdate: latest.lastUpdateTime,
          }
        : null,
      devices: (devices?.deviceListItems ?? []).map((d, i) => ({
        sn: d.deviceSn || String(i),
        type: d.deviceType,
        online: String(d.connectStatus ?? '').toUpperCase() === '1' || String(d.connectStatus).toUpperCase() === 'ONLINE',
      })),
      alerts: [],
      power: [],
    };
  },
};
