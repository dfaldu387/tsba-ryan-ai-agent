import type Anthropic from '@anthropic-ai/sdk';
import { aggregateStations, configuredProviders, getProvider } from './providers/index.js';

/** True when at least one monitoring platform is connected (so the tools are useful). */
export function solarToolsAvailable(): boolean {
  return configuredProviders().length > 0;
}

/** Tool definitions handed to Claude so it can read live monitoring data. */
export const SOLAR_TOOLS: Anthropic.Tool[] = [
  {
    name: 'get_solar_overview',
    description:
      "List every monitored solar plant/station across all connected platforms (e.g. Deye, GoodWe, Sungrow) with live status (online/waiting/partial/offline, where 'waiting' means connected but not producing, e.g. night/no sun), current power (W), energy generated today and all-time (kWh), and installed capacity (kWp). Use this for questions about which systems are online or offline, portfolio totals, or to list the plants.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_station_detail',
    description:
      "Get detailed live data for ONE solar plant/station by name (partial, case-insensitive). Returns status, current power, today/month/total energy, battery SOC, capacity, location, total device count and a breakdown by type (devicesByType, e.g. how many batteries / inverters / loggers), how many devices are offline, active alerts/faults, and plant attributes. Use when the user asks about a specific system/plant/site, including how many batteries/inverters/loggers it has.",
    input_schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'The plant/station name or part of it, e.g. "158 Mungar" or "Tea Gardens".',
        },
      },
      required: ['name'],
    },
  },
];

const r0 = (n?: number): number | undefined => (n == null ? undefined : Math.round(n));
const r1 = (n?: number): number | undefined => (n == null ? undefined : Math.round(n * 10) / 10);

// Normalise each platform's raw device-type strings to the labels the user sees
// in the portal, so the agent can answer "how many batteries/inverters/loggers".
const DEVICE_TYPE_LABEL: Record<string, string> = {
  COLLECTOR: 'Logger',
  DATALOGGER: 'Logger',
  DATA_LOGGER: 'Logger',
  LOGGER: 'Logger',
  INVERTER: 'Inverter',
  MICRO_INVERTER: 'Inverter',
  MICROINVERTER: 'Inverter',
  BATTERY: 'Battery',
  BMS: 'Battery',
  METER: 'Meter',
};
function deviceTypeLabel(t?: string): string {
  if (!t) return 'Other';
  const key = t.toUpperCase().replace(/[\s-]+/g, '_');
  return DEVICE_TYPE_LABEL[key] ?? t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
}
/** Count devices per normalized type, e.g. { Battery: 5, Inverter: 1, Logger: 1 }. */
function countByType(devices: { type?: string }[]): Record<string, number> | undefined {
  const by: Record<string, number> = {};
  for (const d of devices) {
    const label = deviceTypeLabel(d.type);
    by[label] = (by[label] ?? 0) + 1;
  }
  return Object.keys(by).length ? by : undefined;
}
/** Drop null/undefined keys so the model isn't billed for empty fields. */
function clean<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && v !== '')) as Partial<T>;
}

/** Execute a solar tool call from the model and return a compact JSON-able result. */
export async function executeSolarTool(name: string, input: Record<string, unknown>): Promise<unknown> {
  if (name === 'get_solar_overview') {
    const { stations, errors } = await aggregateStations();
    return {
      platforms: configuredProviders().map((p) => p.name),
      unreachablePlatforms: errors.length ? errors.map((e) => e.name) : undefined,
      count: stations.length,
      online: stations.filter((s) => s.status === 'online').length,
      waiting: stations.filter((s) => s.status === 'waiting').length,
      partial: stations.filter((s) => s.status === 'partial').length,
      offline: stations.filter((s) => s.status === 'offline').length,
      totalDailyKwh: r1(stations.reduce((a, s) => a + (s.dailyEnergyKwh ?? 0), 0)),
      totalCapacityKw: r1(stations.reduce((a, s) => a + (s.capacityKw ?? 0), 0)),
      // Compact rows (rounded, nulls dropped, location lives in the detail tool).
      stations: stations.map((s) =>
        clean({
          name: s.name,
          platform: s.provider,
          status: s.status,
          powerW: r0(s.currentPowerW),
          todayKwh: r1(s.dailyEnergyKwh),
          totalKwh: r1(s.totalEnergyKwh),
          kWp: s.capacityKw,
        }),
      ),
    };
  }

  if (name === 'get_station_detail') {
    const q = String(input?.name ?? '').trim().toLowerCase();
    if (!q) return { error: 'The "name" argument is required.' };
    const { stations } = await aggregateStations();
    const match =
      stations.find((s) => s.name.toLowerCase() === q) ??
      stations.find((s) => s.name.toLowerCase().includes(q)) ??
      stations.find((s) => q.includes(s.name.toLowerCase()));
    if (!match) {
      return { error: `No station matched "${input.name}".`, availableStations: stations.map((s) => s.name) };
    }
    const provider = getProvider(match.provider);
    let detail: Awaited<ReturnType<NonNullable<typeof provider>['stationDetail']>> | null = null;
    try {
      detail = provider ? await provider.stationDetail(match.id) : null;
    } catch {
      /* fall back to the overview-level fields */
    }
    const devices = detail?.devices ?? [];
    return clean({
      name: match.name,
      platform: match.provider,
      status: match.status,
      powerW: r0(match.currentPowerW),
      todayKwh: r1(match.dailyEnergyKwh),
      monthKwh: r1(match.monthlyEnergyKwh),
      totalKwh: r1(match.totalEnergyKwh),
      batterySoc: r0(match.batterySoc),
      kWp: match.capacityKw,
      location: match.location,
      deviceCount: devices.length || undefined,
      // Per-type counts so the agent can answer "how many batteries/inverters/loggers".
      devicesByType: countByType(devices),
      offlineDeviceCount: devices.filter((d) => !d.online).length || undefined,
      // Only the offline devices' serials matter for support — don't ship the
      // full healthy list.
      offlineDevices: devices.filter((d) => !d.online).map((d) => d.sn) || undefined,
      activeAlerts: detail?.alerts.length
        ? detail.alerts.map((a) => clean({ name: a.name, code: a.code, device: a.deviceSn, level: a.level }))
        : undefined,
      attributes: detail?.info.length ? detail.info : undefined,
    });
  }

  return { error: `Unknown tool: ${name}` };
}
