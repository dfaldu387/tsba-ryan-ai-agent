/**
 * Launch the user's real Chrome with remote debugging on a DEDICATED profile, so
 * you can log in to a portal (clearing Cloudflare as a normal human) and then
 * `npm run portal-capture <key>` can read the session from it.
 *
 * A dedicated --user-data-dir is required: current Chrome ignores
 * --remote-debugging-port when run on your default profile.
 *
 *   npm run portal-chrome
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const PORT = process.env.PORTAL_CHROME_PORT || '9222';
const PROFILE = process.env.PORTAL_CHROME_PROFILE || resolve(process.cwd(), '.portal-chrome-profile');

// Best-known login URLs per portal. Unknown ones (dyness, whes) you navigate to
// manually in the opened window. Pass specific keys as args to open only those:
//   npm run portal-chrome solis growatt
const PORTAL_URLS: Record<string, string> = {
  solarman: 'https://globalpro.solarmanpv.com/login?dataBaseSelect=FOREIGN_1&dataBaseChild=OA',
  solis: 'https://www.soliscloud.com',
  growatt: 'https://server.growatt.com',
  elekeeper: 'https://elekeeper.saj-electric.com',
};
const requested = process.argv.slice(2).map((a) => a.toLowerCase());
const urls = requested.length
  ? requested.map((k) => PORTAL_URLS[k]).filter(Boolean)
  : Object.values(PORTAL_URLS);

const CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  resolve(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
  resolve(process.env.PROGRAMFILES || '', 'Google/Chrome/Application/chrome.exe'),
];

const chromePath = CANDIDATES.find((p) => p && existsSync(p));
if (!chromePath) {
  console.error('✗ Could not find chrome.exe. Set the path and launch it manually:');
  console.error(`    chrome.exe --remote-debugging-port=${PORT} --user-data-dir="${PROFILE}"`);
  process.exit(1);
}

console.log(`Launching Chrome (debug port ${PORT}, profile ${PROFILE})...`);
console.log('→ In this Chrome window: log in to the portal and clear the Cloudflare check.');
console.log('→ Then run:  npm run portal-capture solarman   (leave this Chrome open).\n');

const child = spawn(chromePath, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  '--no-first-run',
  '--no-default-browser-check',
  ...urls,
], { detached: true, stdio: 'ignore' });
child.unref();
console.log(`Opened ${urls.length} portal tab(s). Log in to each (clear any Cloudflare check).`);
console.log('For Dyness / WHES (ECOS Hub): open those portals manually in this same window.');
console.log('Then tell Claude, or run: npm run portal-capture <key>   for each.');
console.log('\nChrome launched. (This script can exit; Chrome stays open.)');
process.exit(0);
