import { isBackground } from './priority.js';

/** Tiny in-memory TTL cache, shared by providers to bound upstream API calls. */
interface Entry<T> {
  value: T;
  expiresAt: number;
}

const store = new Map<string, Entry<unknown>>();

// Expired entries were only replaced when the same key was requested again, so
// one-off keys (per-plant details, attachments) accumulated forever. Sweep them
// periodically; SWR keys keep a grace period so they can still be served stale.
const SWEEP_EVERY_MS = 10 * 60_000;
const STALE_GRACE_MS = 60 * 60_000;
setInterval(() => {
  const now = Date.now();
  for (const [k, e] of store) if (e.expiresAt + STALE_GRACE_MS < now && !inflight.has(k)) store.delete(k);
}, SWEEP_EVERY_MS).unref();
// In-flight computations, keyed the same as `store`. Lets concurrent callers
// that miss the cache share ONE compute() instead of each firing their own
// (a thundering herd of duplicate scrapes/API calls).
const inflight = new Map<string, Promise<unknown>>();

interface CacheOpts {
  /**
   * Stale-while-revalidate: when a cached value exists but has expired, return
   * it IMMEDIATELY and refresh in the background, instead of blocking the caller
   * on a fresh compute. Ideal for slow sources (portal scrapes) where instant
   * last-good data beats a 30s wait. The caller only blocks when there is no
   * cached value at all (first ever call / after a restart).
   */
  swr?: boolean;
}

// Keys whose in-flight compute was started by background work (see priority.ts).
const bgInflight = new Set<string>();

function refresh<T>(key: string, ttlMs: number, compute: () => Promise<T>): Promise<T> {
  const background = isBackground();
  let promise!: Promise<T>;
  promise = (async () => {
    try {
      const value = await compute();
      store.set(key, { value, expiresAt: Date.now() + ttlMs });
      return value;
    } finally {
      // Clear the in-flight marker whether compute() resolved or threw, so a
      // failure doesn't wedge the key (and retries aren't cached). Only if it's
      // still ours — a foreground compute may have superseded it.
      if (inflight.get(key) === promise) {
        inflight.delete(key);
        bgInflight.delete(key);
      }
    }
  })();
  inflight.set(key, promise);
  if (background) bgInflight.add(key);
  else bgInflight.delete(key);
  return promise;
}

/** Return the cached value for `key`, or compute + cache it with the given TTL. */
export async function cached<T>(
  key: string,
  ttlMs: number,
  compute: () => Promise<T>,
  opts?: CacheOpts,
): Promise<T> {
  const hit = store.get(key) as Entry<T> | undefined;
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  // Stale-while-revalidate: serve the expired value now, refresh in background.
  if (hit && opts?.swr) {
    if (!inflight.has(key)) refresh(key, ttlMs, compute).catch(() => {});
    return hit.value;
  }

  // No usable value — must compute. Share one in-flight compute across callers,
  // EXCEPT a person joining a background (fleet-scan) compute: that one sits at
  // low priority behind the whole scan on rate-limited lanes (Deye), so the
  // interactive caller runs its own, high-priority compute instead.
  const pending = inflight.get(key) as Promise<T> | undefined;
  if (pending && !(bgInflight.has(key) && !isBackground())) return pending;
  return refresh(key, ttlMs, compute);
}

/** The cached value for `key` (even if expired), without computing anything. */
export function peek<T>(key: string): T | undefined {
  return (store.get(key) as Entry<T> | undefined)?.value;
}

export function invalidate(prefix: string): void {
  for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k);
}
