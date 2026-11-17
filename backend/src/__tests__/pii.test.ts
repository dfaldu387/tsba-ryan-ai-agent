import { describe, expect, it } from 'vitest';
import type { AuthenticatedUser } from '@tsba/shared';
import { canSeePii, maskText, redactInfo, redactStations } from '../pii.js';

const user = (role: string) =>
  ({ id: role, email: `${role}@x.y`, name: role, role, permissions: [] }) as unknown as AuthenticatedUser;

describe('PII redaction', () => {
  it('only viewers (and anonymous callers) are denied PII', () => {
    expect(canSeePii(user('admin'))).toBe(true);
    expect(canSeePii(user('manager'))).toBe(true);
    expect(canSeePii(user('viewer'))).toBe(false);
    expect(canSeePii(undefined)).toBe(false);
  });

  it('masks each word to its first letter, idempotently (matches the UI)', () => {
    expect(maskText('Kyle McMillian')).toBe('K••• M•••');
    expect(maskText(maskText('Kyle McMillian'))).toBe('K••• M•••');
    expect(maskText(undefined)).toBeUndefined();
  });

  it('redacts owner/contact/location and coarsens coordinates for viewers only', () => {
    const rows = [{ id: '1', owner: 'Jane Citizen', contact: '0400 000 000', location: '1 Main St Caboolture', lat: -27.0812345, lng: 152.951234 }];
    const [v] = redactStations(rows, user('viewer'));
    expect(v.owner).toBe('J••• C•••');
    expect(v.location).not.toContain('Main');
    expect(v.lat).toBe(-27.08);
    expect(v.lng).toBe(152.95);
    expect(redactStations(rows, user('admin'))).toBe(rows);
  });

  it('masks only personal info rows', () => {
    const info = [
      { label: 'Owner email', value: 'jane@example.com' },
      { label: 'Inverter model', value: 'SUN-10K-SG04LP3' },
    ];
    const out = redactInfo(info, user('viewer'))!;
    expect(out[0].value).not.toContain('example');
    expect(out[1].value).toBe('SUN-10K-SG04LP3');
  });
});
