import { env, growattConfigured } from '../env.js';
import {
  ProviderError,
  ProviderNotConfiguredError,
  type NormalizedStation,
  type NormalizedDetail,
  type SolarProvider,
  type StationStatus,
} from './types.js';

/**
 * Growatt OpenAPI v1 (openapi.growatt.com).
 *
 * Auth: a long-lived API token created in the Growatt web portal (Account
 * Management → API Token), sent in the `token` request header. Regional hosts
 * exist (EU/global default, plus CN, US, AU) — set GROWATT_BASE_URL.
 *
 * Status: paths/field names are from the community v1 client; verify once the
 * token is in. Note Growatt's v1 plant/list stopped returning devices in 2026,
 * so devices come from /v1/device/list.
 */

interface Envelope<T> {
  error_code?: number;
  error_msg?: string;
  data?: T;
}

async function get<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
  if (!growattConfigured()) throw new ProviderNotConfiguredError('growatt');
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
  const url = `${env.growattBaseUrl}${path}${qs ? `?${qs}` : ''}`;
  const res = await fetch(url, { method: 'GET', headers: { token: env.growattToken } }).catch((err) => {
    throw new ProviderError(`growatt_network_error: ${(err as Error).message}`);
  });
  const data = (await res.json().catch(() => ({}))) as Envelope<T>;
  if (data.error_code != null && data.error_code !== 0) {
    throw new ProviderError(`growatt_request_failed (${path}): ${data.error_msg || `code ${data.error_code}`}`, String(data.error_code));
  }
  return (data.data ?? ({} as T)) as T;
}

interface GrowattPlant {
  plant_id?: number | string;
  name?: string;
  status?: number | string;
  current_power?: number; // W or kW depending on account
  today_energy?: number; // kWh
  monthly_energy?: number;
  total_energy?: number;
  peak_power?: number; // kW
}

function mapStatus(status?: number | string): StationStatus {
  const v = String(status ?? '').toLowerCase();
  if (v === '1' || v === 'online' || v === 'normal') return 'online';
  if (v === '0' || v === 'offline') return 'offline';
  if (v === 'fault' || v === '2') return 'partial';
  return 'unknown';
}

export const growattProvider: SolarProvider = {
  id: 'growatt',
  name: 'Growatt',
  configured: growattConfigured,

  async listStations(): Promise<NormalizedStation[]> {
    const data = await get<{ count?: number; plants?: GrowattPlant[] }>('/v1/plant/list');
    return (data.plants ?? []).map((p) => ({
      id: String(p.plant_id),
      name: p.name || `Plant ${p.plant_id}`,
      status: mapStatus(p.status),
      currentPowerW: p.current_power,
      dailyEnergyKwh: p.today_energy,
      monthlyEnergyKwh: p.monthly_energy,
      totalEnergyKwh: p.total_energy,
      capacityKw: p.peak_power,
    }));
  },

  async stationDetail(stationId: string): Promise<NormalizedDetail> {
    const [data, devices] = await Promise.all([
      get<{ current_power?: number; today_energy?: number; monthly_energy?: number; total_energy?: number }>(
        '/v1/plant/data',
        { plant_id: stationId },
      ).catch(() => null),
      get<{ devices?: { device_sn?: string; type?: string | number; status?: number | string }[] }>('/v1/device/list', {
        plant_id: stationId,
      }).catch(() => null),
    ]);
    return {
      info: [],
      latest: data
        ? {
            currentPowerW: data.current_power,
            dailyEnergyKwh: data.today_energy,
            monthlyEnergyKwh: data.monthly_energy,
            totalEnergyKwh: data.total_energy,
          }
        : null,
      devices: (devices?.devices ?? []).map((d, i) => ({
        sn: d.device_sn || String(i),
        type: d.type != null ? String(d.type) : undefined,
        online: String(d.status ?? '').toLowerCase() === '1' || String(d.status).toLowerCase() === 'online',
      })),
      alerts: [],
      power: [],
    };
  },
};
