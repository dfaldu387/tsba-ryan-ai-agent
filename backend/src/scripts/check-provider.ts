import { getProvider, PROVIDERS } from '../providers/index.js';

/**
 * Quick live check of one solar provider: logs in, lists stations, and pulls one
 * station's detail — printing what came back (or the exact error). Does NOT touch
 * the running server. Usage:
 *
 *   npm run check-provider solarman
 *   npm run check-provider elekeeper
 */
async function main(): Promise<void> {
  const id = (process.argv[2] || '').toLowerCase();
  if (!id) {
    console.error(`Usage: npm run check-provider <id>\n  ids: ${PROVIDERS.map((p) => p.id).join(', ')}`);
    process.exit(1);
  }
  const provider = getProvider(id);
  if (!provider) {
    console.error(`Unknown provider "${id}". Known: ${PROVIDERS.map((p) => p.id).join(', ')}`);
    process.exit(1);
  }

  console.log(`\n== ${provider.name} (${provider.id}) ==`);
  console.log('configured():', provider.configured());
  if (!provider.configured()) {
    console.error('→ Not configured. Set its credentials in .env and re-run.');
    process.exit(1);
  }

  const t0 = Date.now();
  let stations;
  try {
    stations = await provider.listStations();
  } catch (err) {
    console.error(`\n✗ listStations FAILED in ${((Date.now() - t0) / 1000).toFixed(1)}s:`);
    console.error('  ', (err as Error).message);
    process.exit(1);
  }
  console.log(`\n✓ listStations: ${stations.length} plants in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  for (const s of stations.slice(0, 8)) {
    console.log(`   ${s.id}  ${s.name}  status=${s.status}  ${s.capacityKw ?? '?'}kWp  power=${s.currentPowerW ?? '-'}W  owner=${s.owner ?? '-'}`);
  }
  if (stations.length > 8) console.log(`   … and ${stations.length - 8} more`);

  // Detail for the first (prefer an offline one to exercise device/alarm paths).
  const target = stations.find((s) => s.status === 'offline') ?? stations[0];
  if (target) {
    const t1 = Date.now();
    try {
      const d = await provider.stationDetail(target.id);
      console.log(`\n✓ stationDetail("${target.name}") in ${((Date.now() - t1) / 1000).toFixed(1)}s: ${d.info.length} info, ${d.devices.length} devices, ${d.alerts.length} alarms`);
      for (const i of d.info.slice(0, 12)) console.log(`     ${i.label}: ${i.value}`);
      for (const dev of d.devices.slice(0, 6)) console.log(`     device ${dev.sn} ${dev.type ?? ''} online=${dev.online}`);
      for (const a of d.alerts.slice(0, 6)) console.log(`     ALARM ${a.name} ${a.code ?? ''} ${a.deviceSn ?? ''}`);
    } catch (err) {
      console.error(`\n✗ stationDetail FAILED: ${(err as Error).message}`);
    }
  }

  // Tear down any shared resources so the process exits promptly.
  try {
    const { closeBrowser } = await import('../providers/scraper/browser.js');
    await closeBrowser();
  } catch {
    /* no browser in use */
  }
  try {
    const { closePool } = await import('../db.js');
    await closePool();
  } catch {
    /* no db */
  }
  console.log('\nDone.');
  process.exit(0);
}

main().catch((err) => {
  console.error('check-provider failed:', (err as Error).message);
  process.exit(1);
});
