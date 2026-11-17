import { describe, expect, it } from 'vitest';
import { issueToken, passwordVersion, verifyToken } from '../auth.js';

describe('session tokens', () => {
  const user = { id: 'u1', password_hash: 'salt:hash-1' };

  it('verifies a freshly issued token and carries the password fingerprint', () => {
    const p = verifyToken(issueToken(user));
    expect(p?.uid).toBe('u1');
    expect(p?.pv).toBe(passwordVersion(user.password_hash));
  });

  it('rejects tampered or missing tokens', () => {
    const [body, mac] = issueToken(user).split('.');
    const forged = Buffer.from(JSON.stringify({ uid: 'admin', iat: Date.now() })).toString('base64url');
    expect(verifyToken(`${forged}.${mac}`)).toBeNull();
    expect(verifyToken(`${body}.${mac.slice(0, -2)}xx`)).toBeNull();
    expect(verifyToken(undefined)).toBeNull();
    expect(verifyToken('not-a-token')).toBeNull();
  });

  it('a password change gives a different fingerprint, so old tokens stop working', () => {
    expect(passwordVersion('salt:hash-2')).not.toBe(passwordVersion(user.password_hash));
  });
});
