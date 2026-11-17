import { describe, expect, it } from 'vitest';
import { clearLoginFailures, loginBlockedFor, noteLoginFailure } from '../login-throttle.js';

describe('login throttle', () => {
  const t0 = 1_800_000_000_000;

  it('allows 8 failures per IP+email, then blocks for the rest of the 15-minute window', () => {
    const ip = '10.0.0.1';
    const email = 'Someone@Example.com';
    for (let i = 0; i < 8; i++) {
      expect(loginBlockedFor(ip, email, t0 + i)).toBe(0);
      noteLoginFailure(ip, email, t0 + i);
    }
    const wait = loginBlockedFor(ip, email, t0 + 10);
    expect(wait).toBeGreaterThan(14 * 60_000);
    expect(wait).toBeLessThanOrEqual(15 * 60_000);
    // Changing the email's case doesn't buy a fresh allowance.
    expect(loginBlockedFor(ip, 'someone@example.com', t0 + 10)).toBeGreaterThan(0);
    // Once the window has passed, sign-in is allowed again.
    expect(loginBlockedFor(ip, email, t0 + 15 * 60_000 + 10)).toBe(0);
  });

  it('a successful login clears the account counter', () => {
    const ip = '10.0.0.2';
    const email = 'a@b.c';
    for (let i = 0; i < 8; i++) noteLoginFailure(ip, email, t0);
    expect(loginBlockedFor(ip, email, t0)).toBeGreaterThan(0);
    clearLoginFailures(ip, email);
    expect(loginBlockedFor(ip, email, t0)).toBe(0);
  });

  it('caps one IP spraying many accounts at 40 failures', () => {
    const ip = '10.0.0.3';
    for (let i = 0; i < 40; i++) noteLoginFailure(ip, `user${i}@x.y`, t0);
    expect(loginBlockedFor(ip, 'fresh@x.y', t0)).toBeGreaterThan(0);
    expect(loginBlockedFor('10.0.0.4', 'fresh@x.y', t0)).toBe(0); // other IPs unaffected
  });
});
