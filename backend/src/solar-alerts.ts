import { aggregateStations, getProvider } from './providers/index.js';
import { cached } from './providers/cache.js';
import type { SolarMonitorAlert } from './providers/types.js';

/**
 * Health scan across the whole fleet for the header notification panel: plants
 * that are offline/partial, individual devices that are disconnected, and
 * provider-reported active faults. The device/fault checks need one detail call
 * per plant, so the whole scan is cached server-side (~2 min): it runs at most
 * once per interval no matter how many admins poll the endpoint.
 */
export interface SolarAlertsResult {
  alerts: SolarMonitorAlert[];
  generatedAt: number;
  scannedPlants: number;
  /** Platforms that couldn't be reached for the plant list. */
  errors: { provider: string; name: string; error: string }[];
}

const SCAN_TTL_MS = 120_000;

export function getSolarAlerts(): Promise<SolarAlertsResult> {
  return cached('solar:alerts', SCAN_TTL_MS, collectSolarAlerts);
}

async function collectSolarAlerts(): Promise<SolarAlertsResult> {
  const { stations, errors } = await aggregateStations();
  const alerts: SolarMonitorAlert[] = [];

  // Plant-level issues straight from the overview (cheap, no extra calls).
  for (const s of stations) {
    if (s.status === 'offline') {
      alerts.push({
        id: `${s.provider}:${s.id}:offline`,
        severity: 'offline',
        provider: s.provider,
        plant: s.name,
        plantId: s.id,
        title: `${s.name} is offline`,
        detail: 'The plant is not reporting to its monitoring platform.',
      });
    } else if (s.status === 'partial') {
      alerts.push({
        id: `${s.provider}:${s.id}:partial`,
        severity: 'partial',
        provider: s.provider,
        plant: s.name,
        plantId: s.id,
        title: `${s.name} is partially down`,
        detail: 'The plant reports a partial or fault state.',
      });
    }
  }

  // Device-level issues: scan detail only for plants that aren't fully offline —
  // an offline plant's devices are all offline, which the plant alert already
  // covers, so scanning them would just add noise. Fan out in parallel; a single
  // plant's failure is swallowed so it can't sink the whole scan.
  const toScan = stations.filter((s) => s.status !== 'offline');
  await Promise.all(
    toScan.map(async (s) => {
      const provider = getProvider(s.provider);
      if (!provider) return;
      try {
        const detail = await provider.stationDetail(s.id);
        for (const d of detail.devices) {
          if (d.online === false) {
            alerts.push({
              id: `${s.provider}:${s.id}:device:${d.sn}`,
              severity: 'device',
              provider: s.provider,
              plant: s.name,
              plantId: s.id,
              title: `${d.type || 'Device'} offline at ${s.name}`,
              detail: `Device ${d.sn} is not communicating.`,
              deviceSn: d.sn,
            });
          }
        }
        for (const a of detail.alerts) {
          alerts.push({
            id: `${s.provider}:${s.id}:alert:${a.id}`,
            severity: 'alert',
            provider: s.provider,
            plant: s.name,
            plantId: s.id,
            title: `${a.name}${a.deviceSn ? ` (${a.deviceSn})` : ''} — ${s.name}`,
            detail: a.code ? `Fault code ${a.code}` : undefined,
            deviceSn: a.deviceSn,
            at: a.start,
          });
        }
      } catch {
        /* one plant's detail failed — skip it, keep the rest of the scan */
      }
    }),
  );

  // Most severe first, then alphabetical by plant.
  const rank: Record<string, number> = { offline: 0, partial: 1, fault: 1, alert: 2, device: 3 };
  alerts.sort((a, b) => rank[a.severity] - rank[b.severity] || a.plant.localeCompare(b.plant));

  return { alerts, generatedAt: Date.now(), scannedPlants: toScan.length, errors };
}
