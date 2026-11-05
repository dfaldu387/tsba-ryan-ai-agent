import { env } from './env.js';
import { getStorage } from './storage.js';
import { aggregateStations } from './providers/index.js';
import { getSolarAlerts } from './solar-alerts.js';
import { pruneSolarReadings } from './solar-repo.js';
import type { SolarFleetReading, SolarStationReading } from './stores/types.js';

/**
 * Background recorder: every SOLAR_SNAPSHOT_INTERVAL_MIN it fetches the live
 * fleet (via the same cached aggregate the dashboard uses) and persists a
 * per-station snapshot plus a fleet aggregate. This turns the otherwise
 * live-pass-through solar data into a durable time series, so the dashboard can
 * fall back to last-known readings during a provider outage and historical
 * trends (e.g. monthly production — including for providers whose own API has
 * no history) can be charted from our own store.
 */

let timer: NodeJS.Timeout | null = null;
let running = false;

const sum = (xs: (number | undefined)[]): number | null => {
  const vals = xs.filter((v): v is number => v != null);
  return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
};

/** Run one capture now. Exported so a route/test can force a snapshot. */
export async function captureSolarSnapshot(): Promise<{ stations: number } | null> {
  const { stations } = await aggregateStations();
  // Nothing to record (no providers configured, or a cold/empty fetch) — skip so
  // we don't write a bogus all-zero row.
  if (stations.length === 0) return null;

  const rows: SolarStationReading[] = stations.map((s) => ({
    provider: s.provider,
    station_id: s.id,
    name: s.name,
    status: s.status,
    current_power_w: s.currentPowerW ?? null,
    daily_kwh: s.dailyEnergyKwh ?? null,
    monthly_kwh: s.monthlyEnergyKwh ?? null,
    total_kwh: s.totalEnergyKwh ?? null,
    capacity_kw: s.capacityKw ?? null,
    battery_soc: s.batterySoc ?? null,
    location: s.location ?? null,
  }));

  // Device totals come from the alert scan, which fans a detail call out to every
  // plant and can take a minute+ on a cold cache. It's best-effort for the
  // snapshot, so time-box it: if it's slow, write the row now with null device
  // counts rather than blocking the whole capture (a warm scan fills them in).
  let totalDevices: number | null = null;
  let onlineDevices: number | null = null;
  try {
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 25_000));
    const a = await Promise.race([getSolarAlerts(), timeout]);
    if (a) {
      totalDevices = a.totalDevices ?? null;
      onlineDevices = a.onlineDevices ?? null;
    }
  } catch {
    /* device counts are best-effort */
  }

  const byStatus = (st: string) => stations.filter((s) => s.status === st).length;
  const fleet: SolarFleetReading = {
    systems: stations.length,
    online: byStatus('online'),
    waiting: byStatus('waiting'),
    partial: byStatus('partial'),
    offline: byStatus('offline'),
    total_power_w: sum(stations.map((s) => s.currentPowerW)),
    total_daily_kwh: sum(stations.map((s) => s.dailyEnergyKwh)),
    total_energy_kwh: sum(stations.map((s) => s.totalEnergyKwh)),
    total_capacity_kw: sum(stations.map((s) => s.capacityKw)),
    total_devices: totalDevices,
    online_devices: onlineDevices,
  };

  const storage = await getStorage();
  await storage.solar.record(rows, fleet);
  return { stations: rows.length };
}

async function tick(): Promise<void> {
  if (running) return; // never overlap captures
  running = true;
  try {
    const res = await captureSolarSnapshot();
    if (res && env.storage === 'postgres' && env.solarRetentionDays > 0) {
      await pruneSolarReadings(env.solarRetentionDays).catch(() => {});
    }
  } catch (err) {
    console.error('[solar-recorder] capture failed:', (err as Error).message);
  } finally {
    running = false;
  }
}

/** Start the periodic recorder. No-op when the interval is 0 (disabled). */
export function startSolarRecorder(): void {
  const minutes = env.solarSnapshotIntervalMin;
  if (!minutes || minutes <= 0) {
    console.log('[solar-recorder] disabled (SOLAR_SNAPSHOT_INTERVAL_MIN=0)');
    return;
  }
  // First capture shortly after boot (let provider sessions warm up), then every
  // `minutes`.
  setTimeout(() => void tick(), 30_000);
  timer = setInterval(() => void tick(), minutes * 60_000);
  // Don't keep the process alive solely for the recorder.
  timer.unref?.();
  console.log(`[solar-recorder] every ${minutes} min, retention ${env.solarRetentionDays}d (storage: ${env.storage})`);
}

export function stopSolarRecorder(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
