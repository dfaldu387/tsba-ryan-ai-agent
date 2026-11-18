import { aggregateStationsCached, getProvider } from './providers/index.js';
import { cached } from './providers/cache.js';
import { inBackground } from './providers/priority.js';
import type { SolarMonitorAlert } from './providers/types.js';
import { env } from './env.js';
import type { DetailCapture } from './plant-history-repo.js';

/**
 * Health scan across the whole fleet for the header notification panel: plants
 * that are offline/partial, individual devices that are disconnected, and
 * provider-reported active faults. The device/fault checks need one detail call
 * per plant, so the whole scan is cached server-side (~2 min): it runs at most
 * once per interval no matter how many admins poll the endpoint.
 */
export interface SolarAlertsResult {
  alerts: SolarMonitorAlert[];
  /**
   * Which plants this scan could actually see, as "provider:plantId" keys:
   * `listed` = present in the fleet overview, `detailed` = per-plant detail
   * (devices + faults) fetched successfully. The alert monitor only treats an
   * issue as cleared when its plant was really checked — a timed-out detail
   * call or a missing provider must not read as "recovered".
   */
  coverage?: { listed: string[]; detailed: string[] };
  generatedAt: number;
  scannedPlants: number;
  /**
   * Total devices (inverters, batteries, loggers, meters) reported across the
   * fleet, summed from the per-plant detail scan. Counts only plants that were
   * scanned (offline plants are skipped). Providers whose API doesn't expose a
   * device list — notably Sigenergy's OpenAPI — contribute 0 here.
   */
  totalDevices: number;
  /** Of `totalDevices`, how many are communicating (online). */
  onlineDevices: number;
  /** Platforms that couldn't be reached for the plant list. */
  errors: { provider: string; name: string; error: string }[];
}

const SCAN_TTL_MS = 120_000;

// Hard cap per plant's detail call so one slow/hanging provider (a wedged scraper
// context, a provider HTTP call with no timeout of its own) can't stall the whole
// fleet scan — which would make /api/solar/alerts hang and the alert monitor never
// complete a pass. A timed-out plant is simply skipped for this scan.
const DETAIL_CALL_TIMEOUT_MS = 20_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('detail_timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

// Cap how many plant-detail scans run at once. Most providers derive detail
// from the cached station list (cheap), but some (e.g. Elekeeper) open a live
// browser context per plant — an unbounded fan-out across a large fleet could
// spawn dozens of concurrent Chromium contexts and exhaust the server's memory.
const DETAIL_SCAN_CONCURRENCY = 4;

// Offline plants: when each last had its detail saved (see collectSolarAlerts).
const OFFLINE_CAPTURE_EVERY_MS = 6 * 3_600_000;
const offlineCapturedAt = new Map<string, number>();

/** Run `worker` over `items` with at most `limit` in flight at any time. */
async function mapLimit<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await worker(item);
    }
  });
  await Promise.all(runners);
}

/**
 * @param opts.fresh  Wait for a current scan instead of serving an expired one.
 *   UI pollers use the default (instant, stale-while-revalidate); the alert
 *   monitor passes `fresh` so it reacts to an outage on the scan it happens —
 *   with SWR it would only see the previous scan's (≈1 interval old) result.
 */
export function getSolarAlerts(opts?: { fresh?: boolean }): Promise<SolarAlertsResult> {
  // Stale-while-revalidate: once primed, an expired scan is served instantly and
  // refreshed in the background, so this endpoint never blocks a request on the
  // multi-second (cold: multi-minute) fleet detail scan. The very first call
  // still computes; it's primed at boot (see index.ts) so users never hit it.
  if (opts?.fresh) return cached('solar:alerts', SCAN_TTL_MS, () => collectSolarAlerts(true));
  return cached('solar:alerts', SCAN_TTL_MS, () => collectSolarAlerts(false), { swr: true });
}

/** Lower-cased, trimmed key part. */
const norm = (s: string | undefined): string => (s ?? '').trim().toLowerCase();

/** Is a provider alarm still live? Explicit `active:false` or a cleared status means no. */
function alarmActive(a: { active?: boolean; status?: string }): boolean {
  if (a.active === false) return false;
  if (a.status && /recover|clear|resolv|closed|restor|turned off|^off$|^ended$|^done$/i.test(a.status)) return false;
  return true;
}

async function collectSolarAlerts(fresh: boolean): Promise<SolarAlertsResult> {
  const { stations, errors } = await aggregateStationsCached(fresh ? { maxAgeMs: 2 * 60_000 } : undefined);
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
        lat: s.lat,
        lng: s.lng,
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
        lat: s.lat,
        lng: s.lng,
      });
    }
  }

  // Device-level issues: scan detail only for plants that aren't fully offline —
  // an offline plant's devices are all offline, which the plant alert already
  // covers, so scanning them would just add noise. Fan out in parallel; a single
  // plant's failure is swallowed so it can't sink the whole scan.
  const toScan = stations.filter((s) => s.status !== 'offline');
  const detailed: string[] = [];
  const captures: DetailCapture[] = []; // saved to the DB after the scan (devices, alarms, curves)
  let totalDevices = 0;
  let onlineDevices = 0;

  // Offline plants raise no device/fault alerts (the plant alert covers them),
  // but their plant page still needs a saved copy to fall back on when the
  // platform is slow or rate-limiting — otherwise it shows "Couldn't load this"
  // with no devices at all. Refresh that copy at most every 6 h per plant, low
  // priority, so it costs little of the platform's quota.
  if (env.storage === 'postgres') {
    const now = Date.now();
    const offline = stations.filter(
      (s) => s.status === 'offline' && now - (offlineCapturedAt.get(`${s.provider}:${s.id}`) ?? 0) > OFFLINE_CAPTURE_EVERY_MS,
    );
    await mapLimit(offline, DETAIL_SCAN_CONCURRENCY, async (s) => {
      const provider = getProvider(s.provider);
      if (!provider) return;
      try {
        const detail = await withTimeout(inBackground(() => provider.stationDetail(s.id)), DETAIL_CALL_TIMEOUT_MS);
        captures.push({ provider: s.provider, stationId: s.id, detail });
        offlineCapturedAt.set(`${s.provider}:${s.id}`, now);
      } catch {
        /* try again next scan */
      }
    });
  }
  await mapLimit(toScan, DETAIL_SCAN_CONCURRENCY, async (s) => {
      const provider = getProvider(s.provider);
      if (!provider) return;
      try {
        // Background priority: on rate-limited platforms (Deye) a person opening a
        // plant page goes ahead of this fleet-wide scan.
        const detail = await withTimeout(inBackground(() => provider.stationDetail(s.id)), DETAIL_CALL_TIMEOUT_MS);
        detailed.push(`${s.provider}:${s.id}`);
        captures.push({ provider: s.provider, stationId: s.id, detail });
        // Fleet device tally (JS is single-threaded, so these increments are safe
        // across the concurrent workers).
        totalDevices += detail.devices.length;
        onlineDevices += detail.devices.filter((d) => d.online !== false).length;
        for (const d of detail.devices) {
          if (d.online === false) {
            alerts.push({
              // SAJ meters share the inverter's SN, so add the type to keep ids unique.
              id: `${s.provider}:${s.id}:device:${d.sn}${d.type ? `:${d.type}` : ''}`,
              severity: 'device',
              provider: s.provider,
              plant: s.name,
              plantId: s.id,
              title: `${d.type || 'Device'} offline at ${s.name}`,
              detail: `Device ${d.sn} is not communicating.`,
              deviceSn: d.sn,
              lat: s.lat,
              lng: s.lng,
            });
          }
        }
        // Only LIVE faults raise alerts (some platforms return a history window
        // with cleared alarms in it). Repeats of the same fault on the same device
        // collapse into ONE issue (the latest occurrence), keyed by fault + device
        // rather than the platform's per-occurrence id — so a fault that keeps
        // re-triggering is one open issue, and it "recovers" when it truly clears.
        const live = new Map<string, (typeof detail.alerts)[number]>();
        for (const a of detail.alerts) {
          if (!alarmActive(a)) continue;
          const sig = `${norm(a.code) || norm(a.name)}:${norm(a.deviceSn)}`;
          const prev = live.get(sig);
          if (!prev || (a.start ?? 0) > (prev.start ?? 0)) live.set(sig, a);
        }
        for (const [sig, a] of live) {
          // Detail line: fault code and provider-reported handling status, when known.
          const detailBits = [
            a.code ? `Fault code ${a.code}` : null,
            a.level ? `Level ${a.level}` : null,
            a.status ? `Status: ${a.status}` : null,
            a.reason ? `Cause: ${a.reason}` : null,
          ].filter(Boolean);
          alerts.push({
            id: `${s.provider}:${s.id}:fault:${sig}`,
            severity: 'alert',
            provider: s.provider,
            plant: s.name,
            plantId: s.id,
            title: `${a.name}${a.deviceSn ? ` (${a.deviceSn})` : ''} — ${s.name}`,
            detail: detailBits.length ? detailBits.join(' · ') : undefined,
            deviceSn: a.deviceSn,
            at: a.start,
            // Carry the provider's own remediation + status through to the email.
            solution: a.solution,
            status: a.status,
            lat: s.lat,
            lng: s.lng,
          });
        }
      } catch {
        /* one plant's detail failed — skip it, keep the rest of the scan */
      }
  });

  // Most severe first, then alphabetical by plant.
  const rank: Record<string, number> = { offline: 0, partial: 1, fault: 1, alert: 2, device: 3 };
  alerts.sort((a, b) => rank[a.severity] - rank[b.severity] || a.plant.localeCompare(b.plant));

  // Persist what this scan fetched: latest detail per plant, today's curve and
  // alarm history. Best-effort — a DB hiccup must not fail the alert scan.
  if (env.storage === 'postgres' && captures.length) {
    try {
      const { saveDetails } = await import('./plant-history-repo.js');
      await saveDetails(captures);
    } catch (err) {
      console.warn('[solar-alerts] could not save plant detail history:', (err as Error).message);
    }
  }

  const listed = stations.map((s) => `${s.provider}:${s.id}`);
  return { alerts, coverage: { listed, detailed }, generatedAt: Date.now(), scannedPlants: toScan.length, totalDevices, onlineDevices, errors };
}
