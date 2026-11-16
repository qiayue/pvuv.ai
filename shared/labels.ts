/**
 * Site labels for the portfolio console (docs/design/portfolio-ui.md §3.2).
 *
 * Stored labels live in `site_labels` (migration 0026). The launch cohort is
 * NOT stored: it is derived from the site's creation time at read time, so it
 * never goes stale and needs no backfill.
 */
import { localYMD } from './tz';

/** Automatic cohort tag `launch:YYYY-Www` — the ISO-8601 week, in `tz`, of the
 *  day the site was created. Week-numbering year, so the last days of December
 *  can belong to week 1 of the next year (and early January to week 52/53). */
export function cohortTag(created_at: number, tz = 'UTC'): string {
  let ymd: { y: number; m0: number; d: number };
  try { ymd = localYMD(created_at, tz || 'UTC'); } catch { ymd = localYMD(created_at, 'UTC'); }
  const date = new Date(Date.UTC(ymd.y, ymd.m0, ymd.d));
  const dow = (date.getUTCDay() + 6) % 7; // Mon = 0
  date.setUTCDate(date.getUTCDate() - dow + 3); // the Thursday of this week
  const isoYear = date.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const week = 1 + Math.round(((date.getTime() - jan4.getTime()) / 86_400_000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `launch:${isoYear}-W${String(week).padStart(2, '0')}`;
}
