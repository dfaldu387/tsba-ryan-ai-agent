import type { NormalizedStation, SolarProvider } from './types.js';
import { deyeProvider } from './deye-provider.js';
import { goodweProvider } from './goodwe.js';
import { solarmanProvider } from './solarman.js';
import { solisProvider } from './solis.js';
import { growattProvider } from './growatt.js';
import { sungrowProvider } from './sungrow.js';
import { dynessProvider } from './dyness.js';
import { elekeeperProvider } from './elekeeper.js';
import { whesProvider } from './whes.js';

/** All known providers, in display order. Add new platforms here. */
export const PROVIDERS: SolarProvider[] = [
  deyeProvider,
  solarmanProvider,
  goodweProvider,
  solisProvider,
  growattProvider,
  sungrowProvider,
  dynessProvider,
  elekeeperProvider,
  whesProvider,
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
}

// Last successful station list per provider — lets a transient network blip serve
// the previous snapshot instead of blanking the provider or flashing an error.
const lastGood = new Map<string, StationWithProvider[]>();

/**
 * Fetch every station across all configured providers, in parallel, resiliently:
 * each provider gets one retry, and on failure falls back to its last-good data.
 * Shared by the overview route and the agent's tools so both behave identically.
 */
export async function aggregateStations(): Promise<AggregateResult> {
  const stations: StationWithProvider[] = [];
  const errors: AggregateResult['errors'] = [];
  const stale: string[] = [];

  await Promise.all(
    configuredProviders().map(async (p) => {
      const attempt = () => p.listStations();
      try {
        let list: NormalizedStation[];
        try {
          list = await attempt();
        } catch {
          // One retry after a short pause — covers a transient timeout/blip.
          await new Promise((r) => setTimeout(r, 400));
          list = await attempt();
        }
        const withProvider = list.map((s) => ({ ...s, provider: p.id }));
        lastGood.set(p.id, withProvider);
        stations.push(...withProvider);
      } catch (err) {
        const cached = lastGood.get(p.id);
        if (cached) {
          stations.push(...cached);
          stale.push(p.id);
        } else {
          errors.push({ provider: p.id, name: p.name, error: (err as Error).message });
        }
      }
    }),
  );

  return { stations, errors, stale };
}

export * from './types.js';
