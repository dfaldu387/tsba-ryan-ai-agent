import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { env } from './env.js';
import { registerRoutes } from './routes/index.js';
import { registerUsageRoutes } from './usage-page.js';
import { getStorage } from './storage.js';

const here = dirname(fileURLToPath(import.meta.url));
const frontendDist = resolve(here, '../../frontend/dist');

async function main(): Promise<void> {
  // 32MB body limit so the voice agent can attach images/PDFs (base64-inflated)
  // for the model to read. Individual attachments are also capped server-side.
  const app = Fastify({ logger: { level: env.isProd ? 'info' : 'warn' }, bodyLimit: 32_000_000 });

  // Dev: the Vite server runs on another origin and needs CORS.
  if (!env.isProd) {
    await app.register(cors, { origin: env.webOrigin });
  }

  await registerRoutes(app);
  // Hidden, token-gated token-usage report (/usage?key=…). Registered before the
  // SPA fallback so the standalone page isn't swallowed by the catch-all.
  await registerUsageRoutes(app);

  // Prod: serve the built SPA from the same origin so the password gate covers it.
  if (env.isProd && existsSync(frontendDist)) {
    await app.register(fastifyStatic, { root: frontendDist });
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url?.startsWith('/api/')) return reply.code(404).send({ error: 'not_found' });
      return reply.sendFile('index.html');
    });
  }

  // Prewarm the store so startup fails loudly (e.g. missing knowledge files)
  // and the first request is fast. In memory mode this loads + embeds the KB.
  await getStorage();

  // Seed the first admin account (from ADMIN_EMAIL / ADMIN_PASSWORD) if the
  // user table is empty, so the panel is never locked out on a fresh install.
  const { seedAdmin } = await import('./users.js');
  await seedAdmin();

  // Postgres mode only: start the durable background queue (embedding jobs).
  if (env.storage === 'postgres') {
    try {
      const { startQueue } = await import('./queue.js');
      await startQueue();
    } catch (err) {
      app.log.error({ err }, 'could not start pg-boss queue');
    }
  }

  // Persist periodic solar snapshots (station readings + fleet aggregate) so the
  // live-pass-through monitoring data becomes a durable time series.
  try {
    const { startSolarRecorder } = await import('./solar-recorder.js');
    startSolarRecorder();
  } catch (err) {
    app.log.error({ err }, 'could not start solar recorder');
  }

  await app.listen({ port: env.port, host: '0.0.0.0' });
  console.log(
    `TSBA preview API listening on http://localhost:${env.port}  (env: ${env.nodeEnv}, storage: ${env.storage})`,
  );

  // Warm the solar provider caches in the background so the first dashboard load
  // isn't a cold multi-scrape. Fire-and-forget; errors are non-fatal. Combined
  // with stale-while-revalidate, users then get instant last-good data.
  void (async () => {
    try {
      const { aggregateStations } = await import('./providers/index.js');
      await aggregateStations();
      console.log('Solar caches warmed.');
    } catch (err) {
      app.log.warn({ err }, 'solar cache warm failed (non-fatal)');
    }
  })();

  const shutdown = async () => {
    await app.close();
    // Tear down the shared headless Chromium so it (and its child processes)
    // aren't orphaned across restarts/deploys.
    const { closeBrowser } = await import('./providers/scraper/browser.js');
    await closeBrowser();
    if (env.storage === 'postgres') {
      const { stopQueue } = await import('./queue.js');
      const { closePool } = await import('./db.js');
      await stopQueue();
      await closePool();
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Keep the server alive through stray async failures. Headless Chromium /
// Playwright readily emit rejections out of band (a browser disconnect mid-op,
// a context closed while a waitForResponse is pending, a CDP protocol error).
// Without these handlers Node terminates the whole process on the first such
// rejection — i.e. one scrape hiccup takes the entire API down. Log and carry on.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
