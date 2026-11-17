import type { AuthenticatedUser } from '@tsba/shared';

/**
 * Server-side PII redaction for the read-only Viewer role. The UI already
 * masks these fields, but the API used to send them in full, so anyone with a
 * viewer login could read every customer's name, address and contact details
 * straight from the JSON. Masking matches the frontend's `mask()` ("J••• S•••"),
 * which is idempotent, so the UI renders the same either way.
 */

export function canSeePii(user: AuthenticatedUser | undefined): boolean {
  return !!user && user.role !== 'viewer';
}

export function maskText(s: string | null | undefined): string | undefined {
  if (!s) return s ?? undefined;
  return s
    .split(/\s+/)
    .map((w) => (w.length <= 1 ? w : `${w[0]}${'•'.repeat(Math.min(3, w.length - 1))}`))
    .join(' ');
}

const PII_LABEL = /owner|contact|customer|installer|email|phone|mobile|address|location|street|suburb|postcode/i;

/** Plant list rows: mask names of people/places, coarsen coordinates to ~1 km. */
export function redactStations<T extends { owner?: string; contact?: string; location?: string; lat?: number; lng?: number }>(
  stations: T[],
  user: AuthenticatedUser | undefined,
): T[] {
  if (canSeePii(user)) return stations;
  const coarse = (v?: number) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v);
  return stations.map((s) => ({ ...s, owner: maskText(s.owner), contact: maskText(s.contact), location: maskText(s.location), lat: coarse(s.lat), lng: coarse(s.lng) }));
}

/** Detail "info" rows ({label, value}): mask values whose label is personal. */
export function redactInfo<T extends { label: string; value: string }>(info: T[] | undefined, user: AuthenticatedUser | undefined): T[] | undefined {
  if (!info || canSeePii(user)) return info;
  return info.map((i) => (PII_LABEL.test(i.label) ? { ...i, value: maskText(i.value) ?? '' } : i));
}
