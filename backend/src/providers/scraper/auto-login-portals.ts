import type { Page } from 'playwright';
import type { PortalCreds } from './credentials.js';

/**
 * Per-portal headless auto-login routines. When the scraper has no saved session
 * (or finds it stale), it drives one of these to sign in with the `.env`
 * credentials and save a fresh session — no human needed, PROVIDED the portal
 * doesn't throw a bot challenge (Cloudflare Turnstile etc.) at the login page.
 * Portals that DO challenge (e.g. Solarman) are intentionally left out here and
 * still rely on the one-time `npm run portal-login` human capture.
 */
export interface AutoLoginConfig {
  loginUrl: string;
  /** Fill the form and submit. Should not throw on a missing optional step. */
  login: (page: Page, creds: PortalCreds) => Promise<void>;
  /** True once we've left the login screen (signed in). */
  successWhen: (page: Page) => boolean;
}

/** Dismiss common cookie / consent banners that sit over the form. */
async function dismissBanners(page: Page): Promise<void> {
  for (const name of [/accept all/i, /^accept$/i, /only necessary/i, /^i agree$/i, /^agree$/i, /^ok$/i, /got it/i]) {
    await page.getByRole('button', { name }).first().click({ timeout: 1500 }).catch(() => {});
  }
}

/**
 * Generic fill-and-submit for a standard username/password form. Tries a series
 * of selectors so it tolerates small markup differences between portals.
 */
async function genericLogin(page: Page, creds: PortalCreds): Promise<void> {
  await dismissBanners(page);

  const userSelectors = [
    'input[name="account"]',
    'input[name="username"]',
    'input[name="email"]',
    'input[type="email"]',
    'input[placeholder*="ccount" i]',
    'input[placeholder*="ser" i]',
    'input[placeholder*="mail" i]',
    'input[type="text"]',
  ];
  for (const sel of userSelectors) {
    const loc = page.locator(`${sel}:visible`).first();
    if (await loc.count().catch(() => 0)) {
      await loc.fill(creds.username).catch(() => {});
      break;
    }
  }

  const passLoc = page.locator('input[type="password"]:visible').first();
  await passLoc.fill(creds.password).catch(() => {});

  // Submit: a login/sign-in button if present, else Enter in the password field.
  const btn = page
    .getByRole('button', { name: /log\s*in|sign\s*in|登录|login/i })
    .first();
  if (await btn.count().catch(() => 0)) {
    await btn.click({ timeout: 4000 }).catch(() => {});
  } else {
    await passLoc.press('Enter').catch(() => {});
  }
}

export const AUTO_LOGIN: Record<string, AutoLoginConfig> = {
  // Dyness "Smart Energy Storage Cloud Platform" (APAC). A Vue SPA login form:
  // the markup only appears after the JS hydrates, there's a cookie "Accept"
  // banner, and a "I have read and agree …" consent checkbox must be ticked
  // before the Login button will submit. No bot challenge observed.
  dyness: {
    loginUrl: 'https://apacems.dyness.com/login',
    async login(page, creds) {
      // The form is an Arco-Design Vue SPA; wait for it to render.
      await page.waitForSelector('input[type="password"]', { timeout: 20_000 }).catch(() => {});

      // A cookie-consent overlay covers the form and swallows clicks until
      // dismissed — accept it and wait for it to detach.
      await page
        .locator('.cookie-consent-layer .arco-btn', { hasText: /accept/i })
        .first()
        .click({ timeout: 4000 })
        .catch(() => {});
      await page.waitForSelector('.cookie-consent-layer', { state: 'detached', timeout: 5000 }).catch(() => {});

      await page
        .locator('input[placeholder*="email" i]:visible, input[type="text"]:visible')
        .first()
        .fill(creds.username)
        .catch(() => {});
      await page.locator('input[type="password"]:visible').first().fill(creds.password).catch(() => {});

      // Required "I have read and agree …" consent. The Arco checkbox only
      // toggles via its icon-hover hit area (the wrapper/label clicks are inert).
      await page.locator('.arco-checkbox-icon-hover').first().click({ timeout: 3000 }).catch(() => {});

      await page.getByRole('button', { name: /^login$/i }).first().click({ timeout: 5000 }).catch(() => {});
    },
    successWhen: (page) => !/\/login/i.test(page.url()),
  },

  // SolisCloud (Ginlong) — Element-Plus form on the "Account" tab. No cookie
  // overlay or captcha by default; a "I have read and agree …" checkbox must be
  // ticked. Signed in once the URL leaves /login (→ /overview/...).
  solis: {
    loginUrl: 'https://www.soliscloud.com/login',
    async login(page, creds) {
      await page.waitForSelector('input[type="password"]', { timeout: 20_000 }).catch(() => {});

      await page
        .locator('input[placeholder*="sername" i]:visible, input[placeholder*="mail" i]:visible')
        .first()
        .fill(creds.username)
        .catch(() => {});
      await page.locator('input[type="password"]:visible').first().fill(creds.password).catch(() => {});

      // Required consent checkbox (Element-Plus — click the visible inner box).
      await page.locator('.el-checkbox__inner:visible').first().click({ timeout: 3000 }).catch(() => {});

      // Orange primary "Login" button.
      const primary = page.locator('.el-button--primary:visible', { hasText: /login/i }).first();
      if (await primary.count().catch(() => 0)) {
        await primary.click({ timeout: 5000 }).catch(() => {});
      } else {
        await page.getByRole('button', { name: /^login$/i }).first().click({ timeout: 5000 }).catch(() => {});
      }
    },
    successWhen: (page) => !/\/login/i.test(page.url()),
  },

  // SAJ / Elekeeper (eSolar) — Ant-Design form at iop.saj-electric.com, hash
  // routed. Node selector defaults to "International Node" (correct for AU). A
  // cookie "I Accept" banner, an optional "Remember Account" checkbox (ticked so
  // the token persists to localStorage, which the sidecar captures), no required
  // consent tick and no captcha. Signed in once the URL leaves #/login.
  elekeeper: {
    loginUrl: 'https://iop.saj-electric.com/#/login',
    async login(page, creds) {
      await page.waitForSelector('input[type="password"]', { timeout: 20_000 }).catch(() => {});

      // Cookie banner.
      await page.getByRole('button', { name: /^i accept$/i }).first().click({ timeout: 3000 }).catch(() => {});

      await page.locator('input[type="text"]:visible').first().fill(creds.username).catch(() => {});
      await page.locator('input[type="password"]:visible').first().fill(creds.password).catch(() => {});

      // "Remember Account" — persists the auth token to localStorage.
      await page.getByText('Remember Account', { exact: false }).first().click({ timeout: 2500 }).catch(() => {});

      // Teal "Login" button.
      const byRole = page.getByRole('button', { name: /^login$/i }).first();
      if (await byRole.count().catch(() => 0)) {
        await byRole.click({ timeout: 5000 }).catch(() => {});
      } else {
        await page.getByText('Login', { exact: true }).first().click({ timeout: 5000 }).catch(() => {});
      }
    },
    successWhen: (page) => !/\/login/i.test(page.url()),
  },

  // WHES / ECOS Hub (eCactus / WeiHeng) is intentionally NOT auto-logged-in.
  // A headless login succeeds (AU data-center + consent, auth returns 200) but
  // the resulting session only persists HUB_refreshToken — never the access
  // token or the loaded menu/permissions. Its route guard then bounces
  // #/device-list to #/role and the device-list API never fires, so the scrape
  // silently returns 0 plants WITHOUT redirecting to /login (so it wouldn't even
  // trip SessionExpiredError). The working human-captured session replays that
  // full auth state from its sidecar. WHES therefore stays on the one-time
  // `npm run portal-login whes` capture until this is cracked.
};

// genericLogin is kept for portals that don't need special handling yet.
void genericLogin;
