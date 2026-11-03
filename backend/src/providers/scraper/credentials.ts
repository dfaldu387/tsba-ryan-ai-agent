import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { env } from '../../env.js';

/**
 * Portal login credentials for the scraper providers. Read at runtime from a
 * gitignored plain-text file (never committed, never logged). The file is a list
 * of sections:
 *
 *   Solarman Business
 *   Username: <email>
 *   Password: <pass>
 *
 * Each section is matched to a provider key by keyword, so the exact heading
 * wording doesn't matter. Credentials can also come from env vars
 * (SCRAPER_<KEY>_USER / SCRAPER_<KEY>_PASS), which take precedence.
 */

export interface PortalCreds {
  username: string;
  password: string;
}

// provider key -> keywords that identify its section heading in the file
const SECTION_KEYS: Record<string, string[]> = {
  solarman: ['solarman'],
  solis: ['solis'],
  growatt: ['growatt', 'shine', 'oss'],
  dyness: ['dyness'],
  elekeeper: ['elekeeper', 'saj'],
  whes: ['whes', 'ecos'],
};

function credsFilePath(): string {
  // Allow override; default to the repo-root login file.
  const override = process.env.PORTAL_CREDS_FILE;
  if (override && existsSync(override)) return override;
  // env.ts anchors data files at the repo root via resolve of its own env path;
  // fall back to CWD-relative which is the backend's parent in dev.
  const candidates = [
    resolve(process.cwd(), 'solar-monitoring-platform-login-details.txt'),
    resolve(process.cwd(), '..', 'solar-monitoring-platform-login-details.txt'),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0];
}

let fileCache: Record<string, PortalCreds> | null = null;

/** Parse the login file into { key: {username, password} }. Cached after first read. */
function parseFile(): Record<string, PortalCreds> {
  if (fileCache) return fileCache;
  const out: Record<string, PortalCreds> = {};
  const path = credsFilePath();
  if (!existsSync(path)) {
    fileCache = out;
    return out;
  }
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  let current: string | null = null;
  let user = '';
  let pass = '';
  const flush = () => {
    if (current && user && pass) out[current] = { username: user, password: pass };
    user = '';
    pass = '';
  };
  const keyFor = (heading: string): string | null => {
    const h = heading.toLowerCase();
    for (const [key, words] of Object.entries(SECTION_KEYS)) if (words.some((w) => h.includes(w))) return key;
    return null;
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const um = line.match(/^user(?:name)?\s*:\s*(.+)$/i);
    const pm = line.match(/^pass(?:word)?\s*:\s*(.+)$/i);
    if (um) {
      user = um[1].trim();
    } else if (pm) {
      pass = pm[1].trim();
    } else if (!/[:]/.test(line) || /login|portal|monitoring|cloud|business|hub/i.test(line)) {
      // A section heading — commit the previous section first.
      flush();
      current = keyFor(line);
    }
  }
  flush();
  fileCache = out;
  return out;
}

/** Credentials for a provider key, from env (preferred) or the login file; null if absent. */
export function portalCreds(key: string): PortalCreds | null {
  const envUser = process.env[`SCRAPER_${key.toUpperCase()}_USER`];
  const envPass = process.env[`SCRAPER_${key.toUpperCase()}_PASS`];
  if (envUser && envPass) return { username: envUser, password: envPass };
  return parseFile()[key] ?? null;
}

/** True when we have credentials for this portal (gates the scraper provider). */
export function hasPortalCreds(key: string): boolean {
  return portalCreds(key) != null;
}

void env; // keep env import for future base-url overrides
