import { ProviderError, type NormalizedStation, type SolarProvider } from './types.js';
import { applyGeocodes } from '../geocode.js';
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
      if (!a.overview) throw new ProviderError(`${a.id}_overview_unsupported`);
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

export async function aggregateStations(): Promise<AggregateResult> {
  const stations: StationWithProvider[] = [];
  const errors: AggregateResult['errors'] = [];
  const stale: string[] = [];
  const unavailable: string[] = [];

  await Promise.all(
    configuredProviders().map(async (p) => {
      try {
        // Bounded so a slow platform can't stall the page; the fetch itself keeps going.
        const run = fetchStations(p);
        const withProvider = await withTimeout(run, PROVIDER_TIMEOUT_MS).catch((e) => {
          throw inflightList.get(p.id) === run ? new StillLoading((e as Error).message) : e;
        });
        stations.push(...withProvider);
      } catch (err) {
        const cached = lastGood.get(p.id);
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
          errors.push({ provider: p.id, name: p.name, error: (err as Error).message });
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

function sweep(): Promise<AggregateResult> {
  if (!inflightAgg) {
    inflightAgg = aggregateStations()
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

export async function aggregateStationsCached(): Promise<AggregateResult> {
  const age = cachedAgg ? Date.now() - cachedAgg.at : Infinity;
  if (cachedAgg && age < FRESH_MS) return cachedAgg.value;
  if (cachedAgg && age < STALE_MS) {
    void sweep().catch(() => {});
    return cachedAgg.value;
  }
  return sweep();
}

export * from './types.js';
