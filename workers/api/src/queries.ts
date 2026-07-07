/**
 * Query layer shared by the api worker (token/owner auth) and the console
 * worker (same-origin session auth) — PROJECT_PLAN.md §10, M1 subset (§18.5).
 *
 * Dashboards read the aggregate layer (rollup_*) wherever possible; raw
 * monthly events tables are touched only for dimensions/drill-downs the M1
 * rollups don't carry (country/device breakdowns, quality flags, traffic
 * list, visitor profile).
 */

import { FLAG, ALL_FLAGS, type FlagName } from '../../../shared/flags';
import { localYMD, localMidnightUtc, addDays, weekdayMon0, dayStr } from '../../../shared/tz';
import { monthSuffix } from '../../../shared/events';

// ---------------------------------------------------------------------------
// periods: "7d" | "30d" | "90d" → inclusive UTC day range
// ---------------------------------------------------------------------------

export interface Period {
  start: string; // YYYY-MM-DD
  end: string;
  startTs: number;
  endTs: number; // exclusive
}

type YMD = { y: number; m0: number; d: number };

/**
 * Resolve a period token to an inclusive day range in the SITE'S timezone
 * (analytics are keyed on the site's local calendar day, matching the daily
 * rollups). `start`/`end` are local day strings; `startTs`/`endTs` are the UTC
 * instants bounding them (for raw-events queries). Supports rolling windows
 * (`7d`/`30d`/`90d`, up to 730d) and calendar presets: today, yesterday,
 * this_week, last_week, this_month, last_month, this_year.
 */
export function parsePeriod(raw: string | null, tz = 'UTC', now: number = Date.now()): Period {
  const today = localYMD(now, tz);
  const token = (raw ?? '30d').toLowerCase();

  let start: YMD = today;
  let end: YMD = today;

  const rolling = token.match(/^(\d{1,4})d$/);
  if (rolling) {
    const days = Math.min(parseInt(rolling[1], 10) || 30, 730);
    start = addDays(today.y, today.m0, today.d, -(days - 1));
  } else {
    switch (token) {
      case 'today': break;
      case 'yesterday': start = end = addDays(today.y, today.m0, today.d, -1); break;
      case 'this_week': start = addDays(today.y, today.m0, today.d, -weekdayMon0(today.y, today.m0, today.d)); break;
      case 'last_week': {
        const mon = addDays(today.y, today.m0, today.d, -weekdayMon0(today.y, today.m0, today.d));
        end = addDays(mon.y, mon.m0, mon.d, -1);
        start = addDays(mon.y, mon.m0, mon.d, -7);
        break;
      }
      case 'this_month': start = { y: today.y, m0: today.m0, d: 1 }; break;
      case 'last_month': {
        const firstThis = { y: today.y, m0: today.m0, d: 1 };
        end = addDays(firstThis.y, firstThis.m0, firstThis.d, -1);
        start = { y: end.y, m0: end.m0, d: 1 };
        break;
      }
      case 'this_year': start = { y: today.y, m0: 0, d: 1 }; break;
      default: start = addDays(today.y, today.m0, today.d, -29); // 30d
    }
  }

  const endNext = addDays(end.y, end.m0, end.d, 1);
  return {
    start: dayStr(start.y, start.m0, start.d),
    end: dayStr(end.y, end.m0, end.d),
    startTs: localMidnightUtc(tz, start.y, start.m0, start.d),
    endTs: localMidnightUtc(tz, endNext.y, endNext.m0, endNext.d),
  };
}

/** A site's fixed display/aggregation timezone (defaults to UTC). */
export async function siteTimezone(db: D1Database, siteId: string): Promise<string> {
  const row = await db.prepare('SELECT timezone FROM sites WHERE site_id = ?').bind(siteId).first<{ timezone: string }>();
  return row?.timezone || 'UTC';
}

/** Existing events_YYYYMM tables overlapping the period's UTC ts span. */
async function eventTables(db: D1Database, period: Period): Promise<string[]> {
  const rows = await db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'events_[0-9][0-9][0-9][0-9][0-9][0-9]'")
    .all<{ name: string }>();
  const lo = monthSuffix(period.startTs);
  const hi = monthSuffix(period.endTs - 1);
  return rows.results
    .map((r) => r.name)
    .filter((n) => { const s = n.slice(7); return s >= lo && s <= hi; })
    .sort();
}

// ---------------------------------------------------------------------------
// GET /sites/:id/overview
// ---------------------------------------------------------------------------

export async function overview(db: D1Database, siteId: string, period: Period) {
  const row = await db.prepare(`
    SELECT
      COALESCE(SUM(pv), 0) AS pv,
      COALESCE(SUM(uv), 0) AS uv,
      COALESCE(SUM(sessions), 0) AS sessions,
      ROUND(SUM(bounce_rate * sessions) / NULLIF(SUM(CASE WHEN bounce_rate IS NOT NULL THEN sessions END), 0), 4) AS bounce_rate,
      CAST(SUM(avg_duration_ms * sessions) / NULLIF(SUM(CASE WHEN avg_duration_ms IS NOT NULL THEN sessions END), 0) AS INTEGER) AS avg_duration_ms,
      COALESCE(SUM(clean_count), 0) AS clean_count,
      COALESCE(SUM(suspect_count), 0) AS suspect_count,
      COALESCE(SUM(bot_count), 0) AS bot_count,
      COALESCE(SUM(crawler_count), 0) AS crawler_count
    FROM rollup_site_daily WHERE site_id = ? AND day BETWEEN ? AND ?
  `).bind(siteId, period.start, period.end).first();
  return { period: { start: period.start, end: period.end }, ...row };
}

// ---------------------------------------------------------------------------
// GET /sites/:id/timeseries?metric=pv&interval=day
// ---------------------------------------------------------------------------

const TS_METRICS = new Set([
  'pv', 'uv', 'sessions', 'bounce_rate', 'avg_duration_ms',
  'bot_count', 'suspect_count', 'crawler_count', 'clean_count',
]);

/** All calendar-day labels from start..end inclusive ('YYYY-MM-DD' strings). */
function enumerateDays(start: string, end: string): string[] {
  const out: string[] = [];
  let t = Date.parse(`${start}T00:00:00Z`);
  const endT = Date.parse(`${end}T00:00:00Z`);
  for (let i = 0; t <= endT && i < 800; i++, t += 86400e3) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

export async function timeseries(db: D1Database, siteId: string, metric: string, period: Period) {
  if (!TS_METRICS.has(metric)) throw new ApiError(400, `unknown metric: ${metric}`);
  const rows = await db.prepare(
    `SELECT day, ${metric} AS value FROM rollup_site_daily WHERE site_id = ? AND day BETWEEN ? AND ?`,
  ).bind(siteId, period.start, period.end).all<{ day: string; value: number }>();
  // fill zero-traffic days so the series has a point per day (a rate metric
  // stays null on a no-traffic day rather than a misleading 0)
  const byDay = new Map(rows.results.map((r) => [r.day, r.value]));
  const missing = metric === 'bounce_rate' || metric === 'avg_duration_ms' ? null : 0;
  const points = enumerateDays(period.start, period.end).map((day) => ({ day, value: byDay.has(day) ? byDay.get(day)! : missing }));
  return { metric, interval: 'day', points };
}

// ---------------------------------------------------------------------------
// GET /sites/:id/breakdown?dim=page|source|utm_campaign|country|device
// ---------------------------------------------------------------------------

export async function breakdown(db: D1Database, siteId: string, dim: string, period: Period, limit: number) {
  limit = Math.min(Math.max(limit, 1), 100);

  if (dim === 'page') {
    const rows = await db.prepare(`
      SELECT hostname, path, SUM(pv) AS pv, SUM(uv) AS uv, SUM(sessions) AS sessions,
             SUM(bounces) AS bounces, SUM(total_duration_ms) AS total_duration_ms,
             SUM(pv_clean) AS pv_clean, SUM(uv_clean) AS uv_clean
      FROM rollup_page_daily WHERE site_id = ? AND day BETWEEN ? AND ?
      GROUP BY hostname, path ORDER BY pv DESC LIMIT ?
    `).bind(siteId, period.start, period.end, limit).all();
    return { dim, rows: rows.results };
  }

  if (dim === 'source' || dim === 'utm_campaign') {
    const col = dim === 'source' ? 'source' : 'campaign';
    const rows = await db.prepare(`
      SELECT ${col} AS key, SUM(pv) AS pv, SUM(uv) AS uv, SUM(sessions) AS sessions,
             SUM(pv_clean) AS pv_clean, SUM(uv_clean) AS uv_clean
      FROM rollup_source_daily WHERE site_id = ? AND day BETWEEN ? AND ? ${dim === 'utm_campaign' ? "AND campaign != ''" : ''}
      GROUP BY ${col} ORDER BY pv DESC LIMIT ?
    `).bind(siteId, period.start, period.end, limit).all();
    return { dim, rows: rows.results };
  }

  if (dim === 'country' || dim === 'device') {
    // not carried by M1 rollups — aggregate raw pageviews. A UNION-ALL over the
    // period's month partitions lets SQL do COUNT(DISTINCT visitor_id) ONCE
    // across all months (exact uv, no cross-month double-count) without
    // streaming rows into the isolate.
    const col = dim === 'country' ? 'country' : 'device_type';
    const tables = await eventTables(db, period);
    if (tables.length === 0) return { dim, rows: [] };
    const union = tables
      .map((t) => `SELECT ${col} AS k, visitor_id, verdict FROM ${t} WHERE site_id = ? AND event = 'pageview' AND ts >= ? AND ts < ?`)
      .join(' UNION ALL ');
    const binds = tables.flatMap(() => [siteId, period.startTs, period.endTs]);
    const rows = await db.prepare(`
      SELECT COALESCE(k, '(unknown)') AS key,
             COUNT(*) AS pv,
             COUNT(DISTINCT visitor_id) AS uv,
             SUM(CASE WHEN verdict NOT IN ('bot','crawler') THEN 1 ELSE 0 END) AS pv_clean
      FROM (${union})
      GROUP BY key ORDER BY pv DESC LIMIT ?
    `).bind(...binds, limit).all();
    return { dim, rows: rows.results };
  }

  throw new ApiError(400, `unknown dim: ${dim}`);
}

// ---------------------------------------------------------------------------
// GET /sites/:id/quality — verdict split, daily bot share, fired-flag counts
// ---------------------------------------------------------------------------

export async function quality(db: D1Database, siteId: string, period: Period) {
  const totals = await db.prepare(`
    SELECT COALESCE(SUM(clean_count),0) AS clean, COALESCE(SUM(suspect_count),0) AS suspect,
           COALESCE(SUM(bot_count),0) AS bot, COALESCE(SUM(crawler_count),0) AS crawler
    FROM rollup_site_daily WHERE site_id = ? AND day BETWEEN ? AND ?
  `).bind(siteId, period.start, period.end).first<{ clean: number; suspect: number; bot: number; crawler: number }>();

  const daily = await db.prepare(`
    SELECT day, pv, bot_count, suspect_count, crawler_count, clean_count
    FROM rollup_site_daily WHERE site_id = ? AND day BETWEEN ? AND ? ORDER BY day
  `).bind(siteId, period.start, period.end).all();

  // which signals fire most (evidence panel, §11.2) — bit-counted in SQL.
  // Count pageview events only, so these are comparable to the pageview-based
  // verdict totals above (every visit also emits page_leave etc. carrying the
  // same flags; counting all events would ~double the numbers).
  const flagCols = ALL_FLAGS.map((n) => `SUM(CASE WHEN bot_flags & ${FLAG[n]} THEN 1 ELSE 0 END) AS ${n}`).join(', ');
  const flags: Record<string, number> = {};
  for (const table of await eventTables(db, period)) {
    const row = await db.prepare(
      `SELECT ${flagCols} FROM ${table} WHERE site_id = ? AND event = 'pageview' AND ts >= ? AND ts < ?`,
    ).bind(siteId, period.startTs, period.endTs).first<Record<FlagName, number>>();
    for (const n of ALL_FLAGS) flags[n] = (flags[n] ?? 0) + (row?.[n] ?? 0);
  }

  return { totals, daily: daily.results, flags };
}

// ---------------------------------------------------------------------------
// GET /sites/:id/traffic?verdict=&min_score=&limit= — drill-down list (§11.2)
// ---------------------------------------------------------------------------

export async function traffic(
  db: D1Database, siteId: string, period: Period,
  opts: { verdict?: string | null; minScore?: number; limit?: number },
) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const conds = ['site_id = ?', 'ts >= ?', 'ts < ?'];
  const binds: unknown[] = [siteId, period.startTs, period.endTs];
  if (opts.verdict && ['clean', 'suspect', 'bot', 'crawler'].includes(opts.verdict)) {
    conds.push('verdict = ?');
    binds.push(opts.verdict);
  }
  if (opts.minScore !== undefined && !Number.isNaN(opts.minScore)) {
    conds.push('bot_score >= ?');
    binds.push(opts.minScore);
  }

  // Fetch the top `limit` from EACH month table, then merge-sort globally —
  // taking newest-first-until-full would drop higher-scoring rows that live in
  // an older partition, breaking the "sorted by bot_score" contract.
  const merged: { ts: number; bot_score: number; [k: string]: unknown }[] = [];
  for (const table of await eventTables(db, period)) {
    const rows = await db.prepare(`
      SELECT ts, event, hostname, path, visitor_id, session_id, country, browser, os,
             device_type, asn_type, duration_ms, had_interaction,
             bot_score, verdict, bot_flags, score_stage
      FROM ${table} WHERE ${conds.join(' AND ')}
      ORDER BY bot_score DESC, ts DESC LIMIT ?
    `).bind(...binds, limit).all<{ ts: number; bot_score: number }>();
    merged.push(...(rows.results as { ts: number; bot_score: number }[]));
  }
  merged.sort((a, b) => b.bot_score - a.bot_score || b.ts - a.ts);
  return { rows: merged.slice(0, limit) };
}

// ---------------------------------------------------------------------------
// GET /sites/:id/visitors/:vid/profile
// ---------------------------------------------------------------------------

export async function visitorProfile(db: D1Database, siteId: string, vid: string, period: Period) {
  const profile = await db.prepare(
    'SELECT * FROM visitor_profiles WHERE site_id = ? AND visitor_id = ?',
  ).bind(siteId, vid).first();

  const sessions = await db.prepare(`
    SELECT session_id, entry_page, exit_page, pageviews, duration_ms, had_interaction,
           is_bounce, source, medium, campaign, bot_score, verdict, started_at, last_active_at
    FROM sessions WHERE site_id = ? AND visitor_id = ? ORDER BY started_at DESC LIMIT 50
  `).bind(siteId, vid).all();

  const events: unknown[] = [];
  for (const table of (await eventTables(db, period)).reverse()) {
    if (events.length >= 100) break;
    const rows = await db.prepare(`
      SELECT ts, event, path, referrer, duration_ms, scroll_depth, had_interaction,
             bot_score, verdict, bot_flags, score_stage
      FROM ${table} WHERE site_id = ? AND visitor_id = ? ORDER BY ts DESC LIMIT ?
    `).bind(siteId, vid, 100 - events.length).all();
    events.push(...rows.results);
  }

  return { profile, sessions: sessions.results, events };
}

// ---------------------------------------------------------------------------

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
