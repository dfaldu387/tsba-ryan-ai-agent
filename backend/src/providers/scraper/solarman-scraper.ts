import type { Page } from 'playwright';
import { pickCoords } from '../coords.js';
import { cached, invalidate } from '../cache.js';
import type {
  ChartData,
  EnergyFlow,
  NormalizedAlert,
  NormalizedDetail,
  NormalizedDevice,
  NormalizedPowerPoint,
  NormalizedStation,
  StationInfoItem,
  StationOverview,
  StationStatus,
} from '../types.js';
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
 *
 * Devices, today's curves, latest alerts and the per-plant Overview come from the
 * portal's `/maintain-s/` JSON API. Those endpoints DO accept a direct call with
 * just the portal's bearer token (verified; unlike the plant search), so the
 * token is picked up from the app's own requests during the list scrape and the
 * rest is plain HTTPS — no extra browser work per plant.
 */

const ORIGIN = 'https://globalpro.solarmanpv.com';
const PLANT_URL = `${ORIGIN}/business/maintain/plant`;
const SEARCH_MATCH = '/operating/station/v2/search';
const API = `${ORIGIN}/maintain-s`;

// Portal bearer token, captured from the app's own /maintain-s/ requests during
// the list scrape (long-lived: ~2 months). Cleared on a 401 so the next list
// scrape picks up a fresh one.
let bearer: string | null = null;

async function api<T>(path: string, body?: unknown): Promise<T> {
  if (!bearer) throw new Error('solarman_no_token (list scrape has not run yet)');
  const res = await fetch(`${API}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: bearer, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 401) {
    bearer = null;
    invalidate('scraper:solarman:stations');
  }
  if (!res.ok) throw new Error(`solarman_api ${res.status} ${path}`);
  return (await res.json()) as T;
}

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
    ...pickCoords(s),
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

// ─── Fleet extras: devices, today's curves, latest alerts (one pass) ─────────

interface SmDevice {
  siteId?: number;
  deviceSn?: string;
  type?: string;
  netState?: number; // 1 online, 0 offline
  alertState?: number; // -1 none, else alerting
  deviceState?: number; // 1 normal, 2 alarm, 3 offline
}
interface SmCurve {
  stationId: number;
  generationPowerList?: { generationPower?: number; dateTime?: number }[];
}
interface SmLatestAlert {
  stationId?: number;
  id?: number | string | null;
  alertName?: string | null;
  level?: number | null;
  deviceSn?: string | null;
  alertStartTime?: number | null;
  alertEndTime?: number | null;
}
interface FleetExtras {
  devices: Map<string, NormalizedDevice[]>;
  curves: Map<string, NormalizedPowerPoint[]>;
  alerts: Map<string, NormalizedAlert[]>;
}

const TYPE_LABEL: Record<string, string> = { INVERTER: 'Inverter', BATTERY: 'Battery', COLLECTOR: 'Logger', METER: 'Meter' };

function toDevice(d: SmDevice): NormalizedDevice {
  const offline = d.netState === 0 || d.deviceState === 3;
  const alarm = !offline && (d.deviceState === 2 || (d.alertState != null && d.alertState > 0));
  const online = d.netState === 1;
  return {
    sn: d.deviceSn ?? '',
    type: TYPE_LABEL[d.type ?? ''] ?? d.type,
    online: offline ? false : online ? true : undefined,
    state: offline ? 'offline' : alarm ? 'alarm' : online ? 'normal' : 'unknown',
    stateLabel: offline ? 'Offline' : alarm ? 'Alarm' : online ? 'Online' : undefined,
  };
}

function pushTo<T>(m: Map<string, T[]>, k: string, v: T): void {
  const a = m.get(k);
  if (a) a.push(v);
  else m.set(k, [v]);
}

async function loadFleetExtras(): Promise<FleetExtras> {
  const ids = [...rawById.keys()].map(Number);
  const out: FleetExtras = { devices: new Map(), curves: new Map(), alerts: new Map() };
  const chunks: number[][] = [];
  for (let i = 0; i < ids.length; i += 50) chunks.push(ids.slice(i, i + 50));

  let ok = 0;
  await Promise.all([
    ...['INVERTER', 'BATTERY', 'COLLECTOR', 'METER'].map(async (t) => {
      const r = await api<{ data?: SmDevice[] }>(
        `/operating/system/device/${t}/list?page=1&size=500&sn=&order.direction=ASC&order.property=name`,
      ).catch(() => null);
      if (!r) return;
      ok++;
      for (const d of r.data ?? []) if (d.siteId != null && d.deviceSn) pushTo(out.devices, String(d.siteId), toDevice(d));
    }),
    ...chunks.map(async (stationIds) => {
      const r = await api<SmCurve[]>('/history/power/day/overview', { stationIds }).catch(() => null);
      if (!r) return;
      ok++;
      for (const c of r) {
        out.curves.set(
          String(c.stationId),
          (c.generationPowerList ?? [])
            .filter((p) => p.dateTime != null)
            .map((p) => ({ t: Math.round(Number(p.dateTime)), powerW: Number(p.generationPower ?? 0) })),
        );
      }
    }),
    ...chunks.map(async (stationIds) => {
      const r = await api<SmLatestAlert[]>('/operating/station/alert/lastest/list', { stationIds }).catch(() => null);
      if (!r) return;
      ok++;
      for (const a of r) {
        // One row per plant; a plant with no alert comes back with all-null fields.
        if (!a.alertName || a.stationId == null || a.alertEndTime) continue;
        pushTo(out.alerts, String(a.stationId), {
          id: String(a.id ?? `${a.deviceSn}:${a.alertName}:${a.alertStartTime}`),
          name: a.alertName,
          deviceSn: a.deviceSn ?? undefined,
          start: a.alertStartTime != null ? Math.round(Number(a.alertStartTime)) : undefined,
          level: a.level != null ? String(a.level) : undefined,
        });
      }
    }),
  ]);
  // Nothing at all came back (token lapsed / portal down): throw so the cache
  // keeps serving the last good extras instead of caching emptiness.
  if (!ok) throw new Error('solarman_extras_unavailable');
  return out;
}

/** Cached fleet extras (5 min, stale-while-revalidate). Null until available. */
async function fleetExtras(): Promise<FleetExtras | null> {
  if (!rawById.size || !bearer) return null;
  return cached('scraper:solarman:extras', 300_000, loadFleetExtras, { swr: true }).catch(() => null);
}

// ─── Per-plant Overview (live flow, today's totals, day curve) ───────────────

interface SmRecord {
  generationPower?: number | null;
  usePower?: number | null;
  wirePower?: number | null; // grid-side power; direction in wireStatus
  gridPower?: number | null;
  batterySoc?: number | null;
  batteryPower?: number | null;
  wireStatus?: string | null; // PURCHASE | GRID | STATIC
  batteryStatus?: string | null; // CHARGE | DISCHARGE | STATIC
  dateTime?: number;
}
interface SmDayStats {
  generationValue?: number | null;
  useValue?: number | null;
  gridValue?: number | null; // exported
  buyValue?: number | null; // imported
  chargeValue?: number | null;
  dischargeValue?: number | null;
}

const num = (v: number | null | undefined): number | undefined =>
  v == null || Number.isNaN(Number(v)) ? undefined : Number(v);
const hhmm = (sec: number) =>
  new Date(sec * 1000).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Australia/Brisbane' });

async function overview(stationId: string): Promise<StationOverview> {
  if (!bearer) await solarmanScraperProvider.listStations(); // first open after a restart
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Australia/Brisbane' }));
  const r = await api<{ statistics?: SmDayStats; records?: SmRecord[] }>(
    `/history/power/${encodeURIComponent(stationId)}/record?year=${now.getFullYear()}&month=${now.getMonth() + 1}&day=${now.getDate()}`,
  );
  const recs = r.records ?? [];
  const last = recs[recs.length - 1];
  const st = r.statistics ?? {};
  const hasBattery = recs.some((x) => x.batterySoc != null);

  let flow: EnergyFlow | undefined;
  if (last) {
    const gridW = num(last.wirePower) ?? num(last.gridPower);
    const ws = (last.wireStatus || '').toUpperCase();
    const bs = (last.batteryStatus || '').toUpperCase();
    flow = {
      pvPowerW: num(last.generationPower),
      loadPowerW: num(last.usePower),
      gridPowerW: gridW != null ? Math.abs(gridW) : undefined,
      gridDirection: ws === 'PURCHASE' ? 'Import' : ws === 'GRID' ? 'Export' : undefined,
      batteryPowerW: hasBattery && last.batteryPower != null ? Math.abs(Number(last.batteryPower)) : undefined,
      batterySoc: num(last.batterySoc),
      batteryDirection: bs === 'CHARGE' ? 'Charging' : bs === 'DISCHARGE' ? 'Discharging' : bs === 'STATIC' ? 'Idle' : undefined,
      hasPv: true,
      hasGrid: gridW != null,
      hasBattery,
      todayPvEnergyKwh: num(st.generationValue),
      dataTime: last.dateTime ? hhmm(last.dateTime) : undefined,
    };
  }

  let powerCurve: ChartData | undefined;
  if (recs.length) {
    const series = [
      { name: 'PV', unit: 'W', data: recs.map((x) => num(x.generationPower) ?? null) },
      { name: 'Consumption', unit: 'W', data: recs.map((x) => num(x.usePower) ?? null) },
      ...(hasBattery
        ? [
            { name: 'Battery', unit: 'W', data: recs.map((x) => num(x.batteryPower) ?? null) },
            { name: 'SOC', unit: '%', secondaryAxis: true, data: recs.map((x) => num(x.batterySoc) ?? null) },
          ]
        : []),
    ].filter((s) => s.data.some((v) => v != null));
    powerCurve = { kind: 'line', xLabels: recs.map((x) => (x.dateTime ? hhmm(x.dateTime) : '')), series };
  }

  return {
    flow,
    stats: [
      { kind: 'pv', todayKwh: num(st.generationValue), totalKwh: rawById.get(stationId)?.generationTotal },
      ...(st.useValue != null ? [{ kind: 'load' as const, todayKwh: num(st.useValue) }] : []),
      ...(st.buyValue != null || st.gridValue != null
        ? [{ kind: 'grid' as const, todayKwh: num(st.buyValue), today2Kwh: num(st.gridValue) }]
        : []),
      ...(hasBattery ? [{ kind: 'battery' as const, todayKwh: num(st.chargeValue), today2Kwh: num(st.dischargeValue) }] : []),
    ],
    powerCurve,
  };
}

/** Build a rich detail page from the cached raw list record + fleet extras — no browser needed. */
async function detailFromList(stationId: string): Promise<NormalizedDetail | null> {
  const s = rawById.get(stationId);
  if (!s) return null;
  const extras = await fleetExtras();
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
    devices: extras?.devices.get(stationId) ?? [],
    alerts: extras?.alerts.get(stationId) ?? [],
    power: extras?.curves.get(stationId) ?? [],
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
  page.on('request', (req) => {
    const a = req.headers().authorization;
    if (a && req.url().includes('/maintain-s/')) bearer = a;
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
  // Warm devices/curves/alerts in the background so plant pages and the alert
  // scan have them without waiting.
  void fleetExtras();
  return raws.map(toStation);
}

export const solarmanScraperProvider = createScraperProvider({
  id: 'solarman',
  name: 'Solarman Business',
  credKey: 'solarman',
  scrapeStations,
  detailFromList,
  overview,
});
