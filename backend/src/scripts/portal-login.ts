/**
 * One-time interactive portal login — seeds a saved session the headless scraper
 * reuses. Run per portal:
 *
 *   npm run portal-login solarman
 *
 * A real browser window opens with your credentials pre-filled. Clear any
 * "verify you are human" (Cloudflare) check and sign in; once you reach the
 * dashboard the session is saved to backend/.portal-sessions/<key>.json and the
 * window closes. Re-run whenever a session expires.
 *
 * Credentials come from the login file / env (never printed).
 */
import { chromium, type Page } from 'playwright';
import { portalCreds, type PortalCreds } from '../providers/scraper/credentials.js';
import { sessionPath } from '../providers/scraper/session.js';

interface PortalLogin {
  loginUrl: string;
  prefill?: (page: Page, creds: PortalCreds) => Promise<void>;
  /** True once we've left the login screen (signed in). */
  successWhen: (page: Page) => boolean;
}

const PORTALS: Record<string, PortalLogin> = {
  solarman: {
    // Oceania regional portal — skips the region picker.
    loginUrl: 'https://globalpro.solarmanpv.com/login?dataBaseSelect=FOREIGN_1&dataBaseChild=OA',
    async prefill(page, creds) {
      for (const name of ['Accept all', 'Only necessary']) {
        await page.getByRole('button', { name }).click({ timeout: 2500 }).catch(() => {});
      }
      await page.getByRole('button', { name: /^i agree$/i }).click({ timeout: 4000 }).catch(() => {});
      await page.locator('input[name="account"]:visible').first().fill(creds.username).catch(() => {});
      await page.locator('input[name="password"]:visible').first().fill(creds.password).catch(() => {});
    },
    successWhen: (page) => !/\/login/.test(page.url()),
  },
  // Other portals: pass the login URL as the 2nd arg until a tailored entry is added.
  // e.g. npm run portal-login solis https://www.soliscloud.com
};

async function main() {
  const key = (process.argv[2] || '').toLowerCase();
  const urlOverride = process.argv[3];
  if (!key) {
    console.error('Usage: npm run portal-login <key> [loginUrl]   (keys: solarman, solis, growatt, dyness, elekeeper, whes)');
    process.exit(1);
  }
  const creds = portalCreds(key);
  if (!creds) {
    console.error(`No credentials found for "${key}". Add a section to the login file or set SCRAPER_${key.toUpperCase()}_USER/PASS.`);
    process.exit(1);
  }
  const cfg = PORTALS[key] ?? {
    loginUrl: urlOverride || '',
    successWhen: (page: Page) => !/login|signin/i.test(page.url()),
  };
  if (!cfg.loginUrl) {
    console.error(`No login URL known for "${key}". Pass it: npm run portal-login ${key} <loginUrl>`);
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'] });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'en-AU',
    timezoneId: 'Australia/Brisbane',
  });
  const page = await ctx.newPage();
  await page.goto(cfg.loginUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  if (cfg.prefill) await cfg.prefill(page, creds).catch(() => {});

  console.log(`\n>>> A browser window opened for "${key}".`);
  console.log('>>> Complete any "verify you are human" check and sign in.');
  console.log('>>> This will save your session automatically once you reach the dashboard (waiting up to 5 min)...\n');

  const deadline = Date.now() + 5 * 60_000;
  let ok = false;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1500);
    try {
      if (cfg.successWhen(page)) { ok = true; break; }
    } catch { /* page navigating */ }
  }

  if (!ok) {
    console.error('\n✗ Timed out waiting for sign-in. Nothing saved. Re-run and complete the login faster.');
    await browser.close();
    process.exit(1);
  }

  await page.waitForTimeout(2500); // let post-login redirects settle
  await ctx.storageState({ path: sessionPath(key) });
  console.log(`\n✓ Session saved for "${key}". Landed on: ${page.url()}`);
  console.log('✓ The headless scraper can now reuse this session.');
  await browser.close();
  process.exit(0);
}

main().catch((e) => {
  console.error('portal-login failed:', (e as Error).message);
  process.exit(1);
});
