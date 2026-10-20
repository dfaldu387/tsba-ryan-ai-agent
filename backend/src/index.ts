import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { env } from './env.js';
import { registerRoutes } from './routes/index.js';
import { getStorage } from './storage.js';

const here = dirname(fileURLToPath(import.meta.url));
const frontendDist = resolve(here, '../../frontend/dist');

async function main(): Promise<void> {
  const app = Fastify({ logger: { level: env.isProd ? 'info' : 'warn' }, bodyLimit: 1_000_000 });

  // Dev: the Vite server runs on another origin and needs CORS.
  if (!env.isProd) {
    await app.register(cors, { origin: env.webOrigin });
  }

  await registerRoutes(app);

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

  // Postgres mode only: start the durable background queue (embedding jobs).
  if (env.storage === 'postgres') {
    try {
      const { startQueue } = await import('./queue.js');
      await startQueue();
    } catch (err) {
      app.log.error({ err }, 'could not start pg-boss queue');
    }
  }

  await app.listen({ port: env.port, host: '0.0.0.0' });
  console.log(
    `TSBA preview API listening on http://localhost:${env.port}  (env: ${env.nodeEnv}, storage: ${env.storage})`,
  );

  const shutdown = async () => {
    await app.close();
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

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
