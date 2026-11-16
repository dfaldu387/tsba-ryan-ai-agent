// Time-zone and quiet-hours rules for the sales follow-up agent. Everything is
// computed in the rep's own zone (default Australia/Sydney), never server time.

/**
 * Quiet hours: texts only go out Mon–Sat between these local times. start/end
 * are admin-adjustable (Sales settings); Sundays are always quiet.
 */
export const QUIET: { start: string; end: string; readonly sunday: false } = { start: '08:00', end: '20:00', sunday: false };

interface LocalParts {
  date: string; // YYYY-MM-DD
  minutes: number; // minutes since local midnight
  weekday: number; // 0 = Sunday
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-AU', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function localParts(at: Date, tz: string): LocalParts {
  const p: Record<string, string> = {};
  for (const part of fmt(tz).formatToParts(at)) p[part.type] = part.value;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    minutes: Number(p.hour) * 60 + Number(p.minute),
    weekday: WD[p.weekday] ?? 0,
  };
}

export function localDate(at: Date, tz: string): string {
  return localParts(at, tz).date;
}

export function hm(s: string | null | undefined, fallback = '09:00'): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s ?? '') ?? /^(\d{1,2}):(\d{2})$/.exec(fallback)!;
  return Math.min(23, Number(m[1])) * 60 + Math.min(59, Number(m[2]));
}

/** Add whole days to a YYYY-MM-DD date (calendar arithmetic, no zone drift). */
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/** Move a due date off a Sunday (no Sunday texts) onto Monday. */
export function skipSunday(date: string): string {
  return weekdayOf(date) === 0 && !QUIET.sunday ? addDays(date, 1) : date;
}

/** Monday of the week containing `date`. */
export function weekStart(date: string): string {
  const wd = weekdayOf(date);
  return addDays(date, wd === 0 ? -6 : 1 - wd);
}

export function isQuiet(at: Date, tz: string): boolean {
  const p = localParts(at, tz);
  if (p.weekday === 0 && !QUIET.sunday) return true;
  return p.minutes < hm(QUIET.start) || p.minutes >= hm(QUIET.end);
}

/**
 * The UTC instant for a local wall-clock time on a local date. Iterates the
 * offset twice so it is correct across daylight-saving changes.
 */
export function zonedInstant(date: string, minutes: number, tz: string): Date {
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  let guess = new Date(`${date}T${hh}:${mm}:00Z`);
  for (let i = 0; i < 2; i++) {
    const p = localParts(guess, tz);
    const wantMs = Date.parse(`${date}T${hh}:${mm}:00Z`);
    const gotMs = Date.parse(`${p.date}T00:00:00Z`) + p.minutes * 60_000;
    guess = new Date(guess.getTime() + (wantMs - gotMs));
  }
  return guess;
}

/** The earliest instant ≥ `at` that is outside quiet hours. */
export function nextAllowed(at: Date, tz: string): Date {
  if (!isQuiet(at, tz)) return at;
  let { date, minutes } = localParts(at, tz);
  if (minutes >= hm(QUIET.end)) date = addDays(date, 1);
  date = skipSunday(date);
  return zonedInstant(date, hm(QUIET.start), tz);
}
