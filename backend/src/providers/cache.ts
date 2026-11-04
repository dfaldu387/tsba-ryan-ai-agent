/** Tiny in-memory TTL cache, shared by providers to bound upstream API calls. */
interface Entry<T> {
  value: T;
  expiresAt: number;
}

const store = new Map<string, Entry<unknown>>();
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

function refresh<T>(key: string, ttlMs: number, compute: () => Promise<T>): Promise<T> {
  const promise = (async () => {
    try {
      const value = await compute();
      store.set(key, { value, expiresAt: Date.now() + ttlMs });
      return value;
    } finally {
      // Clear the in-flight marker whether compute() resolved or threw, so a
      // failure doesn't wedge the key (and retries aren't cached).
      inflight.delete(key);
    }
  })();
  inflight.set(key, promise);
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

  // No usable value — must compute. Share one in-flight compute across callers.
  const pending = inflight.get(key) as Promise<T> | undefined;
  if (pending) return pending;
  return refresh(key, ttlMs, compute);
}

export function invalidate(prefix: string): void {
  for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k);
}
