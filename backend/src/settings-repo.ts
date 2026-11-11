import { query } from './db.js';

/**
 * Postgres persistence for generic, admin-editable application settings. Each
 * key stores one JSON document in `app_settings`. Used for the solar alert
 * configuration; kept generic so other tunables can reuse it.
 */

export async function getSetting<T>(key: string): Promise<T | null> {
  const res = await query<{ value: T }>('SELECT value FROM app_settings WHERE key = $1', [key]);
  return res.rows[0]?.value ?? null;
}

export async function setSetting<T>(key: string, value: T): Promise<void> {
  await query(
    `INSERT INTO app_settings (key, value, updated_at)
       VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}
