import { ProviderError, OverviewUnsupportedError, type NormalizedStation, type SolarProvider } from './types.js';
import { applyGeocodes } from '../geocode.js';
import { env } from '../env.js';
import { invalidate } from './cache.js';
import { deyeProvider } from './deye-provider.js';
import { goodweProvider } from './goodwe.js';
import { solarmanProvider } from './solarman.js';
import { solarmanScraperProvider } from './scraper/solarman-scraper.js';
import { solisScraperProvider } from './scraper/solis-scraper.js';
import { elekeeperScraperProvider } from './scraper/elekeeper-scraper.js';
import { whesScraperProvider } from './scraper/whes-scraper.js';
import { sigenProvider } from './sigen-provider.js';
import { solisProvider } from './solis.js';
import { growattProvider } from './growatt.js';
import { sungrowProvider } from './sungrow.js';
import { dynessProvider } from './dyness.js';
import { esolarProvider } from './esolar.js';
import { whesProvider } from './whes.js';

/**
 * One platform served by two backends: prefer the API provider when its
 * credentials are present, else fall back to the portal scraper. Same id/name,
 * so the UI, agent and alerts treat it as a single platform.
 */
function withFallback(primary: SolarProvider, secondary: SolarProvider): SolarProvider {
  const active = () => (primary.configured() ? primary : secondary);
  return {
    id: primary.id,
    name: primary.name,
    configured: () => primary.configured() || secondary.configured(),
    optional: primary.optional || secondary.optional,
    listStations: () => active().listStations(),
    stationDetail: (id) => active().stationDetail(id),
    // Forward the rich Overview to whichever backend is active and supports it.
    overview: (id) => {
      const a = active();
      if (!a.overview) return Promise.reject(new OverviewUnsupportedError(a.id));
      return a.overview(id);
    },
  };
}

/** All known providers, in display order. Add new platforms here. */
export const PROVIDERS: SolarProvider[] = [
  deyeProvider,
  withFallback(solarmanProvider, solarmanScraperProvider),
  goodweProvider,
  withFallback(solisProvider, solisScraperProvider),
  growattProvider,
  sungrowProvider,
  dynessProvider,
  // SAJ/Elekeeper over plain HTTPS (no browser). The Chromium scraper stays as a
  // fallback if the portal credentials are ever missing.
  withFallback(esolarProvider, elekeeperScraperProvider),
  withFallback(whesProvider, whesScraperProvider),
  sigenProvider,
];

export function getProvider(id: string): SolarProvider | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

export function configuredProviders(): SolarProvider[] {
  return PROVIDERS.filter((p) => p.configured());
}

export type StationWithProvider = NormalizedStation & { provider: string };

export interface AggregateResult {
  stations: StationWithProvider[];
  /** Providers that failed with no cached fallback to fall back on. */
  errors: { provider: string; name: string; error: string }[];
  /** Providers currently served from the last-good cache (a transient failure). */
  stale: string[];
  /** Optional/unverified providers that couldn't return data (shown as
   *  "awaiting verification", not a hard error). */
  unavailable: string[];
}

// Last successful station list per provider — lets a transient network blip serve
// the previous snapshot instead of blanking the provider or flashing an error.
const lastGood = new Map<string, StationWithProvider[]>();

// Hard cap on how long ONE provider may take to return its station list. Without
// it, a single slow/hanging provider (a wedged scraper context, a provider API
// with no timeout of its own) blocks the whole Promise.all — so the monitoring
// page spins on the slowest platform. On timeout the provider falls back to its
// last-good data (marked stale) or is reported as an error, and the page returns
// promptly with every other platform's data.
const PROVIDER_TIMEOUT_MS = 12_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${Math.round(ms / 1000)}s`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

/**
 * Fetch every station across all configured providers, in parallel, resiliently:
 * each provider gets one retry, and on failure falls back to its last-good data.
 * Shared by the overview route and the agent's tools so both behave identically.
 */
// One in-flight station fetch per provider. A provider slower than the page
// timeout (GoodWe SEMS takes ~30s to answer QueryPowerStationMonitor) keeps
// running after the page stops waiting; when it lands it refreshes lastGood,
// and later sweeps reuse the same call instead of piling up new ones.
// Past this a provider is treated as down, not slow, so a real hang still
// surfaces as an error on the next sweep.
const SLOW_PROVIDER_CEILING_MS = 90_000;
const inflightList = new Map<string, Promise<StationWithProvider[]>>();

function fetchStations(p: SolarProvider): Promise<StationWithProvider[]> {
  let run = inflightList.get(p.id);
  if (!run) {
    run = withTimeout((async () => {
      let list: NormalizedStation[];
      try {
        list = await p.listStations();
      } catch {
        // One retry after a short pause covers a transient blip.
        await new Promise((r) => setTimeout(r, 400));
        list = await p.listStations();
      }
      const withProvider = list.map((s) => ({ ...s, provider: p.id }));
      lastGood.set(p.id, withProvider);
      return withProvider;
    })(), SLOW_PROVIDER_CEILING_MS).finally(() => inflightList.delete(p.id));
    inflightList.set(p.id, run);
    run.catch(() => {}); // a late rejection after a timeout must not go unhandled
  }
  return run;
}

class StillLoading extends Error {}

/** Last saved snapshot of a provider's plants (≤24 h old), shaped like a live list. Null if none. */
async function snapshotFallback(providerId: string): Promise<StationWithProvider[] | null> {
  if (env.storage !== 'postgres') return null;
  try {
    const { latestReadingsForProvider } = await import('../solar-repo.js');
    const rows = await latestReadingsForProvider(providerId);
    if (!rows.length) return null;
    const num = (v: number | null | undefined) => (v == null ? undefined : Number(v));
    return rows.map((r) => ({
      provider: providerId,
      id: r.station_id,
      name: r.name,
      status: (r.status as StationWithProvider['status']) ?? 'unknown',
      currentPowerW: num(r.current_power_w),
      dailyEnergyKwh: num(r.daily_kwh),
      monthlyEnergyKwh: num(r.monthly_kwh),
      totalEnergyKwh: num(r.total_kwh),
      capacityKw: num(r.capacity_kw),
      batterySoc: num(r.battery_soc),
      location: r.location ?? undefined,
      // No lastUpdate: the snapshot time is not when the plant last reported,
      // and showing it would make a long-offline plant look recent.
    }));
  } catch {
    return null;
  }
}

export async function aggregateStations(timeoutMs = PROVIDER_TIMEOUT_MS): Promise<AggregateResult> {
  const stations: StationWithProvider[] = [];
  const errors: AggregateResult['errors'] = [];
  const stale: string[] = [];
  const unavailable: string[] = [];

  await Promise.all(
    configuredProviders().map(async (p) => {
      try {
        // Bounded so a slow platform can't stall the page; the fetch itself keeps going.
        const run = fetchStations(p);
        const withProvider = await withTimeout(run, timeoutMs).catch((e) => {
          throw inflightList.get(p.id) === run ? new StillLoading((e as Error).message) : e;
        });
        stations.push(...withProvider);
      } catch (err) {
        // In-memory last-good first; after a restart/deploy there is none yet, so
        // fall back to the provider's most recent saved snapshot instead of
        // showing 0 plants while a slow portal scrape or API warms up.
        const cached = lastGood.get(p.id) ?? (await snapshotFallback(p.id));
        if (cached) {
          stations.push(...cached);
          stale.push(p.id);
        } else if (err instanceof StillLoading) {
          // Slow, not down: it is still answering. Its plants appear once it
          // lands; reporting it as unreachable would be a false alarm.
          stale.push(p.id);
        } else if (p.optional) {
          // Known-incomplete/unverified integration — don't raise a fleet error.
          unavailable.push(p.id);
        } else {
          // Full detail (API paths, upstream messages) stays in the server log;
          // the client only learns which kind of failure it was.
          const raw = (err as Error).message ?? '';
          console.warn(`[solar] ${p.id} unavailable:`, raw.slice(0, 300));
          const error = /auth|login|token|credential|sign/i.test(raw)
            ? 'Couldn’t sign in to this platform — check its credentials.'
            : /network|timeout|ECONN|ENOTFOUND|fetch failed/i.test(raw)
              ? 'The platform couldn’t be reached.'
              : /rate|too many|limit/i.test(raw)
                ? 'The platform is rate-limiting requests — retrying shortly.'
                : 'The platform returned an error.';
          errors.push({ provider: p.id, name: p.name, error });
        }
      }
    }),
  );

  // Plants whose platform reports no (or a 0,0) location get coordinates from
  // their address — cached, with unknown addresses geocoded in the background.
  const located = await applyGeocodes(stations).catch(() => stations);
  return { stations: located, errors, stale, unavailable };
}

// ─── Shared, stale-while-revalidate wrapper ─────────────────────────────────
// A full provider sweep takes ~10s+. The dashboard, Fleet pages and the alert
// bell all poll it, so without this each caller paid that wait separately.
// Now: concurrent callers share one in-flight sweep; a result younger than
// FRESH_MS is returned as is; an older one (up to STALE_MS) is returned
// instantly while a fresh sweep runs in the background.
const FRESH_MS = 30_000;
const STALE_MS = 10 * 60_000;
let cachedAgg: { at: number; value: AggregateResult } | null = null;
let inflightAgg: Promise<AggregateResult> | null = null;

function sweep(timeoutMs?: number): Promise<AggregateResult> {
  if (!inflightAgg) {
    inflightAgg = aggregateStations(timeoutMs)
      .then((value) => {
        cachedAgg = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        inflightAgg = null;
      });
  }
  return inflightAgg;
}

/**
 * @param opts.maxAgeMs  When set, a snapshot older than this is NOT served stale:
 *   the caller waits for a fresh sweep (falling back to the old snapshot only if
 *   that sweep fails). The alert monitor uses this so an outage is detected on
 *   the scan it happens, not one scan later.
 */
export async function aggregateStationsCached(opts?: { maxAgeMs?: number }): Promise<AggregateResult> {
  const age = cachedAgg ? Date.now() - cachedAgg.at : Infinity;
  if (cachedAgg && age < FRESH_MS) return cachedAgg.value;
  if (cachedAgg && opts?.maxAgeMs != null && age > opts.maxAgeMs) {
    const stale = cachedAgg.value;
    return sweep().catch(() => stale);
  }
  if (cachedAgg && age < STALE_MS) {
    void sweep().catch(() => {});
    return cachedAgg.value;
  }
  return sweep();
}

/** When the fleet snapshot served by aggregateStationsCached() was taken (ms epoch), or null. */
export function fleetUpdatedAt(): number | null {
  return cachedAgg?.at ?? null;
}

// ─── "Refresh now" ──────────────────────────────────────────────────────────
// Drops the per-provider station-list caches (portal scrapes are otherwise
// reused for minutes) and runs a sweep that waits long enough for a re-scrape,
// so the result matches what the vendor portals show right now. Sigenergy is
// left alone: its OpenAPI rate-limits to one call per ~5 min. Throttled so a
// burst of clicks can't hammer the portals.
const LIVE_CACHE_PREFIXES = ['scraper:', 'elekeeper:plants', 'dyness:rt', 'deye:rawlist'];
// A platform still answering after FORCE_TIMEOUT_MS (a slow portal scrape) keeps
// going in the background; it shows on the next poll instead of holding the button.
const FORCE_TIMEOUT_MS = 30_000;
const FORCE_MIN_GAP_MS = 60_000; // one forced re-scrape per minute, fleet-wide
let forcedAt = 0; // when the last forced refresh finished
let inflightForce: Promise<AggregateResult> | null = null;

export function refreshStationsNow(): Promise<AggregateResult> {
  if (inflightForce) return inflightForce; // a click already pulling: share it
  if (Date.now() - forcedAt < FORCE_MIN_GAP_MS) return aggregateStationsCached();
  inflightForce = (async () => {
    // A sweep already running started on old caches; let it finish first.
    if (inflightAgg) await inflightAgg.catch(() => {});
    for (const p of LIVE_CACHE_PREFIXES) invalidate(p);
    const result = await sweep(FORCE_TIMEOUT_MS);
    // Platforms that were still answering keep running; once they land, re-sweep
    // so the next poll gets their fresh data instead of the last-good copy.
    if (result.stale.length) {
      void Promise.allSettled([...inflightList.values()]).then(() => sweep()).catch(() => {});
    }
    return result;
  })().finally(() => {
    forcedAt = Date.now();
    inflightForce = null;
  });
  return inflightForce;
}

export * from './types.js';
