import { randomUUID } from 'node:crypto';
import type { Role } from '@tsba/shared';
import { query } from './db.js';
import type { NewUser, StoredUser, UserUpdate } from './stores/types.js';

// Postgres CRUD for the `users` table. Password hashes are stored as given
// (scrypt `salt:hash`) and never transformed here.

interface Row {
  id: string;
  email: string;
  name: string;
  role: Role;
  password_hash: string;
  disabled: boolean;
  created_at: string;
  last_login_at: string | null;
}

const COLS = 'id, email, name, role, password_hash, disabled, created_at, last_login_at';

function toUser(r: Row): StoredUser {
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    role: r.role,
    password_hash: r.password_hash,
    disabled: r.disabled,
    created_at: typeof r.created_at === 'string' ? r.created_at : new Date(r.created_at).toISOString(),
    last_login_at: r.last_login_at
      ? typeof r.last_login_at === 'string'
        ? r.last_login_at
        : new Date(r.last_login_at).toISOString()
      : null,
  };
}

export async function listUsers(): Promise<StoredUser[]> {
  const res = await query<Row>(`SELECT ${COLS} FROM users ORDER BY created_at ASC`);
  return res.rows.map(toUser);
}

export async function countUsers(): Promise<number> {
  const res = await query<{ count: string }>('SELECT count(*)::text AS count FROM users');
  return Number(res.rows[0]?.count ?? 0);
}

export async function getUserById(id: string): Promise<StoredUser | null> {
  const res = await query<Row>(`SELECT ${COLS} FROM users WHERE id = $1`, [id]);
  return res.rows[0] ? toUser(res.rows[0]) : null;
}

export async function getUserByEmail(email: string): Promise<StoredUser | null> {
  const res = await query<Row>(`SELECT ${COLS} FROM users WHERE lower(email) = lower($1)`, [email]);
  return res.rows[0] ? toUser(res.rows[0]) : null;
}

export async function createUser(user: NewUser): Promise<StoredUser> {
  const id = randomUUID();
  const res = await query<Row>(
    `INSERT INTO users (id, email, name, role, password_hash)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${COLS}`,
    [id, user.email, user.name, user.role, user.password_hash],
  );
  return toUser(res.rows[0]);
}

export async function updateUser(id: string, patch: UserUpdate): Promise<StoredUser | null> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  const add = (col: string, val: unknown) => {
    sets.push(`${col} = $${i++}`);
    vals.push(val);
  };
  if (patch.name !== undefined) add('name', patch.name);
  if (patch.role !== undefined) add('role', patch.role);
  if (patch.disabled !== undefined) add('disabled', patch.disabled);
  if (patch.password_hash !== undefined) add('password_hash', patch.password_hash);
  if (patch.last_login_at !== undefined) add('last_login_at', patch.last_login_at);
  if (!sets.length) return getUserById(id);

  vals.push(id);
  const res = await query<Row>(
    `UPDATE users SET ${sets.join(', ')} WHERE id = $${i} RETURNING ${COLS}`,
    vals,
  );
  return res.rows[0] ? toUser(res.rows[0]) : null;
}

export async function removeUser(id: string): Promise<StoredUser | null> {
  const res = await query<Row>(`DELETE FROM users WHERE id = $1 RETURNING ${COLS}`, [id]);
  return res.rows[0] ? toUser(res.rows[0]) : null;
}
