import type { ConnectionProvider } from '@tsba/shared';
import { query } from './db.js';
import type { StoredConnection } from './stores/types.js';

interface ConnectionRow {
  provider: ConnectionProvider;
  account_email: string | null;
  scopes: string[];
  access_token_enc: string;
  refresh_token_enc: string;
  expires_at: Date;
  connected_at: Date;
  updated_at: Date;
}

const SELECT =
  'provider, account_email, scopes, access_token_enc, refresh_token_enc, expires_at, connected_at, updated_at';

function toConnection(r: ConnectionRow): StoredConnection {
  return {
    provider: r.provider,
    account_email: r.account_email,
    scopes: r.scopes ?? [],
    access_token_enc: r.access_token_enc,
    refresh_token_enc: r.refresh_token_enc,
    expires_at: r.expires_at.toISOString(),
    connected_at: r.connected_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
  };
}

export async function getConnection(provider: ConnectionProvider): Promise<StoredConnection | null> {
  const res = await query<ConnectionRow>(`SELECT ${SELECT} FROM connections WHERE provider = $1`, [provider]);
  return res.rows[0] ? toConnection(res.rows[0]) : null;
}

export async function listConnections(): Promise<StoredConnection[]> {
  const res = await query<ConnectionRow>(`SELECT ${SELECT} FROM connections ORDER BY provider ASC`);
  return res.rows.map(toConnection);
}

export async function upsertConnection(conn: StoredConnection): Promise<StoredConnection> {
  const res = await query<ConnectionRow>(
    `INSERT INTO connections
       (provider, account_email, scopes, access_token_enc, refresh_token_enc, expires_at, connected_at, updated_at)
     VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8)
     ON CONFLICT (provider) DO UPDATE SET
       account_email     = EXCLUDED.account_email,
       scopes            = EXCLUDED.scopes,
       access_token_enc  = EXCLUDED.access_token_enc,
       refresh_token_enc = EXCLUDED.refresh_token_enc,
       expires_at        = EXCLUDED.expires_at,
       updated_at        = EXCLUDED.updated_at
     RETURNING ${SELECT}`,
    [
      conn.provider,
      conn.account_email,
      JSON.stringify(conn.scopes),
      conn.access_token_enc,
      conn.refresh_token_enc,
      conn.expires_at,
      conn.connected_at,
      conn.updated_at,
    ],
  );
  return toConnection(res.rows[0]);
}

export async function removeConnection(provider: ConnectionProvider): Promise<StoredConnection | null> {
  const res = await query<ConnectionRow>(`DELETE FROM connections WHERE provider = $1 RETURNING ${SELECT}`, [
    provider,
  ]);
  return res.rows[0] ? toConnection(res.rows[0]) : null;
}
