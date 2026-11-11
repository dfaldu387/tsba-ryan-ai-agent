import { getSolarAlerts } from './src/solar-alerts.js';
import { closePool } from './src/db.js';
async function main(){
  try {
    const r = await getSolarAlerts();
    console.log('OK alerts=%d scanned=%d errors=%j', r.alerts.length, r.scannedPlants, r.errors);
  } catch (e) {
    console.log('THREW:', (e as Error).message);
    console.log((e as Error).stack);
  }
  await closePool();
}
main();
