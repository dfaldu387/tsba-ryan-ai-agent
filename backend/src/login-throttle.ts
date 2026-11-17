/**
 * In-memory brute-force guard for /api/login (single process — PM2 runs one).
 * Failures are counted in a sliding window per IP+email (stops guessing one
 * account) and per IP (stops spraying many accounts). A success clears the
 * IP+email counter. Entries expire on their own, so the maps stay small.
 */
const WINDOW_MS = 15 * 60_000;
const MAX_PER_ACCOUNT = 8; // per IP + email
const MAX_PER_IP = 40;

const hits = new Map<string, number[]>();

const keyOf = (ip: string, email: string) => `${ip}|${email.toLowerCase()}`;

function recent(key: string, now: number): number[] {
  const list = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (list.length) hits.set(key, list);
  else hits.delete(key);
  return list;
}

/** ms until this IP/email may try again, or 0 if allowed. */
export function loginBlockedFor(ip: string, email: string, now = Date.now()): number {
  for (const [key, max] of [[keyOf(ip, email), MAX_PER_ACCOUNT], [`ip|${ip}`, MAX_PER_IP]] as const) {
    const list = recent(key, now);
    if (list.length >= max) return WINDOW_MS - (now - list[list.length - max]);
  }
  return 0;
}

export function noteLoginFailure(ip: string, email: string, now = Date.now()): void {
  for (const key of [keyOf(ip, email), `ip|${ip}`]) hits.set(key, [...recent(key, now), now]);
  if (hits.size > 10_000) for (const k of hits.keys()) recent(k, now); // prune
}

export function clearLoginFailures(ip: string, email: string): void {
  hits.delete(keyOf(ip, email));
}
