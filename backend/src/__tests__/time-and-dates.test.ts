import { describe, expect, it } from 'vitest';
import { hm, isQuiet, localDate, nextAllowed } from '../keepwarm/time.js';
import { fleetToday } from '../providers/coords.js';

const SYD = 'Australia/Sydney';

describe('fleet-local dates', () => {
  it('fleetToday uses Queensland time, not UTC', () => {
    // 20:30 UTC on the 17th is 06:30 on the 18th in Brisbane.
    expect(fleetToday(new Date('2026-11-17T20:30:00Z'))).toBe('2026-11-18');
    expect(fleetToday(new Date('2026-11-17T13:00:00Z'))).toBe('2026-11-17');
  });

  it('localDate respects the rep timezone (AEDT in November)', () => {
    expect(localDate(new Date('2026-11-17T14:30:00Z'), SYD)).toBe('2026-11-18');
  });
});

describe('SMS quiet hours', () => {
  it('parses HH:MM with a fallback', () => {
    expect(hm('08:30')).toBe(510);
    expect(hm('garbage', '09:00')).toBe(540);
  });

  it('never schedules a text inside quiet hours or on Sunday', () => {
    // Wed 18 Nov 2026 22:00 AEDT (11:00 UTC) is quiet; next allowed is Thu 08:00 local.
    const late = new Date('2026-11-18T11:00:00Z');
    expect(isQuiet(late, SYD)).toBe(true);
    const next = nextAllowed(late, SYD);
    expect(isQuiet(next, SYD)).toBe(false);
    expect(next.toISOString()).toBe('2026-11-18T21:00:00.000Z');
    // Saturday night rolls past Sunday to Monday morning.
    const sat = new Date('2026-11-21T11:00:00Z'); // Sat 22:00 AEDT
    expect(localDate(nextAllowed(sat, SYD), SYD)).toBe('2026-11-23');
  });

  it('leaves an allowed time unchanged', () => {
    const noon = new Date('2026-11-18T01:00:00Z'); // Wed 12:00 AEDT
    expect(nextAllowed(noon, SYD)).toBe(noon);
  });
});
