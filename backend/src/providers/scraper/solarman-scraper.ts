import type { Page } from 'playwright';
import type { NormalizedDetail, NormalizedStation, StationInfoItem, StationStatus } from '../types.js';
import { SessionExpiredError } from './browser.js';
import { createScraperProvider } from './scraper-provider.js';

/**
 * Solarman Business scraper. The developer API is on hold, so we read the fleet
 * from the web portal using a session captured from a real browser (Cloudflare
 * Turnstile only guards the login page, not the data API).
 *
 * Technique: navigate to the plant page and let the portal's own app make its
 * authenticated `/operating/station/v2/search` XHR, but rewrite the query so it
 * returns the whole fleet in one page, then read that JSON response. Replaying
 * the request out-of-band 500s (server rejects it), so we ride the app's call.
 *
 * That list endpoint returns rich per-plant fields, so the detail page is built
 * from the cached raw records (no extra page load / fragile row-clicking).
 */

const PLANT_URL = 'https://globalpro.solarmanpv.com/business/maintain/plant';
const SEARCH_MATCH = '/operating/station/v2/search';

interface SolarmanStation {
  id: number;
  name?: string;
  locationAddress?: string;
  installedCapacity?: number; // kW
  networkStatus?: string; // NORMAL | ALL_OFFLINE | PARTIAL_OFFLINE | NO_DEVICE
  generationPower?: number; // W (current)
  generationValue?: number; // kWh today
  generationMonth?: number; // kWh
  generationYear?: number; // kWh
  generationTotal?: number; // kWh all-time
  usePower?: number; // W (consumption)
  useMonth?: number; // kWh
  useYear?: number; // kWh
  fullPowerHoursDay?: number;
  gridInterconnectionType?: string;
  type?: string;
  startOperatingTime?: number; // epoch seconds
  regionTimezone?: string;
  creatorName?: string;
  nmi?: string;
  lastUpdateTime?: number; // epoch seconds
}

// Raw records from the last list scrape, keyed by station id — used to build the
// detail page without another page load.
const rawById = new Map<string, SolarmanStation>();

function mapStatus(net?: string): StationStatus {
  switch (net) {
    case 'NORMAL':
      return 'online';
    case 'PARTIAL_OFFLINE':
      return 'partial';
    case 'ALL_OFFLINE':
    case 'NO_DEVICE':
      return 'offline';
    default:
      return 'unknown';
  }
}

function statusLabel(net?: string): string {
  const map: Record<string, string> = {
    NORMAL: 'Online',
    PARTIAL_OFFLINE: 'Partially offline',
    ALL_OFFLINE: 'Offline',
    NO_DEVICE: 'No device',
  };
  return net ? map[net] ?? net : 'Unknown';
}

function toStation(s: SolarmanStation): NormalizedStation {
  return {
    id: String(s.id),
    name: (s.name || `Station ${s.id}`).trim(),
    status: mapStatus(s.networkStatus),
    currentPowerW: s.generationPower,
    dailyEnergyKwh: s.generationValue,
    monthlyEnergyKwh: s.generationMonth,
    totalEnergyKwh: s.generationTotal,
    capacityKw: s.installedCapacity,
    location: s.locationAddress,
    lastUpdate: s.lastUpdateTime,
  };
}

const GRID_TYPE_LABEL: Record<string, string> = {
  BATTERY_BACKUP: 'Battery backup',
  GRID_TIED: 'Grid-tied',
  SELF_CONSUMPTION: 'Self-consumption',
};

function tsToDate(sec?: number): string | undefined {
  if (!sec) return undefined;
  const d = new Date(sec * 1000);
  return Number.isNaN(d.getTime()) ? undefined : d.toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' });
}

/** Build a rich detail page from the cached raw list record — no browser needed. */
function detailFromList(stationId: string): NormalizedDetail | null {
  const s = rawById.get(stationId);
  if (!s) return null;
  const info: StationInfoItem[] = [];
  const push = (label: string, v: string | number | undefined | null) => {
    if (v != null && v !== '') info.push({ label, value: String(v) });
  };
  push('Status', statusLabel(s.networkStatus));
  push('Location', s.locationAddress);
  push('Installed capacity', s.installedCapacity != null ? `${s.installedCapacity} kWp` : undefined);
  push('Grid type', s.gridInterconnectionType ? GRID_TYPE_LABEL[s.gridInterconnectionType] ?? s.gridInterconnectionType : undefined);
  push('Plant type', s.type);
  push('Current power', s.generationPower != null ? `${s.generationPower} W` : undefined);
  push('Current consumption', s.usePower != null ? `${s.usePower} W` : undefined);
  push('Today', s.generationValue != null ? `${s.generationValue} kWh` : undefined);
  push('This month', s.generationMonth != null ? `${s.generationMonth} kWh` : undefined);
  push('This year', s.generationYear != null ? `${s.generationYear} kWh` : undefined);
  push('Total', s.generationTotal != null ? `${s.generationTotal} kWh` : undefined);
  push('Consumption this month', s.useMonth != null ? `${s.useMonth} kWh` : undefined);
  push('Full-power hours today', s.fullPowerHoursDay != null ? `${s.fullPowerHoursDay} h` : undefined);
  push('Commissioned', tsToDate(s.startOperatingTime));
  push('Owner', s.creatorName);
  push('NMI', s.nmi);
  push('Timezone', s.regionTimezone);
  push('Last update', tsToDate(s.lastUpdateTime));
  push('Station ID', s.id);

  return {
    info,
    latest: {
      currentPowerW: s.generationPower,
      consumptionPowerW: s.usePower,
      dailyEnergyKwh: s.generationValue,
      monthlyEnergyKwh: s.generationMonth,
      totalEnergyKwh: s.generationTotal,
      lastUpdate: s.lastUpdateTime,
    },
    devices: [],
    alerts: [],
    power: [],
  };
}

async function scrapeStations(page: Page): Promise<NormalizedStation[]> {
  let body: string | null = null;

  await page.route(`**${SEARCH_MATCH}*`, (route) => {
    try {
      const u = new URL(route.request().url());
      u.searchParams.set('page', '1');
      u.searchParams.set('size', '200');
      void route.continue({ url: u.toString() });
    } catch {
      void route.continue();
    }
  });
  page.on('response', async (resp) => {
    if (resp.url().includes(SEARCH_MATCH) && resp.status() === 200 && !body) {
      try {
        body = await resp.text();
      } catch {
        /* ignore */
      }
    }
  });

  await page.goto(PLANT_URL, { waitUntil: 'networkidle', timeout: 40_000 }).catch(() => {});
  if (/\/login/.test(page.url())) throw new SessionExpiredError('solarman');
  await page.waitForTimeout(3000);
  if (!body) throw new Error('station list response not captured');

  const data = JSON.parse(body) as { total?: number; data?: { station: SolarmanStation }[] };
  const raws = (data.data ?? []).map((it) => it.station);
  rawById.clear();
  for (const s of raws) rawById.set(String(s.id), s);
  return raws.map(toStation);
}

export const solarmanScraperProvider = createScraperProvider({
  id: 'solarman',
  name: 'Solarman Business',
  credKey: 'solarman',
  scrapeStations,
  detailFromList,
});
