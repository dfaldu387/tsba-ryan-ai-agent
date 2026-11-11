import { readFileSync } from 'node:fs';
import { chromium, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from 'playwright';
import {
  clearSession,
  hasSession,
  hasSessionStorage,
  sessionPath,
  sessionStoragePath,
  writeSessionStorage,
} from './session.js';
import { portalCreds } from './credentials.js';
import { AUTO_LOGIN } from './auto-login-portals.js';

/** Shared context fingerprint (realistic UA + viewport) for every scrape/login. */
const CONTEXT_OPTS: BrowserContextOptions = {
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  viewport: { width: 1440, height: 900 },
  locale: 'en-AU',
  timezoneId: 'Australia/Brisbane',
};

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
let browserPromise: Promise<Browser> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
const IDLE_MS = 5 * 60_000; // close the browser if unused for 5 min

/**
 * Global cap on how many browser contexts may exist AT ONCE across the whole
 * app (fleet-list scrapes, detail scrapes and the alert scan all share it).
 * Each context is a live Chromium tab costing tens of MB; without a hard cap a
 * burst of requests on a cold cache can open dozens at once and OOM the server.
 * Keep it small — scrape results are cached, so throughput barely matters.
 */
const MAX_CONTEXTS = Math.max(1, Number(process.env.SCRAPER_MAX_CONTEXTS) || 1);
let active = 0;
const waiters: Array<() => void> = [];

// Resource types that a DATA scrape never needs — we only want the page's JS to
// run and fire its XHR/fetch for the device list. Blocking images, media and
// fonts (plus third-party analytics) cuts the scrape's memory, CPU and bandwidth
// sharply and makes it finish sooner (less to download before the data call
// fires). CSS is deliberately kept — it's tiny and a few SPAs gate their mount on
// it. Set SCRAPER_BLOCK_ASSETS=0 to disable entirely if a portal misbehaves.
const BLOCK_ASSETS = process.env.SCRAPER_BLOCK_ASSETS !== '0';
const BLOCKED_TYPES = new Set(['image', 'media', 'font']);
const TRACKER_HOSTS =
  /google-analytics|googletagmanager|doubleclick|facebook\.net|connect\.facebook|hotjar|sentry|clarity\.ms|segment\.|mixpanel|fullstory|intercom|bugsnag|amplitude/i;

/**
 * Drop non-essential requests on a scrape context: static assets and third-party
 * trackers. Login contexts are NOT trimmed (a captcha/image may be needed), only
 * data scrapes. Best-effort — any routing error just lets the request through.
 */
async function trimAssets(ctx: BrowserContext): Promise<void> {
  if (!BLOCK_ASSETS) return;
  await ctx
    .route('**/*', (route) => {
      try {
        const req = route.request();
        if (BLOCKED_TYPES.has(req.resourceType()) || TRACKER_HOSTS.test(req.url())) return route.abort();
        return route.continue();
      } catch {
        return route.continue().catch(() => {});
      }
    })
    .catch(() => {});
}

function acquireSlot(): Promise<void> {
  if (active < MAX_CONTEXTS) {
    active++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => waiters.push(resolve));
}

function releaseSlot(): void {
  const next = waiters.shift();
  if (next) {
    next(); // hand the slot straight to the next waiter (active stays the same)
  } else {
    active--;
  }
}

async function getBrowser(): Promise<Browser> {
  if (browser && browser.isConnected()) return browser;
  // Memoize the LAUNCH PROMISE (not the browser) so concurrent callers share a
  // single launch. Memoizing only the resolved browser races: several scrapes
  // firing at once would each see `browser === null` before the first launch
  // resolves and spawn their own Chromium, leaking every instance but the last.
  if (!browserPromise) {
    browserPromise = chromium
      .launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--disable-blink-features=AutomationControlled',
          // Shed features a headless data-scrape never uses, to lower the memory
          // and CPU footprint of the shared Chromium.
          '--disable-gpu',
          '--disable-extensions',
          '--disable-background-networking',
          '--disable-default-apps',
          '--disable-sync',
          '--disable-software-rasterizer',
          '--mute-audio',
          '--no-first-run',
          '--renderer-process-limit=2',
        ],
      })
      .then((b) => {
        browser = b;
        // If Chromium dies, drop both references so the next call relaunches.
        b.on('disconnected', () => {
          browser = null;
          browserPromise = null;
        });
        return b;
      })
      .catch((err) => {
        browserPromise = null; // let a later call retry after a failed launch
        throw err;
      });
  }
  return browserPromise;
}

function armIdleClose() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    void browser?.close().catch(() => {});
    browser = null;
    browserPromise = null;
  }, IDLE_MS);
}

/**
 * Run `fn` in a fresh browser context (realistic UA + viewport) and always tear
 * the context down afterwards. The browser itself stays warm for the next call.
 */
export async function withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  await acquireSlot();
  let ctx: BrowserContext | null = null;
  try {
    const b = await getBrowser();
    ctx = await b.newContext(CONTEXT_OPTS);
    await trimAssets(ctx);
    const page = await ctx.newPage();
    page.setDefaultTimeout(30_000);
    return await fn(page);
  } finally {
    await ctx?.close().catch(() => {});
    armIdleClose();
    releaseSlot();
  }
}

/** Can we sign this portal in headlessly from stored credentials? */
function canAutoLogin(portalKey: string): boolean {
  return !!AUTO_LOGIN[portalKey] && !!portalCreds(portalKey);
}

// Dedupe concurrent auto-logins for the same portal: several scrapes hitting a
// missing session at once should share ONE login, not stampede the portal.
const loginInflight = new Map<string, Promise<boolean>>();

/**
 * Drive a portal's headless login with the `.env`/file credentials and save a
 * fresh session. Returns false (rather than throwing) if there's no auto-login
 * config/creds, the portal challenges us, or the login simply doesn't land —
 * the caller then falls back to the "run portal-login" message.
 */
async function performLogin(portalKey: string): Promise<boolean> {
  const cfg = AUTO_LOGIN[portalKey];
  const creds = portalCreds(portalKey);
  if (!cfg || !creds) return false;

  await acquireSlot();
  let ctx: BrowserContext | null = null;
  try {
    const b = await getBrowser();
    ctx = await b.newContext(CONTEXT_OPTS);
    const page = await ctx.newPage();
    page.setDefaultTimeout(30_000);
    await page.goto(cfg.loginUrl, { waitUntil: 'networkidle', timeout: 45_000 }).catch(() => {});
    await cfg.login(page, creds);

    // Poll for the signed-in state (handles the post-submit redirect).
    const deadline = Date.now() + 25_000;
    let ok = false;
    while (Date.now() < deadline) {
      await page.waitForTimeout(1000);
      try {
        if (cfg.successWhen(page)) {
          ok = true;
          break;
        }
      } catch {
        /* page mid-navigation — keep polling */
      }
    }
    if (!ok) return false;

    await page.waitForTimeout(1500); // let post-login redirects settle
    await ctx.storageState({ path: sessionPath(portalKey) });

    // Capture a localStorage + sessionStorage sidecar too. storageState saves
    // cookies + localStorage but NOT sessionStorage, where some SPAs (WHES/ECOS,
    // SAJ/Elekeeper) keep their auth token — withSession replays this on scrape.
    try {
      // No named inner functions here: under tsx/esbuild a named function in an
      // evaluate() body gets a `__name(...)` helper injected that doesn't exist
      // in the browser, throwing "__name is not defined". Inline, anonymous only.
      const snap = await page.evaluate(() => {
        const local: Record<string, string> = {};
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k) local[k] = localStorage.getItem(k) ?? '';
        }
        const session: Record<string, string> = {};
        for (let i = 0; i < sessionStorage.length; i++) {
          const k = sessionStorage.key(i);
          if (k) session[k] = sessionStorage.getItem(k) ?? '';
        }
        return { origin: location.origin, local, session };
      });
      writeSessionStorage(portalKey, snap);
    } catch (e) {
      console.error('[autologin] sidecar capture failed:', (e as Error).message);
    }
    return true;
  } catch {
    return false;
  } finally {
    await ctx?.close().catch(() => {});
    armIdleClose();
    releaseSlot();
  }
}

/** Ensure a usable session exists, auto-logging-in if we can. */
function ensureSession(portalKey: string): Promise<boolean> {
  if (hasSession(portalKey)) return Promise.resolve(true);
  if (!canAutoLogin(portalKey)) return Promise.resolve(false);
  const pending = loginInflight.get(portalKey);
  if (pending) return pending;
  const p = performLogin(portalKey).finally(() => loginInflight.delete(portalKey));
  loginInflight.set(portalKey, p);
  return p;
}

/** Run `fn` in a context seeded with the portal's saved session. */
async function runInSession<T>(portalKey: string, fn: (page: Page) => Promise<T>): Promise<T> {
  await acquireSlot();
  let ctx: BrowserContext | null = null;
  try {
    const b = await getBrowser();
    ctx = await b.newContext({ ...CONTEXT_OPTS, storageState: sessionPath(portalKey) });
    await trimAssets(ctx);
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
    releaseSlot();
  }
}

/**
 * Run `fn` in a context seeded with a portal's saved login session.
 *
 * Self-healing: if no session exists yet, we try a headless auto-login from the
 * stored credentials (for portals that support it). If the scrape then throws
 * SessionExpiredError — the saved session lapsed and bounced us to /login — we
 * drop the stale session, auto-login once more, and retry the scrape a single
 * time. When auto-login isn't possible (no config/creds, or a bot challenge),
 * we throw SessionExpiredError so an operator does the one-time portal-login.
 */
export async function withSession<T>(portalKey: string, fn: (page: Page) => Promise<T>): Promise<T> {
  if (!(await ensureSession(portalKey))) throw new SessionExpiredError(portalKey);

  try {
    return await runInSession(portalKey, fn);
  } catch (err) {
    // A lapsed session bounced the scrape to /login. If we can re-auth, do it
    // once and retry; otherwise surface the original error.
    if (err instanceof SessionExpiredError && canAutoLogin(portalKey)) {
      clearSession(portalKey);
      if (!(await ensureSession(portalKey))) throw err;
      return await runInSession(portalKey, fn);
    }
    throw err;
  }
}

/** Close the shared browser (e.g. on server shutdown). */
export async function closeBrowser(): Promise<void> {
  if (idleTimer) clearTimeout(idleTimer);
  await browser?.close().catch(() => {});
  browser = null;
  browserPromise = null;
}
