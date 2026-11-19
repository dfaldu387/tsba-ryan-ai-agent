import { deyeConfigured } from '../env.js';
import {
  DeyeError,
  listStationAlerts,
  listStationDevices,
  listStations,
  stationEnergy,
  stationLatest,
  stationPowerCurve,
} from '../deye.js';
import { cached, peek } from './cache.js';
import { isBackground } from './priority.js';
import type { DeyePowerPoint, DeyeStation, DeyeStationLatest } from '../deye.js';
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

/**
 * Is a Deye alarm still active? It has ended when Deye reports an end time at or
 * after its start that is already in the past. No end time (null/0) = ongoing.
 */
function deyeAlertActive(a: import('../deye.js').DeyeAlert): boolean {
  const end = Number(a.alertEndTime);
  if (!Number.isFinite(end) || end <= 0) return true;
  const start = Number(a.alertStartTime);
  if (Number.isFinite(start) && start > 0 && end < start) return true; // nonsense end → treat as open
  return end * 1000 > Date.now();
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
        // Energy calls run one at a time on the Deye lane (≈1 min for a cold
        // fleet), so don't hold the plant list on them: wait briefly, and if the
        // cache is still cold the totals show on the next refresh.
        const energy = await Promise.race([
          // 15 min: totals move slowly, and this is 3 calls × every plant against
          // Deye's tight account quota (5 min used most of it on its own).
          cached(`deye:energy:${s.id}`, 15 * 60_000, () => stationEnergy(s.id), { swr: true }),
          new Promise<import('../deye.js').DeyeEnergy>((r) => setTimeout(() => r({}), 2_000)),
        ]).catch((): import('../deye.js').DeyeEnergy => ({}));
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
          owner: s.ownerName ?? undefined,
          contact: s.contactPhone || undefined,
          lat: s.locationLat,
          lng: s.locationLng,
          lastUpdate: s.lastUpdateTime,
        };
      }),
    );
  },

  async stationDetail(stationId: string): Promise<NormalizedDetail> {
    const id = Number(stationId);
    // Deye's account-wide rate limit is tight, and the fleet alert scan calls this
    // for every plant every 2 min. Cache each part per plant (shared by the scan,
    // the plant page and the AI tools) with stale-while-revalidate, so a refresh
    // that gets rate-limited serves the last good data instead of an empty list.
    const part = <T,>(name: string, ttl: number, fn: () => Promise<T>) =>
      cached(`deye:${name}:${id}`, ttl, fn, { swr: true });
    let failed = 0;
    const soft = <T,>(p: Promise<T>, fallback: T): Promise<T> =>
      p.catch(() => {
        failed++;
        return fallback;
      });
    // The fleet fault scan (background) needs only devices + alarms. Fetching the
    // live reading and power curve too made it 4 calls × 61 plants per pass —
    // more than Deye's account quota allows (~40 calls / 20 s, shared with every
    // server using these credentials), so every plant timed out and NO Deye
    // faults were detected. In the scan those two parts reuse whatever a plant
    // page last fetched (no call); plant pages still fetch all four live.
    const scan = isBackground();
    const [latest, devices, alerts, power, stations] = await Promise.all([
      scan ? Promise.resolve(peek<DeyeStationLatest>(`deye:latest:${id}`) ?? null) : soft(part('latest', 60_000, () => stationLatest(id)), null),
      soft(part('devices', 300_000, () => listStationDevices(id)), []),
      soft(part('alerts', 300_000, () => listStationAlerts(id)), []),
      scan ? Promise.resolve(peek<DeyePowerPoint[]>(`deye:power:${id}`) ?? []) : soft(part('power', 300_000, () => stationPowerCurve(id)), []),
      cached('deye:rawlist', 60_000, () => listStations(), { swr: true }).catch((): DeyeStation[] => []),
    ]);
    // Nothing came back (typically Deye rate-limiting the account): fail loudly
    // so callers use the last saved copy, instead of an "empty" plant that
    // shows no devices — and would overwrite the good saved copy, or make the
    // alert scan think this plant's faults had cleared.
    if (failed === (scan ? 2 : 4)) throw new DeyeError('deye_unavailable: no data returned for this plant (rate-limited?)');
    const record = stations.find((x) => x.id === id);

    return {
      info: record ? buildInfo(record) : [],
      latest: latest
        ? {
            currentPowerW: latest.generationPower,
            consumptionPowerW: latest.consumptionPower,
            // Deye leaves gridPower null on most hybrid plants; wirePower is the grid-side power.
            gridPowerW: latest.gridPower ?? latest.wirePower ?? latest.purchasePower,
            batteryPowerW: latest.batteryPower,
            batterySoc: latest.batterySOC,
            lastUpdate: latest.lastUpdateTime,
          }
        : null,
      devices: devices.map((d) => {
        const sn = d.deviceSn || '';
        // Deye's device endpoint reports online state in `connectStatus`
        // (1 = online); `deviceState` is a fallback for other tenants.
        const online = deviceOnline(d.connectStatus ?? d.deviceState);
        // It has no alarm state, though: the Deye portal shows a device as
        // "Alerts" when it's communicating but has an alarm still open, so
        // derive the same from the alarm list (e.g. ERR1 meter comm fail).
        const alarm = online && alerts.some((a) => a.deviceSn === sn && deyeAlertActive(a));
        return {
          sn,
          type: d.deviceType,
          online,
          state: !online ? 'offline' : alarm ? 'alarm' : 'normal',
        } satisfies import('./types.js').NormalizedDevice;
      }),
      // alertList is a 30-day HISTORY window: cleared alarms come back too, with an
      // alertEndTime. Keep them all (the plant page shows history) but flag which
      // are still active so the monitor only alerts on live faults.
      alerts: alerts.map((a, i) => ({
        id: String(a.alertId ?? i),
        name: a.alertName || a.alertCode || 'Alert',
        code: a.alertCode,
        deviceSn: a.deviceSn,
        start: a.alertStartTime,
        end: a.alertEndTime || undefined,
        active: deyeAlertActive(a),
        level: a.level != null ? String(a.level) : undefined,
      })),
      power: power
        .filter((p) => p.timeStamp)
        .map((p) => ({ t: p.timeStamp as number, powerW: p.generationPower ?? 0 })),
    };
  },
};
