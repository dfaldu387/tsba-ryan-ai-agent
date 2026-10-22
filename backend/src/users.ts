import {
  permissionsForRole,
  type AuthenticatedUser,
  type Role,
  type User,
} from '@tsba/shared';
import { env } from './env.js';
import { getStorage } from './storage.js';
import { hashPassword, verifyPassword } from './password.js';
import type { StoredUser } from './stores/types.js';

// User service: seeding the first admin, credential checks, and shaping stored
// rows into the public (hash-free) types the API returns.

export function toPublicUser(u: StoredUser): User {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    disabled: u.disabled,
    created_at: u.created_at,
    last_login_at: u.last_login_at,
  };
}

export function toAuthenticatedUser(u: StoredUser): AuthenticatedUser {
  return { ...toPublicUser(u), permissions: permissionsForRole(u.role) };
}

/** Create the first admin from env if there are no users yet. Idempotent. */
export async function seedAdmin(): Promise<void> {
  const storage = await getStorage();
  const count = await storage.users.count();
  if (count > 0) return;

  const password_hash = await hashPassword(env.adminPassword);
  await storage.users.create({
    email: env.adminEmail,
    name: env.adminName,
    role: 'admin',
    password_hash,
  });
  console.log(`[users] seeded first admin: ${env.adminEmail}`);
}

/** Verify email + password; records last_login_at. Returns null on any failure. */
export async function authenticate(email: string, password: string): Promise<StoredUser | null> {
  const storage = await getStorage();
  const user = await storage.users.getByEmail(email.trim());
  if (!user || user.disabled) return null;
  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) return null;
  await storage.users.update(user.id, { last_login_at: new Date().toISOString() });
  return user;
}

export interface CreateUserInput {
  email: string;
  name: string;
  role: Role;
  password: string;
}

/** Create a user with a hashed password. Throws 'email_taken' on a duplicate. */
export async function createUserAccount(input: CreateUserInput): Promise<StoredUser> {
  const storage = await getStorage();
  const existing = await storage.users.getByEmail(input.email.trim());
  if (existing) throw new Error('email_taken');
  const password_hash = await hashPassword(input.password);
  return storage.users.create({
    email: input.email.trim(),
    name: input.name.trim(),
    role: input.role,
    password_hash,
  });
}
