import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Per-portal saved browser sessions (Playwright storageState). A human logs in
 * once (clearing any Cloudflare "verify you are human" challenge) via the
 * `portal-login` script; the resulting cookies/localStorage are saved here and
 * reused by the headless scraper, so the challenge is never hit again until the
 * session expires.
 *
 * These files contain live session cookies — they are secrets. The directory is
 * gitignored; never log their contents.
 */

const SESS_DIR = resolve(process.cwd(), '.portal-sessions');

export function sessionDir(): string {
  if (!existsSync(SESS_DIR)) mkdirSync(SESS_DIR, { recursive: true });
  return SESS_DIR;
}

export function sessionPath(key: string): string {
  return resolve(sessionDir(), `${key}.json`);
}

export function hasSession(key: string): boolean {
  return existsSync(sessionPath(key));
}

/**
 * Some SPAs (e.g. SAJ/Elekeeper) keep their auth token in sessionStorage, which
 * Playwright's storageState does NOT capture. We save it to a sidecar file and
 * replay it into the scrape context. Shape: { origin, items: {k: v} }.
 */
export function sessionStoragePath(key: string): string {
  return resolve(sessionDir(), `${key}.ss.json`);
}

export function hasSessionStorage(key: string): boolean {
  return existsSync(sessionStoragePath(key));
}
