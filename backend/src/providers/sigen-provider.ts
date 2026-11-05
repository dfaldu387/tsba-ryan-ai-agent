import { sigenConfigured } from '../env.js';
import { listSystems, systemEnergyFlow, systemSummary } from '../sigen.js';
import { cached } from './cache.js';
import type { SigenEnergyFlow, SigenSummary, SigenSystem } from '../sigen.js';
import type {
  NormalizedDetail,
  NormalizedStation,
  SolarProvider,
  StationInfoItem,
  StationStatus,
} from './types.js';

/**
 * Sigenergy (SigenCloud) — official OpenAPI provider, replacing the old portal
 * scraper. The system list, per-station summary (energy totals) and energyFlow
 * (live PV/battery power + SOC) each carry a strict once-per-5-minutes rate
 * limit, so every upstream call is cached for 5 minutes. The 60s dashboard poll
 * is served from cache between refreshes; aggregateStations' last-good cache
 * covers the occasional refresh error.
 */

// Sigen rate-limits list + per-station endpoints to once / 5 min. Cache a touch
// above 5 min so a steady poll never races the limit from the API's side.
const TTL_MS = 310_000;

const fmtDate = (epochMs?: number) =>
  epochMs ? new Date(epochMs).toLocaleDateString('en-AU', { timeZone: 'Australia/Brisbane' }) : undefined;
const prettyGrid = (g?: string) =>
  g === 'onGrid' ? 'On-grid' : g === 'offGrid' ? 'Off-grid' : g || undefined;

function mapStatus(status?: string): StationStatus {
  const s = (status || '').toLowerCase();
  if (s === 'normal' || s === 'online') return 'online';
  if (s.includes('disconn') || s.includes('offline')) return 'offline';
  if (s.includes('fault') || s.includes('alarm') || s.includes('partial')) return 'partial';
  if (s.includes('wait') || s.includes('standby')) return 'waiting';
  return 'unknown';
}

const STATUS_LABEL: Record<StationStatus, string> = {
  online: 'Online',
  waiting: 'Waiting',
  partial: 'Partial',
  offline: 'Offline',
  unknown: 'Unknown',
};

/** Per-station live snapshot + energy totals, cached to respect the rate limit. */
const flowOf = (id: string): Promise<SigenEnergyFlow> =>
  cached(`sigen:flow:${id}`, TTL_MS, () => systemEnergyFlow(id)).catch((): SigenEnergyFlow => ({}));
const summaryOf = (id: string): Promise<SigenSummary> =>
  cached(`sigen:summary:${id}`, TTL_MS, () => systemSummary(id)).catch((): SigenSummary => ({}));
const systemsList = (): Promise<SigenSystem[]> =>
  cached('sigen:list', TTL_MS, () => listSystems());

function toStation(s: SigenSystem, flow: SigenEnergyFlow, summary: SigenSummary): NormalizedStation {
  return {
    id: String(s.systemId),
    name: (s.systemName || String(s.systemId)).trim(),
    status: mapStatus(s.status),
    // energyFlow powers are in kW → Watts for the normalized shape.
    currentPowerW: flow.pvPower != null ? flow.pvPower * 1000 : undefined,
    dailyEnergyKwh: summary.dailyPowerGeneration,
    monthlyEnergyKwh: summary.monthlyPowerGeneration,
    totalEnergyKwh: summary.lifetimePowerGeneration,
    capacityKw: s.pvCapacity,
    batterySoc: flow.batterySoc,
    location: s.addr,
  };
}

function buildInfo(s: SigenSystem, flow: SigenEnergyFlow, summary: SigenSummary): StationInfoItem[] {
  const items: [string, string | number | undefined][] = [
    ['Status', STATUS_LABEL[mapStatus(s.status)]],
    ['Location', s.addr],
    ['Grid status', prettyGrid(s.onOffGridStatus)],
    ['Real-time PV power', flow.pvPower != null ? `${flow.pvPower} kW` : undefined],
    ['Grid power', flow.gridPower != null ? `${flow.gridPower} kW` : undefined],
    ['Load power', flow.loadPower != null ? `${flow.loadPower} kW` : undefined],
    ['Battery power', flow.batteryPower != null ? `${flow.batteryPower} kW` : undefined],
    ['Battery SOC', flow.batterySoc != null ? `${flow.batterySoc}%` : undefined],
    ['Installed capacity', s.pvCapacity != null ? `${s.pvCapacity} kWp` : undefined],
    ['Battery capacity', s.batteryCapacity != null ? `${s.batteryCapacity} kWh` : undefined],
    ['Today', summary.dailyPowerGeneration != null ? `${summary.dailyPowerGeneration} kWh` : undefined],
    ['This month', summary.monthlyPowerGeneration != null ? `${summary.monthlyPowerGeneration} kWh` : undefined],
    ['This year', summary.annualPowerGeneration != null ? `${summary.annualPowerGeneration} kWh` : undefined],
    ['Total', summary.lifetimePowerGeneration != null ? `${summary.lifetimePowerGeneration} kWh` : undefined],
    ['CO₂ saved', summary.lifetimeCo2 != null ? `${summary.lifetimeCo2} t` : undefined],
    ['Timezone', s.timeZone],
    ['Grid connected', fmtDate(s.gridConnectedTime)],
    ['System ID', String(s.systemId)],
  ];
  return items
    .filter(([, v]) => v != null && v !== '')
    .map(([label, v]) => ({ label, value: String(v) }));
}

export const sigenProvider: SolarProvider = {
  id: 'sigen',
  name: 'Sigenergy',
  configured: sigenConfigured,

  async listStations(): Promise<NormalizedStation[]> {
    const systems = await systemsList();
    return Promise.all(
      systems.map(async (s): Promise<NormalizedStation> => {
        const [flow, summary] = await Promise.all([flowOf(s.systemId), summaryOf(s.systemId)]);
        return toStation(s, flow, summary);
      }),
    );
  },

  async stationDetail(stationId: string): Promise<NormalizedDetail> {
    const [systems, flow, summary] = await Promise.all([
      systemsList().catch((): SigenSystem[] => []),
      flowOf(stationId),
      summaryOf(stationId),
    ]);
    const record = systems.find((x) => String(x.systemId) === stationId);

    return {
      info: record ? buildInfo(record, flow, summary) : [],
      latest: {
        currentPowerW: flow.pvPower != null ? flow.pvPower * 1000 : undefined,
        gridPowerW: flow.gridPower != null ? flow.gridPower * 1000 : undefined,
        batteryPowerW: flow.batteryPower != null ? flow.batteryPower * 1000 : undefined,
        batterySoc: flow.batterySoc,
        dailyEnergyKwh: summary.dailyPowerGeneration,
        monthlyEnergyKwh: summary.monthlyPowerGeneration,
        totalEnergyKwh: summary.lifetimePowerGeneration,
      },
      // The OpenAPI exposes devices and alarms via separate rate-limited
      // endpoints; the overview and detail don't need them yet, so they're left
      // empty (the scraper returned them empty too). Intraday power curve isn't
      // offered over HTTP — it comes via the MQTT telemetry stream.
      devices: [],
      alerts: [],
      power: [],
    };
  },
};
