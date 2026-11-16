/**
 * Address → coordinates for plants whose monitoring platform doesn't report a
 * location (SAJ, Solarman, Solis, Sigenergy… or 0,0 when the installer never
 * set one). Uses OpenStreetMap Nominatim within its usage policy: one request
 * per second at most, an identifying User-Agent, and every result (hit or miss)
 * cached so an address is only ever sent once. The cache lives in app_settings
 * (key 'plant_geocodes') so it survives restarts.
 */
import { env } from './env.js';
import { getSetting, setSetting } from './settings-repo.js';

const KEY = 'plant_geocodes';
const ENDPOINT = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'TSBA-Fleet-Console/1.0 (solar fleet map)';
const SPACING_MS = 1100; // Nominatim: absolute max 1 request/second
const MISS_RETRY_MS = 30 * 24 * 3600 * 1000; // re-try addresses that found nothing after 30 days

/** How close the match is: the house itself, the street (midpoint of the road), or the suburb centre. */
export type Precision = 'house' | 'street' | 'suburb';
interface Hit { lat: number; lng: number; at: number; q: string; precision?: Precision }
interface Miss { miss: true; at: number }
type Entry = Hit | Miss;

let cache: Record<string, Entry> | null = null;
let loading: Promise<Record<string, Entry>> | null = null;
const queue: string[] = [];
const queued = new Set<string>();
let running = false;
let dirty = false;

/** Normalised cache key for an address. */
const norm = (a: string) => a.toLowerCase().replace(/\s+/g, ' ').replace(/\s*,\s*/g, ',').trim();

/** Inside Australia (incl. Tasmania), so a bad match overseas is rejected. */
const inAu = (lat: number, lng: number) => lat < -9 && lat > -45 && lng > 111 && lng < 156;

/** A provider coordinate is usable only when present, non-zero and in Australia. */
export function hasCoords(s: { lat?: number; lng?: number }): boolean {
  return typeof s.lat === 'number' && typeof s.lng === 'number' && Number.isFinite(s.lat) && Number.isFinite(s.lng)
    && !(s.lat === 0 && s.lng === 0) && inAu(s.lat, s.lng);
}

async function load(): Promise<Record<string, Entry>> {
  if (cache) return cache;
  if (!loading) {
    loading = (async () => {
      const stored = env.storage === 'postgres' ? await getSetting<Record<string, Entry>>(KEY).catch(() => null) : null;
      cache = stored ?? {};
      return cache;
    })();
  }
  return loading;
}

async function persist(): Promise<void> {
  if (!dirty || !cache || env.storage !== 'postgres') return;
  dirty = false;
  await setSetting(KEY, cache).catch(() => { dirty = true; });
}

/** Queries to try, most precise first: the full address, then suburb/state/postcode. */
function candidates(address: string): string[] {
  const a = address.replace(/\s+/g, ' ').trim();
  const out = [a];
  const pc = a.match(/\b([A-Za-z][A-Za-z .'-]+?)\s*,?\s*(QLD|NSW|VIC|SA|WA|TAS|NT|ACT)\b\s*,?\s*(\d{4})?/i);
  if (pc) {
    const suburb = pc[1].split(',').pop()!.replace(/^\d+[a-z]?\s+/i, '').trim();
    out.push(`${suburb} ${pc[2].toUpperCase()}${pc[3] ? ` ${pc[3]}` : ''}, Australia`);
  } else {
    const pcOnly = a.match(/\b(\d{4})\b(?!.*\b\d{4}\b)/);
    if (pcOnly) out.push(`${pcOnly[1]}, Australia`);
  }
  return [...new Set(out)];
}

async function lookup(q: string): Promise<{ lat: number; lng: number; precision: Precision } | null> {
  const url = `${ENDPOINT}?format=jsonv2&limit=1&countrycodes=au&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
  if (res.status === 429) throw new Error('rate_limited');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const rows = (await res.json()) as { lat: string; lon: string; place_rank?: number }[];
  const r = rows[0];
  if (!r) return null;
  const lat = Number(r.lat);
  const lng = Number(r.lon);
  // Nominatim place_rank: 30 = a building/house number, 26–27 = a road, lower = suburb/locality.
  const rank = r.place_rank ?? 0;
  const precision: Precision = rank >= 28 ? 'house' : rank >= 26 ? 'street' : 'suburb';
  return Number.isFinite(lat) && Number.isFinite(lng) && inAu(lat, lng) ? { lat, lng, precision } : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function worker(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const c = await load();
    while (queue.length) {
      const address = queue.shift()!;
      queued.delete(address);
      const k = norm(address);
      let found: Hit | null = null;
      let failed = false;
      for (const q of candidates(address)) {
        try {
          const hit = await lookup(q);
          await sleep(SPACING_MS);
          if (hit) { found = { ...hit, at: Date.now(), q: q === address ? 'address' : 'suburb', precision: q === address ? hit.precision : 'suburb' }; break; }
        } catch (err) {
          // Network error / rate limit: back off and leave it for a later pass.
          failed = true;
          await sleep((err as Error).message === 'rate_limited' ? 60_000 : 5_000);
          break;
        }
      }
      if (!failed) {
        c[k] = found ?? { miss: true, at: Date.now() };
        dirty = true;
      }
      if (dirty && queue.length % 10 === 0) await persist();
    }
    await persist();
  } finally {
    running = false;
  }
}

// ── Manual pin corrections (admin drags a pin to the right spot) ─────────────
const LOC_KEY = 'plant_locations';
export interface ManualLocation { lat: number; lng: number; by?: string; at: number }
let manual: Record<string, ManualLocation> | null = null;
async function loadManual(): Promise<Record<string, ManualLocation>> {
  if (manual) return manual;
  manual = (env.storage === 'postgres' ? await getSetting<Record<string, ManualLocation>>(LOC_KEY).catch(() => null) : null) ?? {};
  return manual;
}
/** Save (or with null, clear) an admin-set position for a plant. */
export async function setManualLocation(provider: string, id: string, loc: { lat: number; lng: number } | null, by?: string): Promise<void> {
  const m = await loadManual();
  const k = `${provider}:${id}`;
  if (loc) {
    if (!Number.isFinite(loc.lat) || !Number.isFinite(loc.lng) || !inAu(loc.lat, loc.lng)) throw new Error('Location must be inside Australia.');
    m[k] = { lat: Math.round(loc.lat * 1e6) / 1e6, lng: Math.round(loc.lng * 1e6) / 1e6, by, at: Date.now() };
  } else delete m[k];
  if (env.storage === 'postgres') await setSetting(LOC_KEY, m);
}

export type LocationSource = 'manual' | 'provider' | Precision;

/**
 * Resolve each station's position, best source first: an admin-set pin, the
 * platform's own coordinates, then the geocoded address (house → street →
 * suburb). Unknown addresses are queued for background geocoding and appear on
 * a later refresh; entries cached before precision was recorded are re-checked.
 * Never blocks on the network.
 */
export async function applyGeocodes<T extends { id: string; provider: string; lat?: number; lng?: number; location?: string; locationSource?: LocationSource }>(
  stations: T[],
): Promise<T[]> {
  const c = await load().catch(() => ({} as Record<string, Entry>));
  const man = await loadManual().catch(() => ({} as Record<string, ManualLocation>));
  let added = false;
  const enqueue = (address: string) => {
    if (!queued.has(address)) { queue.push(address); queued.add(address); added = true; }
  };
  const out = stations.map((s) => {
    const m = man[`${s.provider}:${s.id}`];
    if (m) return { ...s, lat: m.lat, lng: m.lng, locationSource: 'manual' as const };
    if (hasCoords(s)) return { ...s, locationSource: 'provider' as const };
    const address = s.location?.trim();
    if (!address || address.length < 4) return { ...s, lat: undefined, lng: undefined, locationSource: undefined };
    const e = c[norm(address)];
    if (e && !('miss' in e)) {
      if (!e.precision) enqueue(address); // cached before precision existed → re-check in the background
      const precision: Precision = e.precision ?? (e.q === 'suburb' ? 'suburb' : 'street');
      return { ...s, lat: e.lat, lng: e.lng, locationSource: precision };
    }
    if (!e || Date.now() - e.at > MISS_RETRY_MS) enqueue(address);
    return { ...s, lat: undefined, lng: undefined, locationSource: undefined };
  });
  if (added) void worker();
  return out;
}

/** Progress for the UI: how many addresses are still waiting to be looked up. */
export function geocodeBacklog(): number {
  return queue.length + (running ? 1 : 0);
}
