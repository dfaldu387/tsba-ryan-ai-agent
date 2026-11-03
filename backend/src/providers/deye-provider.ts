import { deyeConfigured } from '../env.js';
import {
  listStationAlerts,
  listStationDevices,
  listStations,
  stationEnergy,
  stationLatest,
  stationPowerCurve,
} from '../deye.js';
import { cached } from './cache.js';
import type { DeyeStation } from '../deye.js';
import type {
  NormalizedStation,
  NormalizedDetail,
  SolarProvider,
  StationInfoItem,
  StationStatus,
} from './types.js';

const fmtDateTime = (epochSec?: number) =>
  epochSec ? new Date(epochSec * 1000).toLocaleString() : undefined;
const fmtDate = (epochSec?: number) => (epochSec ? new Date(epochSec * 1000).toLocaleDateString() : undefined);
const prettyGrid = (g?: string) =>
  g ? g.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : undefined;

/** Build the plant-details list from a Deye station record. */
function buildInfo(s: DeyeStation): StationInfoItem[] {
  const items: [string, string | number | undefined][] = [
    ['Status', STATUS_LABEL[mapStatus(s.connectionStatus)]],
    ['Location', s.locationAddress],
    [
      'Coordinates',
      s.locationLat != null && s.locationLng != null
        ? `${s.locationLat.toFixed(5)}, ${s.locationLng.toFixed(5)}`
        : undefined,
    ],
    ['Installed capacity', s.installedCapacity != null ? `${s.installedCapacity} kWp` : undefined],
    ['Owner', s.ownerName ?? undefined],
    ['Contact', s.contactPhone || undefined],
    ['Grid type', prettyGrid(s.gridInterconnectionType)],
    ['Battery SOC', s.batterySOC != null ? `${s.batterySOC}%` : undefined],
    ['Country', s.countryCode || undefined],
    ['Timezone', s.regionTimezone],
    ['Commissioned', fmtDate(s.startOperatingTime)],
    ['Created', fmtDate(s.createdDate)],
    ['Last update', fmtDateTime(s.lastUpdateTime)],
    ['Station ID', String(s.id)],
  ];
  return items
    .filter(([, v]) => v != null && v !== '')
    .map(([label, v]) => ({ label, value: String(v) }));
}

const STATUS_LABEL: Record<StationStatus, string> = {
  online: 'Online',
  waiting: 'Waiting',
  partial: 'Partial',
  offline: 'Offline',
  unknown: 'Unknown',
};

function mapStatus(connectionStatus?: string): StationStatus {
  const s = (connectionStatus || '').toUpperCase();
  if (s.includes('ALL_ON') || s === 'ONLINE' || s === 'NORMAL') return 'online';
  if (s.includes('PART')) return 'partial';
  if (s.includes('OFF')) return 'offline';
  return 'unknown';
}

const deviceOnline = (state?: number | string): boolean => {
  const s = String(state ?? '').toUpperCase();
  return s === '1' || s === 'ONLINE' || s === 'NORMAL';
};

export const deyeProvider: SolarProvider = {
  id: 'deye',
  name: 'Deye Cloud',
  configured: deyeConfigured,

  async listStations(): Promise<NormalizedStation[]> {
    // Power / status / SOC come from the station list, fetched fresh on every
    // call so the 60s poll reflects live power. Energy totals change slowly and
    // need 3 history calls per station, so they're cached per station for 5 min.
    const stations = await listStations();
    return Promise.all(
      stations.map(async (s): Promise<NormalizedStation> => {
        const energy = await cached(`deye:energy:${s.id}`, 300_000, () => stationEnergy(s.id)).catch(
          (): import('../deye.js').DeyeEnergy => ({}),
        );
        return {
          id: String(s.id),
          name: s.name || `Station ${s.id}`,
          status: mapStatus(s.connectionStatus),
          currentPowerW: s.generationPower,
          // Deye's installedCapacity is already in kW (peak) — matches the kWp
          // in the dashboard. (generationPower, by contrast, is in Watts.)
          capacityKw: s.installedCapacity,
          dailyEnergyKwh: energy.daily,
          monthlyEnergyKwh: energy.monthly,
          totalEnergyKwh: energy.yearly,
          batterySoc: s.batterySOC,
          location: s.locationAddress,
          lastUpdate: s.lastUpdateTime,
        };
      }),
    );
  },

  async stationDetail(stationId: string): Promise<NormalizedDetail> {
    const id = Number(stationId);
    const [latest, devices, alerts, power, stations] = await Promise.all([
      stationLatest(id).catch(() => null),
      listStationDevices(id).catch(() => []),
      listStationAlerts(id).catch(() => []),
      stationPowerCurve(id).catch(() => []),
      cached('deye:rawlist', 60_000, () => listStations()).catch((): DeyeStation[] => []),
    ]);
    const record = stations.find((x) => x.id === id);

    return {
      info: record ? buildInfo(record) : [],
      latest: latest
        ? {
            currentPowerW: latest.generationPower,
            consumptionPowerW: latest.consumptionPower,
            gridPowerW: latest.gridPower,
            batteryPowerW: latest.batteryPower,
            batterySoc: latest.batterySOC,
            lastUpdate: latest.lastUpdateTime,
          }
        : null,
      devices: devices.map((d) => ({
        sn: d.deviceSn || '',
        type: d.deviceType,
        // Deye's device endpoint reports online state in `connectStatus`
        // (1 = online); `deviceState` is a fallback for other tenants.
        online: deviceOnline(d.connectStatus ?? d.deviceState),
      })),
      alerts: alerts.map((a, i) => ({
        id: String(a.alertId ?? i),
        name: a.alertName || a.alertCode || 'Alert',
        code: a.alertCode,
        deviceSn: a.deviceSn,
        start: a.alertStartTime,
        level: a.level != null ? String(a.level) : undefined,
      })),
      power: power
        .filter((p) => p.timeStamp)
        .map((p) => ({ t: p.timeStamp as number, powerW: p.generationPower ?? 0 })),
    };
  },
};
