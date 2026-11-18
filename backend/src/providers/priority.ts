import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Request priority for rate-limited provider APIs. Work started inside
 * `inBackground()` (fleet scans, recorders) is tagged low priority, so providers
 * with a serial request lane (Deye) let a person waiting on a plant page go
 * first instead of queueing behind dozens of background calls.
 */
const store = new AsyncLocalStorage<{ background: boolean }>();

export function inBackground<T>(fn: () => Promise<T>): Promise<T> {
  return store.run({ background: true }, fn);
}

export function isBackground(): boolean {
  return store.getStore()?.background === true;
}
