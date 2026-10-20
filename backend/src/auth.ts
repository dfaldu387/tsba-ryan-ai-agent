import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { env } from './env.js';

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function sign(payload: string): string {
  return createHmac('sha256', env.sessionSecret).update(payload).digest('base64url');
}

/** Issue an opaque, signed session token after a correct password. */
export function issueToken(): string {
  const payload = `${Date.now()}`;
  return `${Buffer.from(payload).toString('base64url')}.${sign(payload)}`;
}

export function verifyToken(token: string | undefined): boolean {
  if (!token) return false;
  const [body, mac] = token.split('.');
  if (!body || !mac) return false;
  const payload = Buffer.from(body, 'base64url').toString('utf8');
  const expected = sign(payload);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  const iat = Number(payload);
  return Number.isFinite(iat) && Date.now() - iat < TOKEN_TTL_MS;
}

/** Constant-time password check. */
export function passwordMatches(candidate: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(env.appPassword);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Fastify preHandler: require a valid Bearer token. */
export function requireAuth(req: FastifyRequest, reply: FastifyReply, done: () => void): void {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : undefined;
  if (!verifyToken(token)) {
    reply.code(401).send({ error: 'unauthorized' });
    return;
  }
  done();
}
