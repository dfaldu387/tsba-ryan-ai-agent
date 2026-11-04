import type { Page } from 'playwright';
import type { NormalizedDetail, NormalizedStation, StationInfoItem, StationStatus } from '../types.js';
import { SessionExpiredError } from './browser.js';
import { createScraperProvider } from './scraper-provider.js';

/**
 * Sigenergy (SigenCloud) scraper — portal web-aus.sigencloud.com. Pure portal
 * scraper (no local API). The Systems page /bmsys/station fires GET
 * /device/web/manage/station/station/list, which carries per-station status,
 * today/total energy, capacity, battery capacity and address. (The devices page
 * /bmsys/devices has no live energy, so we use this instead.) Real-time PV power
 * isn't on this list — it only appears on each plant's dashboard — so current
 * power is omitted; today/total energy, capacity and status are populated.
 * Server caps page size (use 100).
 */

const STATION_URL = 'https://web-aus.sigencloud.com/bmsys/station';
const LIST_MATCH = '/device/web/manage/station/station/list';

interface SigenStation {
  stationId: number | string;
  stationName?: string;
  stationShowName?: string;
  status?: number; // 1 online, 0 online/other, 4 offline
  pvPowerGenerationDay?: number; // kWh today
  pvPowerGenerationTotal?: number; // kWh total
  ratedActivePower?: number; // kW (consistent capacity)
  esChgDischargePower?: number | null; // kW — the portal's "Real-time Power" column
  latitude?: number;
  longitude?: number;
  pvCapacity?: number; // inconsistent units — not used for display
  batteryCapacity?: number; // kWh
  addr?: string;
  gridConnectTime?: number; // epoch seconds
  equivalentHours?: number;
  packNum?: number;
  pcsNum?: number;
  packDeviceModel?: string[];
  pcsDeviceModel?: string[];
  gatewayDeviceModel?: string;
  companyName?: string;
  ownerUserName?: string;
  timeZoneName?: string;
}

const rawById = new Map<string, SigenStation>();

function mapStatus(status?: number): StationStatus {
  if (status === 1 || status === 0) return 'online';
  if (status === 4) return 'offline';
  if (status === 2 || status === 3) return 'partial';
  return 'unknown';
}

function toStation(s: SigenStation): NormalizedStation {
  return {
    id: String(s.stationId),
    name: (s.stationName || s.stationShowName || String(s.stationId)).trim(),
    status: mapStatus(s.status),
    // The portal's "Real-time Power" column is esChgDischargePower (kW → W).
    currentPowerW: s.esChgDischargePower != null ? s.esChgDischargePower * 1000 : undefined,
    dailyEnergyKwh: s.pvPowerGenerationDay,
    totalEnergyKwh: s.pvPowerGenerationTotal,
    capacityKw: s.ratedActivePower,
    location: s.addr,
  };
}

function tsToDate(sec?: number): string | undefined {
  if (!sec) return undefined;
  const d = new Date(sec * 1000);
  return Number.isNaN(d.getTime()) ? undefined : d.toLocaleDateString('en-AU', { timeZone: 'Australia/Brisbane' });
}

function detailFromList(stationId: string): NormalizedDetail | null {
  const s = rawById.get(stationId);
  if (!s) return null;
  const info: StationInfoItem[] = [];
  const push = (label: string, v: string | number | undefined) => {
    if (v != null && v !== '') info.push({ label, value: String(v) });
  };
  push('Status', mapStatus(s.status));
  push('Location', s.addr);
  push('Real-time power', s.esChgDischargePower != null ? `${s.esChgDischargePower} kW` : undefined);
  push('Installed capacity', s.ratedActivePower != null ? `${s.ratedActivePower} kW` : undefined);
  push('Battery capacity', s.batteryCapacity != null ? `${s.batteryCapacity} kWh` : undefined);
  push('Today', s.pvPowerGenerationDay != null ? `${s.pvPowerGenerationDay} kWh` : undefined);
  push('Total', s.pvPowerGenerationTotal != null ? `${s.pvPowerGenerationTotal} kWh` : undefined);
  push('Full-power hours', s.equivalentHours != null ? `${s.equivalentHours} h` : undefined);
  push('Battery packs', s.packNum);
  push('Battery model', s.packDeviceModel?.join(', '));
  push('Inverter model', s.pcsDeviceModel?.join(', '));
  push('Gateway model', s.gatewayDeviceModel);
  push('Owner', s.ownerUserName);
  push('Installer', s.companyName);
  push('Grid connected', tsToDate(s.gridConnectTime));
  push('Timezone', s.timeZoneName);
  push('System ID', String(s.stationId));
  return {
    info,
    latest: {
      currentPowerW: s.esChgDischargePower != null ? s.esChgDischargePower * 1000 : undefined,
      dailyEnergyKwh: s.pvPowerGenerationDay,
      totalEnergyKwh: s.pvPowerGenerationTotal,
    },
    devices: [],
    alerts: [],
    power: [],
  };
}

async function scrapeStations(page: Page): Promise<NormalizedStation[]> {
  let body: string | null = null;

  await page.route(`**${LIST_MATCH}*`, (route) => {
    try {
      const u = new URL(route.request().url());
      u.searchParams.set('current', '1');
      u.searchParams.set('size', '100');
      u.searchParams.set('pageSize', '100');
      void route.continue({ url: u.toString() });
    } catch {
      void route.continue();
    }
  });
  page.on('response', async (resp) => {
    // Exact path only — sibling endpoints (/list/getbasicdata, /list/getstatustotal,
    // /list/download/.../count) also contain the LIST_MATCH substring but have no records.
    let path = '';
    try {
      path = new URL(resp.url()).pathname;
    } catch {
      /* ignore */
    }
    if (path.endsWith('/station/station/list') && resp.status() === 200 && !body) {
      try {
        body = await resp.text();
      } catch {
        /* ignore */
      }
    }
  });

  // The Systems SPA can be slow to fire the list; retry with reloads.
  for (let i = 0; i < 3 && !body; i++) {
    await page.goto(STATION_URL, { waitUntil: 'networkidle', timeout: 40_000 }).catch(() => {});
    if (/\/login/i.test(page.url())) throw new SessionExpiredError('sigen');
    await page.waitForResponse((r) => r.url().includes(LIST_MATCH), { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(2000);
  }
  if (!body) throw new Error('station list response not captured');

  const data = JSON.parse(body) as {
    data?: SigenStation[] | { records?: SigenStation[]; list?: SigenStation[]; rows?: SigenStation[]; pageData?: SigenStation[] };
  };
  const d = data.data;
  const list: SigenStation[] = Array.isArray(d) ? d : (d?.records ?? d?.list ?? d?.rows ?? d?.pageData ?? []);
  rawById.clear();
  for (const s of list) rawById.set(String(s.stationId), s);
  return list.map(toStation);
}

export const sigenScraperProvider = createScraperProvider({
  id: 'sigen',
  name: 'Sigenergy',
  credKey: 'sigen',
  scrapeStations,
  detailFromList,
});
