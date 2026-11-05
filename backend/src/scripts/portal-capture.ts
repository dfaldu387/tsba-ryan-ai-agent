/**
 * Capture a portal login session from YOUR OWN Chrome (not a Playwright browser),
 * so Cloudflare Turnstile — which blocks automated browsers — is cleared by you
 * as a normal human in a normal browser. The headless scraper then reuses the
 * saved cookies to read dashboard data (data pages aren't Turnstile-gated).
 *
 * Steps:
 *   1. Close Chrome, then start it with remote debugging + a dedicated profile:
 *        "C:\Program Files\Google\Chrome\Application\chrome.exe" ^
 *          --remote-debugging-port=9222 ^
 *          --user-data-dir="C:\tsba-scrape-profile"
 *      (A `npm run portal-chrome` helper is provided to do this.)
 *   2. In that Chrome, log in to the portal normally (clear the Cloudflare check).
 *   3. Run:  npm run portal-capture solarman
 *      It connects to that Chrome, finds the portal tab, and saves its session.
 *
 * It never launches its own browser, so nothing is fingerprinted as automation.
 */
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { sessionPath, sessionStoragePath } from '../providers/scraper/session.js';

// Substring that identifies each portal's tab by URL.
const PORTAL_DOMAIN: Record<string, string> = {
  solarman: 'solarmanpv.com',
  solis: 'soliscloud.com',
  growatt: 'growatt.com',
  dyness: 'dyness',
  elekeeper: 'saj-electric.com',
  whes: 'ecos',
};

async function main() {
  const key = (process.argv[2] || '').toLowerCase();
  const endpoint = process.argv[3] || 'http://localhost:9222';
  const domain = PORTAL_DOMAIN[key];
  if (!key || !domain) {
    console.error('Usage: npm run portal-capture <key> [cdpEndpoint]   (keys: ' + Object.keys(PORTAL_DOMAIN).join(', ') + ')');
    process.exit(1);
  }

  let browser;
  try {
    browser = await chromium.connectOverCDP(endpoint);
  } catch (e) {
    console.error(`\n✗ Could not connect to Chrome at ${endpoint}.`);
    console.error('  Start Chrome with:  npm run portal-chrome   (then log in to the portal), and try again.');
    console.error('  Detail:', (e as Error).message);
    process.exit(1);
  }

  // Find the context + the specific logged-in tab for this portal (prefer a tab
  // that isn't on a /login page).
  const contexts = browser.contexts();
  let target = null as null | (typeof contexts)[number];
  let targetPage = null as null | Awaited<ReturnType<(typeof contexts)[number]['pages']>>[number];
  for (const ctx of contexts) {
    for (const p of ctx.pages()) {
      if (p.url().includes(domain)) {
        target = ctx;
        if (!/login|signin/i.test(p.url()) || !targetPage) targetPage = p;
      }
    }
  }
  if (!target) {
    console.error(`\n✗ No open Chrome tab found on "${domain}". Open the portal, log in, then re-run.`);
    await browser.close();
    process.exit(1);
  }

  await target.storageState({ path: sessionPath(key) });

  // Also capture localStorage + sessionStorage from the tab. storageState over
  // CDP often returns empty `origins` (no localStorage), and never captures
  // sessionStorage — some SPAs (SAJ) keep their auth token in these. We replay
  // them into the scrape context.
  if (targetPage) {
    try {
      const raw = await targetPage.evaluate(
        `JSON.stringify({ origin: location.origin, local: Object.assign({}, localStorage), session: Object.assign({}, sessionStorage) })`,
      );
      const parsed = JSON.parse(String(raw));
      const nLocal = Object.keys(parsed.local || {}).length;
      const nSess = Object.keys(parsed.session || {}).length;
      if (nLocal || nSess) {
        writeFileSync(sessionStoragePath(key), String(raw));
        console.log(`  (also saved ${nLocal} localStorage + ${nSess} sessionStorage items)`);
      }
    } catch {
      /* best-effort */
    }
  }
  console.log(`\n✓ Session captured for "${key}" → ${sessionPath(key)}`);
  console.log('✓ The headless scraper can now reuse this session (no Turnstile on data pages).');
  await browser.close();
  process.exit(0);
}

main().catch((e) => {
  console.error('portal-capture failed:', (e as Error).message);
  process.exit(1);
});
