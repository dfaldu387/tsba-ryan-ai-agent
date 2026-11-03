import type { Page } from 'playwright';
import type { NormalizedDetail, NormalizedStation, StationInfoItem, StationStatus } from '../types.js';
import { SessionExpiredError } from './browser.js';
import { createScraperProvider } from './scraper-provider.js';

/**
 * WHES / ECOS Hub scraper — portal ecos-hub.whes.com (eCactus / WeiHeng). No API,
 * so we read the device list from the web portal with a captured session. The
 * device-list page (#/device-list/index) fetches /api/service/hybridSinglePhase/page;
 * we capture that response. The SPA boots slowly, so we retry with reloads.
 *
 * This is a device-management list: it carries identity, state and nameplate +
 * battery SOC, but not live generation power/energy (those aren't exposed here).
 */

const DEVICE_URL = 'https://ecos-hub.whes.com/#/device-list/index';
const LIST_MATCH = '/hybridSinglePhase/page';
const AUTH_MATCH = '/user/authentication';

interface EcosDevice {
  deviceSn: string;
  deviceName?: string;
  alias?: string;
  deviceModel?: string;
  brand?: string;
  state?: number; // 1 online, -1 offline
  ratedPower?: string; // e.g. "10000W"
  ratedCapacity?: number | null; // kWh (battery)
  batSoc?: number | null; // %
  bmsVendor?: string;
  bmsSn?: string;
  wifiSn?: string;
  installerName?: string;
  address?: string;
  installCountry?: string;
  updateTime?: string;
}

const rawById = new Map<string, EcosDevice>();

function mapState(state?: number): StationStatus {
  if (state === 1) return 'online';
  if (state === -1 || state === 0) return 'offline';
  return 'unknown';
}

/** "10000W" / "10kW" → kW. */
function ratedKw(r?: string): number | undefined {
  if (!r) return undefined;
  const n = parseFloat(r);
  if (!Number.isFinite(n)) return undefined;
  return /kw/i.test(r) ? n : n / 1000;
}

function toStation(d: EcosDevice): NormalizedStation {
  return {
    id: d.deviceSn,
    name: (d.alias || d.deviceName || d.deviceSn).trim(),
    status: mapState(d.state),
    capacityKw: ratedKw(d.ratedPower),
    batterySoc: d.batSoc ?? undefined,
    location: d.address || d.installCountry || undefined,
  };
}

function detailFromList(stationId: string): NormalizedDetail | null {
  const d = rawById.get(stationId);
  if (!d) return null;
  const info: StationInfoItem[] = [];
  const push = (label: string, v: string | number | undefined | null) => {
    if (v != null && v !== '') info.push({ label, value: String(v) });
  };
  push('Status', d.state === 1 ? 'Online' : d.state === -1 ? 'Offline' : 'Unknown');
  push('Model', d.deviceModel);
  push('Brand', d.brand?.trim());
  push('Serial number', d.deviceSn);
  push('Rated power', d.ratedPower);
  push('Battery capacity', d.ratedCapacity != null ? `${d.ratedCapacity} kWh` : undefined);
  push('Battery SOC', d.batSoc != null ? `${d.batSoc}%` : undefined);
  push('Battery vendor', d.bmsVendor?.trim());
  push('Battery SN', d.bmsSn);
  push('WiFi SN', d.wifiSn);
  push('Location', d.address);
  push('Country', d.installCountry);
  push('Installer', d.installerName);
  push('Last update', d.updateTime);

  return {
    info,
    latest: { batterySoc: d.batSoc ?? undefined },
    devices: [],
    alerts: [],
    power: [],
  };
}

async function scrapeStations(page: Page): Promise<NormalizedStation[]> {
  let body: string | null = null;
  let sawAuth = false;
  page.on('response', async (resp) => {
    const u = resp.url();
    if (u.includes(AUTH_MATCH)) sawAuth = true;
    if (u.includes(LIST_MATCH) && resp.status() === 200 && !body) {
      try {
        body = await resp.text();
      } catch {
        /* ignore */
      }
    }
  });

  await page.goto(DEVICE_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
  // The ECOS SPA boots slowly (config + auth, then the device list). Wait
  // patiently for the list call; reload ONCE as a fallback (a reload restarts
  // the slow boot, so don't hammer it).
  await page.waitForResponse((r) => r.url().includes(LIST_MATCH), { timeout: 40_000 }).catch(() => {});
  if (!body) {
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForResponse((r) => r.url().includes(LIST_MATCH), { timeout: 40_000 }).catch(() => {});
  }
  if (/\/login/.test(page.url())) throw new SessionExpiredError('whes');
  await page.waitForTimeout(1500);
  if (!body) {
    if (sawAuth) return []; // authenticated but no devices returned
    throw new Error('device list response not captured');
  }

  const data = JSON.parse(body) as { data?: { data?: EcosDevice[]; list?: EcosDevice[] } };
  const list = data.data?.data ?? data.data?.list ?? [];
  rawById.clear();
  for (const d of list) rawById.set(d.deviceSn, d);
  return list.map(toStation);
}

export const whesScraperProvider = createScraperProvider({
  id: 'whes',
  name: 'WHES (ECOS Hub)',
  credKey: 'whes',
  scrapeStations,
  detailFromList,
});
