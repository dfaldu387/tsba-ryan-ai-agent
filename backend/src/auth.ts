import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { hasPermission, type AuthenticatedUser, type Permission } from '@tsba/shared';
import { env } from './env.js';
import { getStorage } from './storage.js';
import { toAuthenticatedUser } from './users.js';

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// The authenticated user is attached to the request by `requireAuth`.
declare module 'fastify' {
  interface FastifyRequest {
    authUser?: AuthenticatedUser;
  }
}

interface TokenPayload {
  uid: string;
  iat: number;
}

function sign(payload: string): string {
  return createHmac('sha256', env.sessionSecret).update(payload).digest('base64url');
}

/** Issue a signed session token for a user id. */
export function issueToken(userId: string): string {
  const payload = JSON.stringify({ uid: userId, iat: Date.now() } satisfies TokenPayload);
  const body = Buffer.from(payload).toString('base64url');
  return `${body}.${sign(body)}`;
}

/** Verify signature + expiry; returns the payload or null. */
function verifyToken(token: string | undefined): TokenPayload | null {
  if (!token) return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expected = sign(body);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenPayload;
    if (!payload.uid || !Number.isFinite(payload.iat)) return null;
    if (Date.now() - payload.iat >= TOKEN_TTL_MS) return null;
    return payload;
  } catch {
    return null;
  }
}

function bearer(req: FastifyRequest): string | undefined {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice(7) : undefined;
}

/** Resolve the current user from the token, re-reading the live row each time
 *  so a disabled account or changed role takes effect immediately. */
export async function currentUser(req: FastifyRequest): Promise<AuthenticatedUser | null> {
  const payload = verifyToken(bearer(req));
  if (!payload) return null;
  const storage = await getStorage();
  const user = await storage.users.getById(payload.uid);
  if (!user || user.disabled) return null;
  return toAuthenticatedUser(user);
}

/** preHandler: require a signed-in, enabled user. Attaches `req.authUser`. */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const user = await currentUser(req);
  if (!user) {
    reply.code(401).send({ error: 'unauthorized' });
    return;
  }
  req.authUser = user;
}

/** preHandler factory: require auth AND a specific permission. */
export function requirePermission(permission: Permission) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const user = await currentUser(req);
    if (!user) {
      reply.code(401).send({ error: 'unauthorized' });
      return;
    }
    if (!hasPermission(user.role, permission)) {
      reply.code(403).send({ error: 'forbidden', message: `Requires permission: ${permission}` });
      return;
    }
    req.authUser = user;
  };
}
