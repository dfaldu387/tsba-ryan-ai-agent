import type { Page } from 'playwright';
import { cached } from '../cache.js';
import {
  ProviderError,
  type NormalizedDetail,
  type NormalizedStation,
  type SolarProvider,
  type StationInfoItem,
} from '../types.js';
import { withSession } from './browser.js';
import { hasSession } from './session.js';

/**
 * Turns a per-portal scrape routine into a standard SolarProvider, so a scraped
 * platform behaves exactly like an API-backed one (same overview tiles, agent
 * tools and notifications). Scraping is slow and portals rate-limit, so the
 * station list is cached hard (default 10 min); detail falls back to the cached
 * list unless the portal module provides a richer per-plant scrape.
 */
export interface ScraperConfig {
  id: string;
  name: string;
  /** Key into the saved-session store (e.g. 'solarman'). */
  credKey: string;
  /** Scrape the fleet's stations. Receives a page seeded with the saved session. */
  scrapeStations: (page: Page) => Promise<NormalizedStation[]>;
  /** Optional richer per-plant scrape (opens a browser); otherwise detail is derived from the list. */
  scrapeDetail?: (page: Page, stationId: string) => Promise<NormalizedDetail>;
  /**
   * Build a detail WITHOUT a browser, from data already gathered during the
   * (cached) station-list scrape — e.g. a portal whose list endpoint returns
   * rich per-plant fields. Receives the cached normalized stations; the scraper
   * typically also keeps its own raw records keyed by id. Preferred over
   * scrapeDetail when available (no extra page load).
   */
  detailFromList?: (stationId: string, stations: NormalizedStation[]) => NormalizedDetail | null;
  /** Station-list cache TTL (ms). Default 10 min. */
  ttlMs?: number;
}

export function createScraperProvider(cfg: ScraperConfig): SolarProvider {
  const ttl = cfg.ttlMs ?? 600_000;

  const fetchStations = (): Promise<NormalizedStation[]> =>
    cached(
      `scraper:${cfg.id}:stations`,
      ttl,
      async () => {
        try {
          return await withSession(cfg.credKey, (page) => cfg.scrapeStations(page));
        } catch (err) {
          // SessionExpiredError and scrape errors both surface here; the message
          // tells the operator to re-run portal-login/capture when the session lapsed.
          throw new ProviderError(`${cfg.id}_scrape_failed: ${(err as Error).message}`);
        }
      },
      // Serve the last good scrape instantly and refresh in the background, so a
      // dashboard load never blocks ~10–20s on a re-scrape once warmed.
      { swr: true },
    );

  return {
    id: cfg.id,
    name: cfg.name,
    // "Configured" once a login session has been captured for this portal.
    configured: () => hasSession(cfg.credKey),

    listStations: fetchStations,

    async stationDetail(stationId: string): Promise<NormalizedDetail> {
      // Preferred: a live per-plant scrape (devices, real-time flow, curve). Falls
      // back to the list-based detail if it fails (session blip, UI change).
      if (cfg.scrapeDetail) {
        try {
          return await withSession(cfg.credKey, (page) => cfg.scrapeDetail!(page, stationId));
        } catch {
          /* fall through to the list-based detail below */
        }
      }
      // The cached station list — best-effort, never let a failed re-scrape turn
      // the detail request into a hard error ("Couldn't load this station's data").
      let stations: NormalizedStation[] = [];
      try {
        stations = await fetchStations();
      } catch {
        /* scrape failed / session lapsed — fall back to whatever we have */
      }
      // From the scraper's own cached raw records (no network needed).
      if (cfg.detailFromList) {
        try {
          const built = cfg.detailFromList(stationId, stations);
          if (built) return built;
        } catch {
          /* ignore and derive a minimal detail below */
        }
      }
      // Fallback: derive a minimal detail from the cached station list.
      const s = stations.find((x) => x.id === stationId);
      const info: StationInfoItem[] = [];
      if (s) {
        const push = (label: string, v: string | number | undefined) => {
          if (v != null && v !== '') info.push({ label, value: String(v) });
        };
        push('Status', s.status);
        push('Location', s.location);
        push('Installed capacity', s.capacityKw != null ? `${s.capacityKw} kWp` : undefined);
        push('Today', s.dailyEnergyKwh != null ? `${s.dailyEnergyKwh} kWh` : undefined);
        push('Total', s.totalEnergyKwh != null ? `${s.totalEnergyKwh} kWh` : undefined);
        push('Battery SOC', s.batterySoc != null ? `${s.batterySoc}%` : undefined);
      }
      return {
        info,
        latest: s
          ? {
              currentPowerW: s.currentPowerW,
              dailyEnergyKwh: s.dailyEnergyKwh,
              totalEnergyKwh: s.totalEnergyKwh,
              batterySoc: s.batterySoc,
            }
          : null,
        devices: [],
        alerts: [],
        power: [],
      };
    },
  };
}
