/**
 * Timezone helpers for analytics aggregation (PROJECT_PLAN.md §9).
 *
 * Analytics are bucketed by each site's LOCAL calendar day. Unique-visitor
 * counts cannot be re-bucketed into a different timezone after the fact
 * (distinct counts don't decompose), so the site's timezone is fixed at
 * creation and every daily rollup is keyed on that timezone's calendar day.
 *
 * All functions use the platform Intl database (IANA zones), so DST and
 * half-hour/45-min offsets are handled correctly.
 */

const DAY_MS = 86400e3;

/** Offset (ms) of a timezone at a given instant: local wall-clock − UTC. */
export function tzOffsetMs(instant: number, tz: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(new Date(instant))) p[part.type] = part.value;
  let hour = parseInt(p.hour, 10);
  if (hour === 24) hour = 0; // some engines render midnight as 24
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, hour, +p.minute, +p.second);
  return asUTC - instant;
}

/** Local calendar Y / M(0-based) / D of an instant, in tz. */
export function localYMD(instant: number, tz: string): { y: number; m0: number; d: number } {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(new Date(instant))) p[part.type] = part.value;
  return { y: +p.year, m0: +p.month - 1, d: +p.day };
}

/** UTC instant of local midnight (00:00) for calendar day (y, m0, d) in tz. */
export function localMidnightUtc(tz: string, y: number, m0: number, d: number): number {
  const guess = Date.UTC(y, m0, d);
  const off = tzOffsetMs(guess, tz);
  let t = guess - off;
  const off2 = tzOffsetMs(t, tz); // refine across a DST transition
  if (off2 !== off) t = guess - off2;
  return t;
}

export function dayStr(y: number, m0: number, d: number): string {
  return `${y}-${String(m0 + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Shift a calendar day by whole days (calendar-safe, no DST drift). */
export function addDays(y: number, m0: number, d: number, delta: number): { y: number; m0: number; d: number } {
  const dt = new Date(Date.UTC(y, m0, d) + delta * DAY_MS);
  return { y: dt.getUTCFullYear(), m0: dt.getUTCMonth(), d: dt.getUTCDate() };
}

/** Weekday of a calendar date, Monday = 0. */
export function weekdayMon0(y: number, m0: number, d: number): number {
  return (new Date(Date.UTC(y, m0, d)).getUTCDay() + 6) % 7;
}

/** UTC [start, end) span of a site-local calendar day, plus its day string. */
export function localDaySpan(tz: string, y: number, m0: number, d: number): { day: string; startTs: number; endTs: number } {
  const next = addDays(y, m0, d, 1);
  return {
    day: dayStr(y, m0, d),
    startTs: localMidnightUtc(tz, y, m0, d),
    endTs: localMidnightUtc(tz, next.y, next.m0, next.d),
  };
}

/** Validate an IANA timezone id (e.g. "Asia/Shanghai", "UTC"). */
export function isValidTimezone(tz: string): boolean {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
