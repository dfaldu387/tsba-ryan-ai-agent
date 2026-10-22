import {
  CONNECTION_LABELS,
  CONNECTION_PROVIDERS,
  CONNECTION_PURPOSE,
  type ConnectionProvider,
  type ConnectionStatus,
} from '@tsba/shared';
import { googleOAuthConfigured } from './env.js';
import { getStorage } from './storage.js';
import {
  decryptToken,
  encryptToken,
  refreshAccessToken,
  revokeToken,
  type GoogleTokens,
} from './google-oauth.js';
import type { StoredConnection } from './stores/types.js';

/** Public status for one connector (never carries tokens). */
function toStatus(provider: ConnectionProvider, conn: StoredConnection | null): ConnectionStatus {
  return {
    provider,
    label: CONNECTION_LABELS[provider],
    purpose: CONNECTION_PURPOSE[provider],
    configured: googleOAuthConfigured(),
    connected: Boolean(conn),
    account_email: conn?.account_email ?? null,
    scopes: conn?.scopes ?? [],
    connected_at: conn?.connected_at ?? null,
    expires_at: conn?.expires_at ?? null,
  };
}

/** Status of every connector, connected or not — drives the Connections UI. */
export async function connectionStatuses(): Promise<ConnectionStatus[]> {
  const storage = await getStorage();
  const rows = await storage.connections.list();
  const byProvider = new Map(rows.map((r) => [r.provider, r]));
  return CONNECTION_PROVIDERS.map((p) => toStatus(p, byProvider.get(p) ?? null));
}

/** Persist a freshly authorized connection from the OAuth callback. */
export async function saveConnection(
  provider: ConnectionProvider,
  tokens: GoogleTokens,
  accountEmail: string | null,
): Promise<void> {
  const storage = await getStorage();
  const now = new Date().toISOString();
  await storage.connections.upsert({
    provider,
    account_email: accountEmail,
    scopes: tokens.scope ? tokens.scope.split(' ') : [],
    access_token_enc: encryptToken(tokens.accessToken),
    refresh_token_enc: encryptToken(tokens.refreshToken ?? ''),
    expires_at: tokens.expiresAt,
    connected_at: now,
    updated_at: now,
  });
}

/**
 * Whether the Google Drive connection has write access (full 'drive' scope, not
 * just 'drive.readonly'). Drive OCR copies a file into a temp Doc, which needs
 * write; without it we skip the OCR fallback (Claude handles extraction).
 */
export async function driveHasWriteScope(): Promise<boolean> {
  const storage = await getStorage();
  const conn = await storage.connections.get('google-drive');
  return Boolean(conn?.scopes.includes('https://www.googleapis.com/auth/drive'));
}

/** Revoke upstream (best effort) and delete the local record. */
export async function disconnect(provider: ConnectionProvider): Promise<boolean> {
  const storage = await getStorage();
  const removed = await storage.connections.remove(provider);
  if (!removed) return false;
  const refresh = decryptToken(removed.refresh_token_enc);
  if (refresh) await revokeToken(refresh);
  return true;
}

/**
 * Return a valid (unexpired) access token for a connected provider, refreshing
 * and persisting a new one when the current token is within 60s of expiry.
 * Returns null when the provider isn't connected. Used by the Drive/Gmail
 * features built on top of these connectors.
 */
export async function getAccessToken(provider: ConnectionProvider): Promise<string | null> {
  const storage = await getStorage();
  const conn = await storage.connections.get(provider);
  if (!conn) return null;

  const expiresSoon = new Date(conn.expires_at).getTime() - Date.now() < 60_000;
  if (!expiresSoon) return decryptToken(conn.access_token_enc);

  const refresh = decryptToken(conn.refresh_token_enc);
  if (!refresh) return decryptToken(conn.access_token_enc); // no refresh token; return what we have
  const tokens = await refreshAccessToken(refresh);
  await storage.connections.upsert({
    ...conn,
    access_token_enc: encryptToken(tokens.accessToken),
    refresh_token_enc: encryptToken(tokens.refreshToken ?? refresh),
    expires_at: tokens.expiresAt,
    updated_at: new Date().toISOString(),
  });
  return tokens.accessToken;
}
