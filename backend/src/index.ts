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
  // 2MB default body limit (public routes like /api/login must not buffer huge
  // bodies); the voice agent route raises its own limit for image/PDF attachments.
  // trustProxy: loopback only — nginx sits in front in production, so req.ip is
  // the real client (needed for login rate limiting) without trusting spoofed
  // X-Forwarded-For from direct connections.
  // Request logs never carry secrets: the query string is dropped from logged
  // URLs (it can hold the usage key, an OAuth code/state, search text) and the
  // auth/cookie/Twilio-signature headers are redacted if a log ever includes them.
  const app = Fastify({
    logger: {
      level: env.isProd ? 'info' : 'warn',
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-twilio-signature"]', 'res.headers["set-cookie"]'],
        censor: '[redacted]',
      },
      serializers: {
        req: (req: { method: string; url: string; ip?: string }) => ({
          method: req.method,
          url: (req.url ?? '').split('?')[0],
          remoteAddress: req.ip,
        }),
      },
    },
    bodyLimit: 2_000_000,
    trustProxy: '127.0.0.1',
  });

  // Unhandled errors: Fastify's default reply includes err.message, which for a
  // 500 can be SQL, a hostname or a stack detail. Log it in full; send clients a
  // plain message. 4xx errors (bad JSON, body too large…) keep their message.
  app.setErrorHandler((error, req, reply) => {
    const err = error as { statusCode?: number; code?: string; message?: string };
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) {
      req.log.error({ err }, 'unhandled error');
      return reply.code(status).send({ error: 'server_error', message: 'Something went wrong on our side. Try again in a moment.' });
    }
    return reply.code(status).send({ error: err.code ?? 'bad_request', message: err.message });
  });

  // Content-Security-Policy for the SPA: scripts only from our own origin (no
  // inline or injected <script>, no eval), so even an HTML-injection bug can't
  // run attacker code. Third parties are limited to exactly what the app uses:
  // Google Fonts, the Esri/OSM map tiles and the globe texture on unpkg.
  // Inline styles stay allowed — React style={} and Leaflet set them, and CSS
  // can't run code. (Routes with their own page, e.g. /usage, set their own.)
  const SPA_CSP = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob: https://server.arcgisonline.com https://tile.openstreetmap.org https://unpkg.com",
    "connect-src 'self' https://unpkg.com",
    "media-src 'self' blob: data:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(env.isProd ? ['upgrade-insecure-requests'] : []),
  ].join('; ');

  // Baseline security headers on every response.
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    if (!reply.hasHeader('Content-Security-Policy')) {
      const type = String(reply.getHeader('Content-Type') ?? '');
      // JSON/API responses must never render as a page at all.
      reply.header('Content-Security-Policy', type.includes('text/html') ? SPA_CSP : "default-src 'none'; frame-ancestors 'none'");
    }
    // HTTPS only from here on: browsers refuse a downgrade to plain HTTP.
    if (env.isProd) reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    // API responses carry customer/fleet data and tokens: never store them in
    // the browser cache or any proxy in between.
    if (req.url.startsWith('/api/')) {
      reply.header('Cache-Control', 'no-store');
      reply.header('Pragma', 'no-cache');
    }
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('Permissions-Policy', 'camera=(), geolocation=(), microphone=(self)');
    return payload;
  });

  // Dev: the Vite server runs on another origin and needs CORS.
  if (!env.isProd) {
    await app.register(cors, { origin: env.webOrigin });
  }

  await registerRoutes(app);
  // Sales follow-up agent (needs Postgres for its tables).
  if (env.storage === 'postgres') {
    const { registerKeepwarmRoutes } = await import('./keepwarm/routes.js');
    await registerKeepwarmRoutes(app);
  }
  // Hidden, token-gated token-usage report (/usage?key=…). Registered before the
  // SPA fallback so the standalone page isn't swallowed by the catch-all.
  await registerUsageRoutes(app);

  // Serve the built SPA from the same origin whenever a build exists, so the app
  // (and its client-side routes) work on the backend port — not just in prod. In
  // dev the Vite server on :5173 is still the live/HMR origin; this makes the
  // canonical :8080 URL (which the password gate and OAuth redirect use) serve the
  // app too, with an index.html fallback so deep links / refreshes don't 404.
  // (If there's no build yet, run `npm run build` in frontend/, or use :5173.)
  if (existsSync(frontendDist)) {
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

  // Email alerts when a plant/inverter goes offline or a fault is reported.
  try {
    const { startSolarAlertMonitor } = await import('./solar-alert-monitor.js');
    startSolarAlertMonitor();
  } catch (err) {
    app.log.error({ err }, 'could not start solar alert monitor');
  }

  // Sales follow-up agent: morning drafts + sending approved texts on time.
  if (env.storage === 'postgres') {
    try {
      const { startKeepwarm } = await import('./keepwarm/service.js');
      startKeepwarm();
    } catch (err) {
      app.log.error({ err }, 'could not start sales follow-up loop');
    }
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

  // Prime the heavier fleet ALERT scan (plant + device health = one detail call
  // per plant) only AFTER a short delay, so it doesn't compete with users' first
  // monitoring-page loads for the same provider rate limits / scraper contexts.
  // This keeps the page fast after a restart while still warming the alerts cache.
  setTimeout(() => {
    void (async () => {
      try {
        const { getSolarAlerts } = await import('./solar-alerts.js');
        const primed = await getSolarAlerts().catch((err) => {
          app.log.warn({ err }, 'solar alert prime failed (non-fatal)');
          return null;
        });
        if (primed) console.log(`Solar alert scan primed (${primed.alerts.length} alerts, ${primed.scannedPlants} plants).`);
      } catch (err) {
        app.log.warn({ err }, 'deferred alert prime failed (non-fatal)');
      }
    })();
  }, 20_000).unref?.();

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return; // SIGINT + SIGTERM together must not run this twice
    shuttingDown = true;
    // Hard stop if a step hangs (a wedged browser, a slow DB) — PM2 would SIGKILL anyway.
    setTimeout(() => process.exit(1), 10_000).unref();
    try {
      // Stop background loops first so nothing new starts mid-shutdown.
      const { stopSolarAlertMonitor } = await import('./solar-alert-monitor.js');
      stopSolarAlertMonitor();
      const { stopSolarRecorder } = await import('./solar-recorder.js');
      stopSolarRecorder();
      if (env.storage === 'postgres') {
        const { stopKeepwarm } = await import('./keepwarm/service.js');
        stopKeepwarm();
      }
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
    } catch (err) {
      console.error('[shutdown]', err);
    } finally {
      process.exit(0);
    }
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
