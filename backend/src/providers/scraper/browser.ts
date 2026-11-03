import { readFileSync } from 'node:fs';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { hasSession, hasSessionStorage, sessionPath, sessionStoragePath } from './session.js';

/** Thrown when a scrape finds no saved session, or the saved one has expired. */
export class SessionExpiredError extends Error {
  constructor(public portalKey: string) {
    super(`${portalKey}_session_expired: run \`npm run portal-login ${portalKey}\` to sign in again`);
    this.name = 'SessionExpiredError';
  }
}

/**
 * Shared headless Chromium for the portal scrapers. Launching a browser is slow
 * and heavy, so we keep ONE instance alive and reuse it, closing it after a spell
 * of inactivity. Each scrape runs in its own throwaway context (its own cookie
 * jar) so portals never cross-contaminate sessions.
 */

let browser: Browser | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
const IDLE_MS = 5 * 60_000; // close the browser if unused for 5 min

async function getBrowser(): Promise<Browser> {
  if (browser && browser.isConnected()) return browser;
  browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
  });
  return browser;
}

function armIdleClose() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    void browser?.close().catch(() => {});
    browser = null;
  }, IDLE_MS);
}

/**
 * Run `fn` in a fresh browser context (realistic UA + viewport) and always tear
 * the context down afterwards. The browser itself stays warm for the next call.
 */
export async function withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  const b = await getBrowser();
  let ctx: BrowserContext | null = null;
  try {
    ctx = await b.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      viewport: { width: 1440, height: 900 },
      locale: 'en-AU',
      timezoneId: 'Australia/Brisbane',
    });
    const page = await ctx.newPage();
    page.setDefaultTimeout(30_000);
    return await fn(page);
  } finally {
    await ctx?.close().catch(() => {});
    armIdleClose();
  }
}

/**
 * Run `fn` in a context seeded with a portal's saved login session. Throws
 * SessionExpiredError if no session file exists yet (the one-time login hasn't
 * been done). The scrape routine should also throw SessionExpiredError if it
 * gets bounced to a login page (the saved session lapsed).
 */
export async function withSession<T>(portalKey: string, fn: (page: Page) => Promise<T>): Promise<T> {
  if (!hasSession(portalKey)) throw new SessionExpiredError(portalKey);
  const b = await getBrowser();
  let ctx: BrowserContext | null = null;
  try {
    ctx = await b.newContext({
      storageState: sessionPath(portalKey),
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      viewport: { width: 1440, height: 900 },
      locale: 'en-AU',
      timezoneId: 'Australia/Brisbane',
    });
    // Replay captured localStorage + sessionStorage for the portal's origin.
    // storageState over CDP often misses localStorage and never has
    // sessionStorage, where some SPAs (SAJ) keep their auth token. Passed as a
    // STRING init script so tsx's esbuild can't inject its __name helper into a
    // serialized function.
    if (hasSessionStorage(portalKey)) {
      try {
        const parsed = JSON.parse(readFileSync(sessionStoragePath(portalKey), 'utf8')) as {
          origin: string;
          local?: Record<string, string>;
          session?: Record<string, string>;
          items?: Record<string, string>; // legacy sidecar shape
        };
        const local = parsed.local ?? {};
        const session = parsed.session ?? parsed.items ?? {};
        const script = `(() => { try { if (location.origin === ${JSON.stringify(parsed.origin)}) {` +
          ` const L = ${JSON.stringify(local)}; for (const k in L) localStorage.setItem(k, L[k]);` +
          ` const S = ${JSON.stringify(session)}; for (const k in S) sessionStorage.setItem(k, S[k]);` +
          ` } } catch (e) {} })();`;
        await ctx.addInitScript(script);
      } catch {
        /* no/invalid sidecar — proceed without it */
      }
    }
    const page = await ctx.newPage();
    page.setDefaultTimeout(30_000);
    return await fn(page);
  } finally {
    await ctx?.close().catch(() => {});
    armIdleClose();
  }
}

/** Close the shared browser (e.g. on server shutdown). */
export async function closeBrowser(): Promise<void> {
  if (idleTimer) clearTimeout(idleTimer);
  await browser?.close().catch(() => {});
  browser = null;
}
