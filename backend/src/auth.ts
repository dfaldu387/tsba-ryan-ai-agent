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
  /** Password fingerprint: tokens stop working once the password changes. */
  pv?: string;
}

function sign(payload: string): string {
  return createHmac('sha256', env.sessionSecret).update(payload).digest('base64url');
}

/** Short keyed fingerprint of the stored password hash (reveals nothing about it). */
export function passwordVersion(passwordHash: string): string {
  return createHmac('sha256', env.sessionSecret).update(`pv:${passwordHash}`).digest('base64url').slice(0, 16);
}

/** Issue a signed session token for a user. */
export function issueToken(user: { id: string; password_hash: string }): string {
  const payload = JSON.stringify({ uid: user.id, iat: Date.now(), pv: passwordVersion(user.password_hash) } satisfies TokenPayload);
  const body = Buffer.from(payload).toString('base64url');
  return `${body}.${sign(body)}`;
}

/** Verify signature + expiry; returns the payload or null. (Exported for tests.) */
export function verifyToken(token: string | undefined): TokenPayload | null {
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

/**
 * The browser session lives in an HttpOnly cookie: page JavaScript (and so any
 * injected script) can never read it, unlike a token in localStorage.
 * SameSite=Strict keeps other sites from sending it (CSRF), Secure keeps it off
 * plain HTTP in production, and Path=/api means it only travels with API calls.
 */
export const SESSION_COOKIE = 'tsba_session';

function cookieAttrs(maxAgeSec: number): string {
  return `Path=/api; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${env.isProd ? '; Secure' : ''}`;
}

/** Start (or refresh) this browser's session cookie for `user`. */
export function setSessionCookie(reply: FastifyReply, user: { id: string; password_hash: string }): void {
  reply.header('Set-Cookie', `${SESSION_COOKIE}=${issueToken(user)}; ${cookieAttrs(Math.floor(TOKEN_TTL_MS / 1000))}`);
}

/** End this browser's session. */
export function clearSessionCookie(reply: FastifyReply): void {
  reply.header('Set-Cookie', `${SESSION_COOKIE}=; ${cookieAttrs(0)}`);
}

function sessionCookie(req: FastifyRequest): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === SESSION_COOKIE) return part.slice(i + 1).trim() || undefined;
  }
  return undefined;
}

/** Session token: the HttpOnly cookie (browsers), or a Bearer header (scripts/API clients). */
function bearer(req: FastifyRequest): string | undefined {
  const header = req.headers.authorization ?? '';
  if (header.startsWith('Bearer ')) return header.slice(7);
  return sessionCookie(req);
}

/** Resolve the current user from the token, re-reading the live row each time
 *  so a disabled account or changed role takes effect immediately. */
export async function currentUser(req: FastifyRequest): Promise<AuthenticatedUser | null> {
  const payload = verifyToken(bearer(req));
  if (!payload) return null;
  const storage = await getStorage();
  const user = await storage.users.getById(payload.uid);
  if (!user || user.disabled) return null;
  // A password change (e.g. after a suspected leak) revokes every older token.
  // Tokens issued before this check existed carry no `pv` and run to expiry.
  if (payload.pv && payload.pv !== passwordVersion(user.password_hash)) return null;
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
