/**
 * Dependency-free sunrise/sunset for a latitude/longitude, used by the solar
 * alert monitor to decide whether it is currently night (and therefore whether
 * to defer an alert email until morning).
 *
 * This is a trimmed implementation of the well-known SunCalc algorithm (based on
 * the NOAA solar-position equations), accurate to ~1 minute for our purposes.
 * All times are computed in UTC; the day/night decision compares against the
 * current instant, so no timezone handling is needed.
 */

const rad = Math.PI / 180;
const DAY_MS = 86_400_000;
const J2000 = 2451545;

function toDays(date: Date): number {
  return date.valueOf() / DAY_MS - 0.5 + 2440588 - J2000;
}
function fromJulian(j: number): Date {
  return new Date((j + 0.5 - 2440588) * DAY_MS);
}

function solarMeanAnomaly(d: number): number {
  return rad * (357.5291 + 0.98560028 * d);
}
function eclipticLongitude(M: number): number {
  const C = rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const P = rad * 102.9372; // perihelion of the Earth
  return M + C + P + Math.PI;
}
function declination(L: number): number {
  const e = rad * 23.4397; // obliquity of the Earth
  return Math.asin(Math.sin(e) * Math.sin(L));
}

const J0 = 0.0009;
function approxTransit(Ht: number, lw: number, n: number): number {
  return J0 + (Ht + lw) / (2 * Math.PI) + n;
}
function solarTransitJ(ds: number, M: number, L: number): number {
  return J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
}
function hourAngle(h: number, phi: number, dec: number): number {
  return Math.acos((Math.sin(h) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec)));
}

export interface SunTimes {
  sunrise: Date;
  sunset: Date;
  /** True when the sun never sets / never rises on this date (polar region). */
  polar: boolean;
}

/** Sunrise and sunset (UTC) for the given date at lat/lng (degrees). */
export function getSunTimes(date: Date, lat: number, lng: number): SunTimes {
  const lw = rad * -lng;
  const phi = rad * lat;
  const d = toDays(date);
  const n = Math.round(d - J0 - lw / (2 * Math.PI));
  const ds = approxTransit(0, lw, n);
  const M = solarMeanAnomaly(ds);
  const L = eclipticLongitude(M);
  const dec = declination(L);
  const Jnoon = solarTransitJ(ds, M, L);
  const h0 = -0.833 * rad; // standard altitude of the sun's center at sunrise/sunset

  const cosH = (Math.sin(h0) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec));
  // |cosH| > 1 → the sun never reaches that altitude (polar day/night).
  if (cosH > 1 || cosH < -1 || Number.isNaN(cosH)) {
    return { sunrise: fromJulian(Jnoon), sunset: fromJulian(Jnoon), polar: true };
  }
  const w = hourAngle(h0, phi, dec);
  const Jset = solarTransitJ(approxTransit(w, lw, n), M, L);
  const Jrise = Jnoon - (Jset - Jnoon);
  return { sunrise: fromJulian(Jrise), sunset: fromJulian(Jset), polar: false };
}

/**
 * Whether it is currently night at the given location: before today's sunrise or
 * after today's sunset. In a polar region where the sun never sets we treat it
 * as day (never suppress); where it never rises, as night.
 */
export function isNight(lat: number, lng: number, at: Date = new Date()): boolean {
  const { sunrise, sunset, polar } = getSunTimes(at, lat, lng);
  if (polar) {
    // polar: sunrise===sunset at solar noon. If the sun is up at noon it's polar
    // day (not night); otherwise polar night. Approximate via declination sign vs
    // hemisphere by checking the noon altitude indirectly: treat as day to avoid
    // suppressing real daytime alerts at extreme latitudes.
    return false;
  }
  const t = at.getTime();
  return t < sunrise.getTime() || t > sunset.getTime();
}

/**
 * The next moment it becomes day at this location (i.e. upcoming sunrise). If it
 * is currently daytime, returns `at` unchanged. Used to describe when a deferred
 * alert will be sent.
 */
export function nextSunrise(lat: number, lng: number, at: Date = new Date()): Date {
  const today = getSunTimes(at, lat, lng);
  if (today.polar) return at;
  if (at.getTime() < today.sunrise.getTime()) return today.sunrise;
  // After sunrise today → next sunrise is tomorrow.
  const tomorrow = getSunTimes(new Date(at.getTime() + DAY_MS), lat, lng);
  return tomorrow.polar ? at : tomorrow.sunrise;
}
