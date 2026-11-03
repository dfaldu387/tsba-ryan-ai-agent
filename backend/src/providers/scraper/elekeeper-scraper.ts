import type { Page } from 'playwright';
import type { NormalizedDetail, NormalizedDevice, NormalizedStation, StationInfoItem, StationStatus } from '../types.js';
import { SessionExpiredError } from './browser.js';
import { createScraperProvider } from './scraper-provider.js';

/**
 * SAJ / Elekeeper (eSolar) scraper — portal iop.saj-electric.com. Dev API on hold.
 * Auth lives in localStorage + sessionStorage (restored by withSession). The plant
 * list page fires POST /dev-api/api/v2/monitor/plant/userPlantPage; we ride it and
 * rewrite pageSize so one request returns the whole fleet. Rich per-plant fields
 * (incl. battery SOC) drive the detail page without a second page load.
 */

const PLANT_URL = 'https://iop.saj-electric.com/#/monitor/plantMonitor';
const LIST_MATCH = '/monitor/plant/userPlantPage';

interface SajPlant {
  plantUid: string;
  plantNo?: string;
  plantName?: string;
  pvCapacity?: number; // kWp
  pvPower?: number; // W
  runningState?: number; // 1 Normal
  runningStateName?: string;
  batSoc?: number; // %
  batCapacity?: number; // kWh
  batModel?: string;
  batPacketNum?: number;
  inverterNum?: number;
  inverterModel?: string;
  todayPvEnergy?: number; // kWh
  totalPvEnergy?: number; // kWh
  todayChargeEnergy?: number | null;
  todayDisChargeEnergy?: number | null;
  todayEquivalentHours?: number;
  address?: string;
  city?: string;
  country?: string;
  activationTime?: string;
  installerName?: string;
  ownerName?: string;
  alarmInfo?: string;
}

const rawById = new Map<string, SajPlant>();

function mapState(state?: number, name?: string): StationStatus {
  if (state === 1) return 'online';
  if (state === 2) return 'partial'; // alarm
  if (state === 0 || state === 3) return 'offline';
  const n = (name || '').toLowerCase();
  if (n.includes('normal') || n.includes('online')) return 'online';
  if (n.includes('alarm') || n.includes('fault') || n.includes('partial')) return 'partial';
  if (n.includes('offline') || n.includes('disconnect') || n.includes('not')) return 'offline';
  return 'unknown';
}

function toStation(p: SajPlant): NormalizedStation {
  return {
    id: String(p.plantUid),
    name: (p.plantName || p.plantNo || p.plantUid).trim(),
    status: mapState(p.runningState, p.runningStateName),
    currentPowerW: p.pvPower,
    dailyEnergyKwh: p.todayPvEnergy,
    totalEnergyKwh: p.totalPvEnergy,
    capacityKw: p.pvCapacity,
    batterySoc: p.batSoc,
    location: p.address,
  };
}

function detailFromList(stationId: string): NormalizedDetail | null {
  const p = rawById.get(stationId);
  if (!p) return null;
  const info: StationInfoItem[] = [];
  const push = (label: string, v: string | number | undefined | null) => {
    if (v != null && v !== '') info.push({ label, value: String(v) });
  };
  push('Status', p.runningStateName);
  push('Location', p.address);
  push('Installed capacity', p.pvCapacity != null ? `${p.pvCapacity} kWp` : undefined);
  push('Current power', p.pvPower != null ? `${p.pvPower} W` : undefined);
  push('Today', p.todayPvEnergy != null ? `${p.todayPvEnergy} kWh` : undefined);
  push('Total', p.totalPvEnergy != null ? `${p.totalPvEnergy} kWh` : undefined);
  push('Full-power hours today', p.todayEquivalentHours != null ? `${p.todayEquivalentHours} h` : undefined);
  push('Battery SOC', p.batSoc != null ? `${p.batSoc}%` : undefined);
  push('Battery capacity', p.batCapacity != null ? `${p.batCapacity} kWh` : undefined);
  push('Battery model', p.batModel);
  push('Battery packs', p.batPacketNum);
  push('Charged today', p.todayChargeEnergy != null ? `${p.todayChargeEnergy} kWh` : undefined);
  push('Discharged today', p.todayDisChargeEnergy != null ? `${p.todayDisChargeEnergy} kWh` : undefined);
  push('Inverters', p.inverterNum);
  push('Inverter model', p.inverterModel);
  push('Installer', p.installerName);
  push('Owner', p.ownerName);
  push('Commissioned', p.activationTime);
  push('Active alarm', p.alarmInfo);
  push('Plant ID', p.plantNo);

  return {
    info,
    latest: {
      currentPowerW: p.pvPower,
      dailyEnergyKwh: p.todayPvEnergy,
      totalEnergyKwh: p.totalPvEnergy,
      batterySoc: p.batSoc,
    },
    devices: [],
    alerts: p.alarmInfo ? [{ id: `${p.plantUid}:alarm`, name: p.alarmInfo }] : [],
    power: [],
  };
}

async function scrapeStations(page: Page): Promise<NormalizedStation[]> {
  let body: string | null = null;

  await page.route(`**${LIST_MATCH}`, (route) => {
    try {
      const b = JSON.parse(route.request().postData() || '{}');
      b.pageNo = 1;
      b.pageSize = 300;
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
  if (/\/login/.test(page.url())) throw new SessionExpiredError('elekeeper');
  await page.waitForTimeout(4000);
  if (!body) throw new Error('plant list response not captured');

  const data = JSON.parse(body) as { data?: { rows?: SajPlant[]; list?: SajPlant[]; records?: SajPlant[] } };
  const list = data.data?.rows ?? data.data?.list ?? data.data?.records ?? [];
  rawById.clear();
  for (const p of list) rawById.set(String(p.plantUid), p);
  return list.map(toStation);
}

// ─── Live per-plant detail scrape (devices + real-time flow + SOC) ───────────

const DETAIL_URL = (uid: string) =>
  `https://iop.saj-electric.com/#/monitor/plantDetail?plantUid=${encodeURIComponent(uid)}&name=plant`;
const FLOW_MATCH = '/plantHome/getDeviceEnergyFlowDiagram';
const DEVICE_MATCH = '/plantDevice/listForWeb';

interface FlowDiagram {
  batEnergyPercent?: number; // SOC %
  batPower?: number; // W
  batteryDirectionName?: string;
  totalPvPower?: number; // W
  totalLoadPowerwatt?: number; // W
  sysGridPowerwatt?: number; // W
  gridStatus?: number;
  runningStateName?: string;
  systemPower?: number; // kW
  todayPvEnergy?: number; // kWh
  sn?: string;
  alarmCount?: number | null;
  dataTime?: string;
}

interface SajDeviceNode {
  deviceSn?: string;
  deviceName?: string;
  deviceModel?: string;
  aliasName?: string;
  deviceStatus?: number; // 1 online
  deviceStatusName?: string;
  batSoc?: number | null;
  children?: SajDeviceNode[];
}

/** Flatten the device tree (inverter → children modules/battery) into a flat list. */
function flattenDevices(nodes: SajDeviceNode[], out: NormalizedDevice[] = []): NormalizedDevice[] {
  for (const n of nodes) {
    const sn = n.deviceSn || n.aliasName;
    if (sn) {
      out.push({
        sn,
        type: n.deviceName || n.deviceModel || undefined,
        online: n.deviceStatus === 1,
      });
    }
    if (n.children?.length) flattenDevices(n.children, out);
  }
  return out;
}

async function scrapeDetail(page: Page, stationId: string): Promise<NormalizedDetail> {
  let flowBody: string | null = null;
  let deviceBody: string | null = null;
  page.on('response', async (resp) => {
    const u = resp.url();
    if (resp.status() !== 200) return;
    if (u.includes(FLOW_MATCH) && !flowBody) {
      try { flowBody = await resp.text(); } catch { /* */ }
    } else if (u.includes(DEVICE_MATCH) && !deviceBody) {
      try { deviceBody = await resp.text(); } catch { /* */ }
    }
  });

  await page.goto(DETAIL_URL(stationId), { waitUntil: 'networkidle', timeout: 40_000 }).catch(() => {});
  if (/\/login/i.test(page.url())) throw new SessionExpiredError('elekeeper');
  await page.waitForTimeout(3500);
  // Open the Device tab to trigger the device-list call (best-effort).
  for (const label of ['Device', 'Devices', 'Equipment']) {
    const el = page.getByText(label, { exact: true }).first();
    if (await el.count().then((c) => c > 0).catch(() => false)) {
      await el.click({ timeout: 2500 }).catch(() => {});
      await page.waitForResponse((r) => r.url().includes(DEVICE_MATCH), { timeout: 8000 }).catch(() => {});
      break;
    }
  }
  await page.waitForTimeout(500);

  const flow: FlowDiagram = flowBody ? (JSON.parse(flowBody).data ?? {}) : {};
  const devicesRaw: SajDeviceNode[] = deviceBody ? (JSON.parse(deviceBody).data ?? []) : [];
  const devices = flattenDevices(Array.isArray(devicesRaw) ? devicesRaw : []);

  // Start from the list-based info, then layer live flow fields on top.
  const base = detailFromList(stationId);
  const info: StationInfoItem[] = base?.info ? [...base.info] : [];
  const addLive = (label: string, v: string | number | undefined | null) => {
    if (v != null && v !== '') info.push({ label, value: String(v) });
  };
  addLive('PV power', flow.totalPvPower != null ? `${flow.totalPvPower} W` : undefined);
  addLive('Load power', flow.totalLoadPowerwatt != null ? `${flow.totalLoadPowerwatt} W` : undefined);
  addLive('Grid power', flow.sysGridPowerwatt != null ? `${flow.sysGridPowerwatt} W` : undefined);
  addLive('Battery power', flow.batPower != null ? `${flow.batPower} W` : undefined);
  addLive('Battery flow', flow.batteryDirectionName);
  addLive('Inverter SN', flow.sn);
  addLive('As of', flow.dataTime);

  return {
    info,
    latest: {
      currentPowerW: flow.totalPvPower,
      consumptionPowerW: flow.totalLoadPowerwatt,
      gridPowerW: flow.sysGridPowerwatt,
      batteryPowerW: flow.batPower,
      batterySoc: flow.batEnergyPercent ?? base?.latest?.batterySoc,
      totalEnergyKwh: base?.latest?.totalEnergyKwh,
      dailyEnergyKwh: flow.todayPvEnergy ?? base?.latest?.dailyEnergyKwh,
    },
    devices,
    alerts: base?.alerts ?? [],
    power: [],
  };
}

export const elekeeperScraperProvider = createScraperProvider({
  id: 'elekeeper',
  name: 'Elekeeper (SAJ)',
  credKey: 'elekeeper',
  scrapeStations,
  scrapeDetail,
  detailFromList,
});
