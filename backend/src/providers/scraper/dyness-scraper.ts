import type { Page } from 'playwright';
import type { NormalizedStation, StationStatus } from '../types.js';
import { SessionExpiredError } from './browser.js';
import { createScraperProvider } from './scraper-provider.js';

/**
 * Dyness scraper — portal apacems.dyness.com ("Smart Energy Storage Cloud
 * Platform", APAC region). Dev API on hold. Plant list page /plantCenter/plantManage
 * fires POST /api/gateway/ems-device/station/list; we ride it and rewrite the body
 * to a large page size. The TSBA Dyness account currently has 0 plants, so this
 * returns an empty list (the UI then shows the Dyness tab with a "no plants" state);
 * it will pick up plants automatically if any are added. Field mapping is defensive
 * since no live record was available to confirm exact names.
 */

const PLANT_URL = 'https://apacems.dyness.com/plantCenter/plantManage';
const LIST_MATCH = '/ems-device/station/list';

type DynStation = Record<string, unknown>;

const num = (v: unknown): number | undefined => {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};
const str = (v: unknown): string | undefined => (v == null || v === '' ? undefined : String(v));

function mapStatus(v: unknown): StationStatus {
  const s = String(v ?? '').toLowerCase();
  if (s === '1' || s === 'online' || s === 'normal' || s === 'run') return 'online';
  if (s === '2' || s === 'alarm' || s === 'fault' || s === 'partial') return 'partial';
  if (s === '0' || s === '-1' || s === 'offline') return 'offline';
  return 'unknown';
}

function toStation(s: DynStation): NormalizedStation {
  return {
    id: String(s.stationId ?? s.id ?? s.stationNo ?? s.stationSn ?? ''),
    name: (str(s.stationName) ?? str(s.plantName) ?? str(s.name) ?? String(s.stationId ?? 'Station')).trim(),
    status: mapStatus(s.runState ?? s.status ?? s.onlineStatus ?? s.stationStatus),
    currentPowerW: num(s.power ?? s.activePower ?? s.pvPower),
    dailyEnergyKwh: num(s.todayEnergy ?? s.dayEnergy ?? s.eToday),
    totalEnergyKwh: num(s.totalEnergy ?? s.eTotal),
    capacityKw: num(s.capacity ?? s.installedCapacity ?? s.ratedPower),
    batterySoc: num(s.soc ?? s.batSoc),
    location: str(s.address ?? s.stationAddr ?? s.addr),
  };
}

async function scrapeStations(page: Page): Promise<NormalizedStation[]> {
  let body: string | null = null;

  await page.route(`**${LIST_MATCH}`, (route) => {
    try {
      const b = JSON.parse(route.request().postData() || '{}');
      b.pageNum = 1;
      b.pageSize = 200;
      void route.continue({ postData: JSON.stringify(b) });
    } catch {
      void route.continue();
    }
  });
  page.on('response', async (resp) => {
    if (resp.url().includes(LIST_MATCH) && resp.status() === 200 && !body) {
      try {
        body = await resp.text();
      } catch {
        /* ignore */
      }
    }
  });

  await page.goto(PLANT_URL, { waitUntil: 'networkidle', timeout: 40_000 }).catch(() => {});
  if (/\/login/i.test(page.url())) throw new SessionExpiredError('dyness');
  await page.waitForTimeout(3500);
  if (!body) throw new Error('station list response not captured');

  const data = JSON.parse(body) as { data?: { list?: DynStation[]; records?: DynStation[] } };
  const list = data.data?.list ?? data.data?.records ?? [];
  return list.map(toStation).filter((s) => s.id);
}

export const dynessScraperProvider = createScraperProvider({
  id: 'dyness',
  name: 'Dyness',
  credKey: 'dyness',
  scrapeStations,
});
