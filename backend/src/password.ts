import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

// Password hashing with scrypt (built into Node — no bcrypt dependency).
// Stored form: `<saltHex>:<hashHex>`. Verification is constant-time.

const scrypt = promisify(scryptCb);
const KEYLEN = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scrypt(password, salt, KEYLEN)) as Buffer;
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const derived = (await scrypt(password, salt, expected.length || KEYLEN)) as Buffer;
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}
