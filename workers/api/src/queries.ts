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

// ---------------------------------------------------------------------------
// periods: "7d" | "30d" | "90d" → inclusive UTC day range
// ---------------------------------------------------------------------------

export interface Period {
  start: string; // YYYY-MM-DD
  end: string;
  startTs: number;
  endTs: number; // exclusive
}

export function parsePeriod(raw: string | null): Period {
  const m = (raw ?? '').match(/^(\d{1,3})d$/);
  const days = Math.min(m ? parseInt(m[1], 10) : 30, 365) || 30;
  const now = new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(end.getTime() - (days - 1) * 86400e3);
  return {
    start: dayStr(start),
    end: dayStr(end),
    startTs: start.getTime(),
    endTs: end.getTime() + 86400e3,
  };
}

function dayStr(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** Existing events_YYYYMM tables overlapping the period. */
async function eventTables(db: D1Database, period: Period): Promise<string[]> {
  const rows = await db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'events_[0-9][0-9][0-9][0-9][0-9][0-9]'")
    .all<{ name: string }>();
  const lo = period.start.slice(0, 7).replace('-', '');
  const hi = period.end.slice(0, 7).replace('-', '');
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

export async function timeseries(db: D1Database, siteId: string, metric: string, period: Period) {
  if (!TS_METRICS.has(metric)) throw new ApiError(400, `unknown metric: ${metric}`);
  const rows = await db.prepare(
    `SELECT day, ${metric} AS value FROM rollup_site_daily WHERE site_id = ? AND day BETWEEN ? AND ? ORDER BY day`,
  ).bind(siteId, period.start, period.end).all();
  return { metric, interval: 'day', points: rows.results };
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
    // not carried by M1 rollups — aggregate raw pageviews across month tables
    const col = dim === 'country' ? 'country' : 'device_type';
    const acc = new Map<string, { pv: number; uv: Set<string>; pv_clean: number }>();
    for (const table of await eventTables(db, period)) {
      const rows = await db.prepare(`
        SELECT COALESCE(${col}, '(unknown)') AS key, visitor_id, verdict
        FROM ${table} WHERE site_id = ? AND event = 'pageview' AND ts >= ? AND ts < ?
      `).bind(siteId, period.startTs, period.endTs).all<{ key: string; visitor_id: string; verdict: string }>();
      for (const r of rows.results) {
        const e = acc.get(r.key) ?? { pv: 0, uv: new Set<string>(), pv_clean: 0 };
        e.pv++;
        e.uv.add(r.visitor_id);
        if (r.verdict !== 'bot' && r.verdict !== 'crawler') e.pv_clean++;
        acc.set(r.key, e);
      }
    }
    const rows = [...acc.entries()]
      .map(([key, e]) => ({ key, pv: e.pv, uv: e.uv.size, pv_clean: e.pv_clean }))
      .sort((a, b) => b.pv - a.pv)
      .slice(0, limit);
    return { dim, rows };
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

  // which signals fire most (evidence panel, §11.2) — bit-counted in SQL
  const flagCols = ALL_FLAGS.map((n) => `SUM(CASE WHEN bot_flags & ${FLAG[n]} THEN 1 ELSE 0 END) AS ${n}`).join(', ');
  const flags: Record<string, number> = {};
  for (const table of await eventTables(db, period)) {
    const row = await db.prepare(
      `SELECT ${flagCols} FROM ${table} WHERE site_id = ? AND ts >= ? AND ts < ?`,
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

  const out: unknown[] = [];
  for (const table of (await eventTables(db, period)).reverse()) {
    if (out.length >= limit) break;
    const rows = await db.prepare(`
      SELECT ts, event, hostname, path, visitor_id, session_id, country, browser, os,
             device_type, asn_type, duration_ms, had_interaction,
             bot_score, verdict, bot_flags, score_stage
      FROM ${table} WHERE ${conds.join(' AND ')}
      ORDER BY bot_score DESC, ts DESC LIMIT ?
    `).bind(...binds, limit - out.length).all();
    out.push(...rows.results);
  }
  return { rows: out };
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
