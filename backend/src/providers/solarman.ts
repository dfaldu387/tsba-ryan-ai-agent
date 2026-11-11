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
 * Endpoints verified against the Solarman Open API manual + community clients:
 *   POST /account/v1.0/token      — bearer (orgId ⇒ Business-scoped token)
 *   POST /station/v1.0/list       — fleet  → { stationList: [...] }
 *   POST /station/v1.0/realTime   — one plant's live snapshot
 *   POST /station/v1.0/device     — one plant's device list
 *   POST /device/v1.0/alertList   — a device's alarms (available for faults)
 * Dormant until SOLARMAN_APP_ID/SECRET are set (Business API access must be
 * granted by Solarman). Rate limit: ~50 calls/min per account.
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
  generationPower?: number; // W
  installedCapacity?: number; // kWp
  batterySoc?: number;
  locationAddress?: string;
  lastUpdateTime?: number; // epoch seconds
  // Richer fields the Business list also returns (all optional/defensive).
  generationValue?: number; // today kWh
  generationTotal?: number; // all-time kWh
  gridInterconnectionType?: string;
  startOperatingTime?: number; // epoch seconds
  ownerName?: string;
  creatorName?: string;
  contactPhone?: string;
  nmi?: string;
}

function mapStatus(s?: string): StationStatus {
  const v = (s || '').toUpperCase();
  if (v.includes('ALL_ON') || v === 'NORMAL' || v === 'ONLINE') return 'online';
  if (v.includes('PART')) return 'partial';
  if (v.includes('OFF')) return 'offline';
  return 'unknown';
}

// Device list fields vary (connectStatus 0/1 vs deviceState 1 online/2 alarm/3
// offline); treat a device as online unless something clearly marks it down.
interface SolarmanDevice {
  deviceSn?: string;
  deviceType?: string;
  connectStatus?: number | string;
  deviceState?: number | string;
  deviceStatus?: number | string;
}
function deviceOnline(d: SolarmanDevice): boolean {
  const cs = String(d.connectStatus ?? '').toUpperCase();
  if (cs === '0' || cs === 'OFFLINE') return false;
  const st = String(d.deviceState ?? d.deviceStatus ?? '').toUpperCase();
  if (st === '3' || st === 'OFFLINE') return false;
  return true;
}

// Last fleet list, kept so stationDetail can build its info without re-fetching.
const rawById = new Map<string, SolarmanStation>();

const tsDate = (sec?: number): string | undefined =>
  sec ? new Date(sec * 1000).toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' }) : undefined;

function toStation(s: SolarmanStation): NormalizedStation {
  return {
    id: String(s.id),
    name: s.name || `Station ${s.id}`,
    status: mapStatus(s.networkStatus || s.connectionStatus),
    currentPowerW: s.generationPower,
    dailyEnergyKwh: s.generationValue,
    totalEnergyKwh: s.generationTotal,
    capacityKw: s.installedCapacity,
    batterySoc: s.batterySoc,
    location: s.locationAddress,
    owner: s.ownerName || s.creatorName || undefined,
    contact: s.contactPhone || undefined,
    lastUpdate: s.lastUpdateTime,
  };
}

function infoFromStation(s: SolarmanStation): { label: string; value: string }[] {
  const info: { label: string; value: string }[] = [];
  const push = (label: string, v: string | number | undefined | null) => {
    if (v != null && v !== '') info.push({ label, value: String(v) });
  };
  push('Location', s.locationAddress);
  push('Owner', s.ownerName || s.creatorName);
  push('Contact', s.contactPhone);
  push('Installed capacity', s.installedCapacity != null ? `${s.installedCapacity} kWp` : undefined);
  push('Today', s.generationValue != null ? `${s.generationValue} kWh` : undefined);
  push('Total', s.generationTotal != null ? `${s.generationTotal} kWh` : undefined);
  push('Grid type', s.gridInterconnectionType);
  push('NMI', s.nmi);
  push('Commissioned', tsDate(s.startOperatingTime));
  push('Last update', tsDate(s.lastUpdateTime));
  push('Station ID', s.id);
  return info;
}

export const solarmanProvider: SolarProvider = {
  id: 'solarman',
  name: 'Solarman Business',
  configured: solarmanConfigured,

  async listStations(): Promise<NormalizedStation[]> {
    const data = await post<Envelope & { stationList?: SolarmanStation[] }>('/station/v1.0/list', { page: 1, size: 200 });
    const list = data.stationList ?? [];
    rawById.clear();
    for (const s of list) rawById.set(String(s.id), s);
    return list.map(toStation);
  },

  async stationDetail(stationId: string): Promise<NormalizedDetail> {
    const id = Number(stationId);
    const [latest, devices] = await Promise.all([
      post<Envelope & { generationPower?: number; usePower?: number; gridPower?: number; batteryPower?: number; batterySoc?: number; generationValue?: number; lastUpdateTime?: number }>(
        '/station/v1.0/realTime',
        { stationId: id },
      ).catch(() => null),
      post<Envelope & { deviceListItems?: SolarmanDevice[] }>('/station/v1.0/device', {
        stationId: id,
        page: 1,
        size: 100,
      }).catch(() => null),
    ]);

    const rec = rawById.get(stationId);
    return {
      info: rec ? infoFromStation(rec) : [],
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
        online: deviceOnline(d),
      })),
      alerts: [],
      power: [],
    };
  },
};
