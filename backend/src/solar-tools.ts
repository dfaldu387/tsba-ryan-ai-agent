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
      "List every monitored solar plant/station across all connected platforms (e.g. Deye, GoodWe, Sungrow) with live status (online/partial/offline), current power (W), energy generated today and all-time (kWh), and installed capacity (kWp). Use this for questions about which systems are online or offline, portfolio totals, or to list the plants.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_station_detail',
    description:
      "Get detailed live data for ONE solar plant/station by name (partial, case-insensitive). Returns status, current power, today/month/total energy, battery SOC, capacity, location, devices (with online state), active alerts/faults, and plant attributes. Use when the user asks about a specific system/plant/site.",
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
