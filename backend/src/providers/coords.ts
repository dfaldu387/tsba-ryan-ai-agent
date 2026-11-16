/**
 * Pull installation coordinates out of a provider's raw plant record. Platforms
 * name them differently (latitude/longitude, lat/lng/lon, locationLat/Lng,
 * latitudeStr/longitudeStr…) and often send strings or 0 when unset. Returns
 * nothing unless both values are real numbers; the geocoder's hasCoords() check
 * then rejects 0,0 and anything outside Australia.
 */
const LAT_KEYS = ['latitude', 'lat', 'locationLat', 'latitudeStr', 'gpsLat', 'plantLatitude', 'stationLatitude'];
const LNG_KEYS = ['longitude', 'lng', 'lon', 'locationLng', 'locationLon', 'longitudeStr', 'gpsLng', 'gpsLon', 'plantLongitude', 'stationLongitude'];

function num(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

export function pickCoords(raw: unknown): { lat?: number; lng?: number } {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const first = (keys: string[]) => {
    for (const k of keys) {
      const v = num(r[k]);
      if (v !== undefined && v !== 0) return v;
    }
    return undefined;
  };
  let lat = first(LAT_KEYS);
  let lng = first(LNG_KEYS);
  if (lat === undefined || lng === undefined) return {};
  // Some portals swap the two; Australian latitudes are negative and longitudes ~110–155.
  if (Math.abs(lat) > 90 && Math.abs(lng) <= 90) [lat, lng] = [lng, lat];
  return { lat, lng };
}
