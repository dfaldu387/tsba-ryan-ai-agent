import type { Page } from 'playwright';
import type { NormalizedStation, StationStatus } from '../types.js';
import { SessionExpiredError } from './browser.js';
import { createScraperProvider } from './scraper-provider.js';

/**
 * SolisCloud scraper (API access on hold). Rides the portal's own authenticated
 * POST /api/station/list, rewriting the body to pageSize=100 so one request
 * returns the whole fleet, then reads that JSON response.
 */

const OVERVIEW_URL = 'https://www.soliscloud.com/overview/plantStation';
const LIST_MATCH = '/api/station/list';

interface SolisStation {
  id: string;
  stationName?: string;
  state?: number; // 1 online, 2 offline, 3 alarm
  power?: number;
  powerStr?: string; // unit, e.g. "kW"
  dayEnergy?: number; // kWh
  monthEnergy?: number; // kWh
  allEnergy1?: number; // kWh all-time
  capacity?: number; // kWp
  addr?: string;
  dataTimestamp?: string; // ms
}

function mapState(state?: number): StationStatus {
  if (state === 1) return 'online';
  if (state === 3) return 'partial';
  if (state === 2) return 'offline';
  return 'unknown';
}

function powerToW(v?: number, unit?: string): number | undefined {
  if (v == null) return undefined;
  const u = (unit || 'W').toLowerCase();
  if (u.startsWith('mw')) return v * 1_000_000;
  if (u.startsWith('kw')) return v * 1000;
  return v;
}

function toStation(s: SolisStation): NormalizedStation {
  return {
    id: String(s.id),
    name: (s.stationName || `Station ${s.id}`).trim(),
    status: mapState(s.state),
    currentPowerW: powerToW(s.power, s.powerStr),
    dailyEnergyKwh: s.dayEnergy,
    monthlyEnergyKwh: s.monthEnergy,
    totalEnergyKwh: s.allEnergy1,
    capacityKw: s.capacity,
    location: s.addr,
    lastUpdate: s.dataTimestamp ? Math.floor(Number(s.dataTimestamp) / 1000) : undefined,
  };
}

async function scrapeStations(page: Page): Promise<NormalizedStation[]> {
  let body: string | null = null;

  await page.route(`**${LIST_MATCH}`, (route) => {
    try {
      const raw = route.request().postData() || '{}';
      const b = JSON.parse(raw);
      b.pageNo = 1;
      b.pageSize = 100;
      void route.continue({ postData: JSON.stringify(b) });
    } catch {
      void route.continue();
    }
  });
  page.on('response', async (resp) => {
    if (resp.url().includes(LIST_MATCH) && resp.status() === 200 && !body) {
      try {
        const t = await resp.text();
        if (t.includes('records') || t.includes('page')) body = t;
      } catch {
        /* ignore */
      }
    }
  });

  await page.goto(OVERVIEW_URL, { waitUntil: 'networkidle', timeout: 40_000 }).catch(() => {});
  if (/login/i.test(page.url())) throw new SessionExpiredError('solis');
  await page.waitForTimeout(3500);
  if (!body) throw new Error('station list response not captured');

  const data = JSON.parse(body) as { data?: { records?: SolisStation[]; page?: { records?: SolisStation[] } } };
  const records = data.data?.records ?? data.data?.page?.records ?? [];
  return records.map(toStation);
}

export const solisScraperProvider = createScraperProvider({
  id: 'solis',
  name: 'SolisCloud',
  credKey: 'solis',
  scrapeStations,
});
