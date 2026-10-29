import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import type { ConnectionProvider } from '@tsba/shared';
import { env } from './env.js';

// ─── OAuth 2.0 for Google (Drive + Gmail), with no SDK ───────────────────────
// Just the three endpoints we need over global fetch. Drive is read-only (a
// knowledge source); Gmail gets read + send so the email channel can later
// receive questions and send approved replies. `openid email profile` lets us
// show which account was connected.

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';

const BASE_SCOPES = ['openid', 'email', 'profile'];

export const PROVIDER_SCOPES: Record<ConnectionProvider, string[]> = {
  // Full Drive scope (read + write) is needed so we can OCR image-only PDFs:
  // Drive OCRs a PDF by copying it into a Google Doc, which requires write access.
  // We only ever create a temporary OCR doc and delete it again.
  'google-drive': ['https://www.googleapis.com/auth/drive'],
  gmail: [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.send',
  ],
};

export function scopesFor(provider: ConnectionProvider): string[] {
  return [...BASE_SCOPES, ...PROVIDER_SCOPES[provider]];
}

// ─── Single-use CSRF state (transient; in-process is fine even for postgres) ──
interface PendingState {
  provider: ConnectionProvider;
  expiresAt: number;
}
const pendingStates = new Map<string, PendingState>();
const STATE_TTL_MS = 10 * 60 * 1000;

export function createState(provider: ConnectionProvider): string {
  const state = randomUUID();
  pendingStates.set(state, { provider, expiresAt: Date.now() + STATE_TTL_MS });
  return state;
}

/** Consume a state exactly once; returns its provider or null if invalid/expired. */
export function consumeState(state: string | undefined): ConnectionProvider | null {
  if (!state) return null;
  const entry = pendingStates.get(state);
  pendingStates.delete(state);
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry.provider;
}

export function buildAuthUrl(provider: ConnectionProvider, state: string): string {
  const params = new URLSearchParams({
    client_id: env.googleClientId,
    redirect_uri: env.googleRedirectUri,
    response_type: 'code',
    scope: scopesFor(provider).join(' '),
    state,
    access_type: 'offline', // ask for a refresh token
    prompt: 'consent', // force the consent screen so a refresh token is always returned
    include_granted_scopes: 'true',
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

export interface GoogleTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string; // ISO
  scope: string;
}

/**
 * A token request failed. `needsReauth` is set when Google rejected the refresh
 * token itself (`invalid_grant`: expired/revoked) — auto-refresh can't recover
 * from this and the user must reconnect (re-consent) the provider.
 */
export class GoogleTokenError extends Error {
  readonly needsReauth: boolean;
  constructor(message: string, needsReauth: boolean) {
    super(message);
    this.name = 'GoogleTokenError';
    this.needsReauth = needsReauth;
  }
}

function tokensFromResponse(data: Record<string, unknown>): GoogleTokens {
  const expiresInSec = Number(data.expires_in ?? 3600);
  return {
    accessToken: String(data.access_token ?? ''),
    refreshToken: data.refresh_token ? String(data.refresh_token) : null,
    expiresAt: new Date(Date.now() + expiresInSec * 1000).toISOString(),
    scope: String(data.scope ?? ''),
  };
}

export async function exchangeCode(code: string): Promise<GoogleTokens> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.googleClientId,
      client_secret: env.googleClientSecret,
      redirect_uri: env.googleRedirectUri,
      grant_type: 'authorization_code',
    }),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(`token exchange failed: ${data.error_description ?? data.error ?? res.status}`);
  return tokensFromResponse(data);
}

export async function refreshAccessToken(refreshToken: string): Promise<GoogleTokens> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: env.googleClientId,
      client_secret: env.googleClientSecret,
      grant_type: 'refresh_token',
    }),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const code = String(data.error ?? '');
    // `invalid_grant` means the refresh token is expired/revoked — unrecoverable
    // without a fresh consent. Flag it so callers can prompt a reconnect.
    const needsReauth = code === 'invalid_grant';
    throw new GoogleTokenError(
      `token refresh failed: ${data.error_description ?? data.error ?? res.status}`,
      needsReauth,
    );
  }
  const tokens = tokensFromResponse(data);
  // A refresh response usually omits refresh_token — keep the one we have.
  if (!tokens.refreshToken) tokens.refreshToken = refreshToken;
  return tokens;
}

export async function fetchUserEmail(accessToken: string): Promise<string | null> {
  const res = await fetch(USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return data.email ? String(data.email) : null;
}

/** Best-effort token revocation on disconnect; failure is non-fatal. */
export async function revokeToken(token: string): Promise<void> {
  try {
    await fetch(`${REVOKE_ENDPOINT}?token=${encodeURIComponent(token)}`, { method: 'POST' });
  } catch {
    /* already invalid or network issue — we delete our copy regardless */
  }
}

// ─── Token encryption at rest (AES-256-GCM, key derived from SESSION_SECRET) ──
const KEY = createHash('sha256').update(env.sessionSecret).digest(); // 32 bytes

export function encryptToken(plain: string): string {
  if (!plain) return '';
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

export function decryptToken(payload: string): string {
  if (!payload) return '';
  const [ivB64, tagB64, dataB64] = payload.split(':');
  if (!ivB64 || !tagB64 || !dataB64) return '';
  const decipher = createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}
