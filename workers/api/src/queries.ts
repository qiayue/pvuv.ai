/**
 * Query layer shared by the api worker (token/owner auth) and the console
 * worker (same-origin session auth) — PROJECT_PLAN.md §10, M1 subset (§18.5).
 *
 * Freshness model (M1): the dashboard is REAL-TIME. Totals, breakdowns, quality
 * and the live-visitor count are computed directly from the raw monthly events
 * tables + the (consumer-maintained, live) sessions table, so opening or
 * refreshing the page always reflects the newest data — nothing waits for the
 * hourly rollup. The only place the pre-aggregated rollup_* tables are read is
 * the per-day TIMESERIES history (which needs each day bucketed in the site's
 * timezone — exactly what the rollup precomputes): past days come from the
 * rollup, and today is recomputed live and appended. So the rollup's job is to
 * make historical chart reads cheap, never to gate current numbers.
 */

import { FLAG, ALL_FLAGS, type FlagName } from '../../../shared/flags';
import { localYMD, localMidnightUtc, localDaySpan, addDays, weekdayMon0, dayStr, tzOffsetMs } from '../../../shared/tz';
import { monthSuffix } from '../../../shared/events';
import { CONFIG } from '../../../shared/config.gen';

// ---------------------------------------------------------------------------
// periods: "7d" | "30d" | "90d" | calendar presets → inclusive day range
// ---------------------------------------------------------------------------

export interface Period {
  start: string; // YYYY-MM-DD (site-local)
  end: string;
  startTs: number;
  endTs: number; // exclusive
  tz: string;    // site timezone the range is expressed in
  now: number;   // server instant the range was resolved at (for today-split)
  subDay?: boolean; // rolling intraday window (e.g. last 24h): chart uses hour/minute buckets only
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

  // rolling intraday window: the last 24 hours, snapped to LOCAL clock-hour
  // boundaries so the hourly chart buckets line up with their "HH:00" labels
  // (an unaligned start would mislabel every bucket by up to 59 min). Covers the
  // 24 clock-hours ending with the current (partial) hour.
  if (token === '24h') {
    const H = 3_600_000;
    const off = tzOffsetMs(now, tz);
    const curHourStart = Math.floor((now + off) / H) * H - off; // start of now's local hour (UTC ms)
    const startTs = curHourStart - 23 * H;
    const endTs = curHourStart + H;                             // end of the current local hour (24 buckets)
    const s = localYMD(startTs, tz);
    const e = localYMD(endTs - 1, tz);
    return {
      start: dayStr(s.y, s.m0, s.d), end: dayStr(e.y, e.m0, e.d),
      startTs, endTs, tz, now, subDay: true,
    };
  }

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
    tz,
    now,
  };
}

/** A site's fixed display/aggregation timezone (defaults to UTC). */
export async function siteTimezone(db: D1Database, siteId: string): Promise<string> {
  const row = await db.prepare('SELECT timezone FROM sites WHERE site_id = ?').bind(siteId).first<{ timezone: string }>();
  return row?.timezone || 'UTC';
}

// ---------------------------------------------------------------------------
// raw-events helpers
// ---------------------------------------------------------------------------

/** Existing events_YYYYMM tables overlapping a UTC [startTs, endTs) span. */
async function eventTables(db: D1Database, startTs: number, endTs: number): Promise<string[]> {
  const rows = await db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'events_[0-9][0-9][0-9][0-9][0-9][0-9]'")
    .all<{ name: string }>();
  const lo = monthSuffix(startTs);
  const hi = monthSuffix(endTs - 1);
  return rows.results
    .map((r) => r.name)
    .filter((n) => { const s = n.slice(7); return s >= lo && s <= hi; })
    .sort();
}

/** A UNION-ALL over month partitions scoped to one site + UTC span, so a
 *  COUNT(DISTINCT …) runs ONCE across all months (exact, no cross-month
 *  double-count) without streaming rows into the isolate. */
function unionOver(tables: string[], cols: string, siteId: string, startTs: number, endTs: number, extra = '', extraBinds: unknown[] = []):
  { sql: string; binds: unknown[] } {
  const parts = tables.map((t) => `SELECT ${cols} FROM ${t} WHERE site_id = ? AND ts >= ? AND ts < ?${extra ? ` AND ${extra}` : ''}`);
  return { sql: parts.join(' UNION ALL '), binds: tables.flatMap(() => [siteId, startTs, endTs, ...extraBinds]) };
}

// ---------------------------------------------------------------------------
// Faceted filtering (Plausible-style): click any dimension value to narrow the
// whole dashboard; filters stack (AND). When ≥1 filter is active every metric
// is computed LIVE from raw events + sessions (rollups are pre-aggregated and
// can't be filtered). Event-derived metrics use the event column; session-
// derived metrics (bounce/dwell/sources) use the matching session column.
// ---------------------------------------------------------------------------

export interface Filter { dim: string; value: string; }

/** dim → raw-events WHERE fragment (+binds). */
const EVENT_FILTER: Record<string, (v: string) => { sql: string; binds: unknown[] }> = {
  page: (v) => ({ sql: 'path = ?', binds: [v] }),
  country: (v) => v === '(unknown)' ? { sql: 'country IS NULL', binds: [] } : { sql: 'country = ?', binds: [v] },
  device: (v) => ({ sql: 'device_type = ?', binds: [v] }),
  browser: (v) => v === '(unknown)' ? { sql: 'browser IS NULL', binds: [] } : { sql: 'browser = ?', binds: [v] },
  os: (v) => v === '(unknown)' ? { sql: 'os IS NULL', binds: [] } : { sql: 'os = ?', binds: [v] },
  region: (v) => v === '(unknown)' ? { sql: 'region IS NULL', binds: [] } : { sql: 'region = ?', binds: [v] },
  city: (v) => v === '(unknown)' ? { sql: 'city IS NULL', binds: [] } : { sql: 'city = ?', binds: [v] },
  source: (v) => v === '(direct)'
    ? { sql: '(utm_source IS NULL AND ref_domain IS NULL)', binds: [] }
    : { sql: 'COALESCE(utm_source, ref_domain) = ?', binds: [v] },
  utm_campaign: (v) => ({ sql: 'utm_campaign = ?', binds: [v] }),
  utm_medium: (v) => ({ sql: 'utm_medium = ?', binds: [v] }),
  utm_term: (v) => ({ sql: 'utm_term = ?', binds: [v] }),
  utm_content: (v) => ({ sql: 'utm_content = ?', binds: [v] }),
  ft_source: (v) => ({ sql: 'ft_source = ?', binds: [v] }),
  ft_medium: (v) => ({ sql: 'ft_medium = ?', binds: [v] }),
  ft_campaign: (v) => ({ sql: 'ft_campaign = ?', binds: [v] }),
};

/** dim → sessions WHERE fragment (+binds). Dims not stored on sessions
 *  (utm_term/content, ft_*) can't constrain session-derived metrics. */
const SESSION_FILTER: Record<string, (v: string) => { sql: string; binds: unknown[] }> = {
  page: (v) => ({ sql: 'entry_page = ?', binds: [v] }),
  country: (v) => v === '(unknown)' ? { sql: 'country IS NULL', binds: [] } : { sql: 'country = ?', binds: [v] },
  device: (v) => ({ sql: 'device_type = ?', binds: [v] }),
  source: (v) => v === '(direct)' ? { sql: 'source IS NULL', binds: [] } : { sql: 'source = ?', binds: [v] },
  utm_campaign: (v) => ({ sql: 'campaign = ?', binds: [v] }),
  utm_medium: (v) => ({ sql: 'medium = ?', binds: [v] }),
};

/** Filterable dims the UI may send. */
export const FILTERABLE = new Set(Object.keys(EVENT_FILTER));

/** Build a combined AND WHERE fragment for the given target, optionally
 *  skipping one dim (used by breakdown so a dimension isn't self-filtered). */
function buildWhere(
  map: Record<string, (v: string) => { sql: string; binds: unknown[] }>,
  filters: Filter[], skipDim?: string,
): { sql: string; binds: unknown[] } {
  const parts: string[] = [];
  const binds: unknown[] = [];
  for (const f of filters) {
    if (skipDim && f.dim === skipDim) continue;
    const fn = map[f.dim];
    if (!fn) continue; // dim not representable on this target → not constrained
    const r = fn(f.value);
    parts.push(r.sql);
    binds.push(...r.binds);
  }
  return { sql: parts.join(' AND '), binds };
}

const evFilter = (filters: Filter[], skipDim?: string) => buildWhere(EVENT_FILTER, filters, skipDim);
const seFilter = (filters: Filter[], skipDim?: string) => buildWhere(SESSION_FILTER, filters, skipDim);

/** Site-level pageview aggregates over a UTC span, live from raw events.
 *  Mirrors the rollup's definitions exactly (clean = verdict NOT bot/crawler). */
interface SiteAgg {
  pv: number; uv: number; sessions: number;
  clean_count: number; suspect_count: number; bot_count: number; crawler_count: number;
}
async function eventsSiteAgg(db: D1Database, siteId: string, startTs: number, endTs: number, filters: Filter[] = []): Promise<SiteAgg> {
  const zero: SiteAgg = { pv: 0, uv: 0, sessions: 0, clean_count: 0, suspect_count: 0, bot_count: 0, crawler_count: 0 };
  const tables = await eventTables(db, startTs, endTs);
  if (tables.length === 0) return zero;
  const ef = evFilter(filters);
  const u = unionOver(tables, 'event, visitor_id, session_id, verdict', siteId, startTs, endTs, ef.sql, ef.binds);
  const row = await db.prepare(`
    SELECT
      COALESCE(SUM(event = 'pageview'), 0) AS pv,
      COUNT(DISTINCT CASE WHEN event = 'pageview' THEN visitor_id END) AS uv,
      COUNT(DISTINCT CASE WHEN event = 'pageview' THEN session_id END) AS sessions,
      COALESCE(SUM(event = 'pageview' AND verdict = 'clean'), 0) AS clean_count,
      COALESCE(SUM(event = 'pageview' AND verdict = 'suspect'), 0) AS suspect_count,
      COALESCE(SUM(event = 'pageview' AND verdict = 'bot'), 0) AS bot_count,
      COALESCE(SUM(event = 'pageview' AND verdict = 'crawler'), 0) AS crawler_count
    FROM (${u.sql})
  `).bind(...u.binds).first<SiteAgg>();
  return row ?? zero;
}

/** Session-derived metrics over a UTC span (live sessions table): both bounce
 *  definitions (GA4 engagement-based + single-page) and avg dwell. */
async function sessionAgg(db: D1Database, siteId: string, startTs: number, endTs: number, filters: Filter[] = []):
  Promise<{ bounce_rate: number | null; bounce_rate_single: number | null; avg_duration_ms: number | null; visit_duration_ms: number | null }> {
  const sf = seFilter(filters);
  const row = await db.prepare(`
    SELECT
      ROUND(AVG(CASE WHEN is_bounce = 1 THEN 1.0 ELSE 0.0 END), 4) AS bounce_rate,
      ROUND(AVG(CASE WHEN pageviews <= 1 THEN 1.0 ELSE 0.0 END), 4) AS bounce_rate_single,
      CAST(AVG(duration_ms) AS INTEGER) AS avg_duration_ms,
      -- NULL last_pageview_at = session predating migration 0010 (unknown), which
      -- AVG skips; genuine single-page visits have last_pageview_at = started_at
      -- (→ 0) and are correctly included. Never treat unknown as 0 — that would
      -- dilute the average toward zero while old data dominates the window.
      CAST(AVG(CASE WHEN last_pageview_at IS NOT NULL THEN last_pageview_at - started_at END) AS INTEGER) AS visit_duration_ms
    FROM sessions WHERE site_id = ? AND started_at >= ? AND started_at < ?${sf.sql ? ` AND ${sf.sql}` : ''}
  `).bind(siteId, startTs, endTs, ...sf.binds).first<{ bounce_rate: number | null; bounce_rate_single: number | null; avg_duration_ms: number | null; visit_duration_ms: number | null }>();
  return row ?? { bounce_rate: null, bounce_rate_single: null, avg_duration_ms: null, visit_duration_ms: null };
}

/** Split a period into [past days → rollup] and [today → live], in site tz.
 *  Today is always computed live and never read from the rollup, so the two
 *  sources never overlap (no double-count). */
function hybridSplit(period: Period): { hasPast: boolean; pastStart: string; pastEnd: string; today: { day: string; startTs: number; endTs: number } | null } {
  const t = localYMD(period.now, period.tz);
  const todayStr = dayStr(t.y, t.m0, t.d);
  const includesToday = period.start <= todayStr && todayStr <= period.end;
  const y = addDays(t.y, t.m0, t.d, -1);
  const ydayStr = dayStr(y.y, y.m0, y.d);
  const pastEnd = period.end < todayStr ? period.end : ydayStr;
  return {
    hasPast: period.start <= pastEnd,
    pastStart: period.start,
    pastEnd,
    today: includesToday ? localDaySpan(period.tz, t.y, t.m0, t.d) : null,
  };
}

// ---------------------------------------------------------------------------
// GET /sites/:id/overview  — real-time totals over the whole span
// ---------------------------------------------------------------------------

export async function overview(db: D1Database, siteId: string, period: Period, filters: Filter[] = []) {
  const ev = await eventsSiteAgg(db, siteId, period.startTs, period.endTs, filters);
  const s = await sessionAgg(db, siteId, period.startTs, period.endTs, filters);
  return {
    period: { start: period.start, end: period.end },
    pv: ev.pv, uv: ev.uv, sessions: ev.sessions,
    bounce_rate: s.bounce_rate, bounce_rate_single: s.bounce_rate_single,
    avg_duration_ms: s.avg_duration_ms, visit_duration_ms: s.visit_duration_ms,
    clean_count: ev.clean_count, suspect_count: ev.suspect_count,
    bot_count: ev.bot_count, crawler_count: ev.crawler_count,
  };
}

// ---------------------------------------------------------------------------
// GET /sites/:id/realtime — visitors active in the last N minutes (live)
// ---------------------------------------------------------------------------

/** Distinct human visitors + pageviews in the last `windowMin` minutes, with a
 *  per-minute pageview sparkline. Always live (independent of the period). */
export async function realtime(db: D1Database, siteId: string, now: number, windowMin = 30) {
  const startTs = now - windowMin * 60_000;
  const empty = { window_minutes: windowMin, online: 0, pageviews: 0, minutes: new Array(windowMin).fill(0) };
  const tables = await eventTables(db, startTs, now + 1);
  if (tables.length === 0) return empty;
  const u = unionOver(tables, 'event, visitor_id, verdict, ts', siteId, startTs, now + 1);

  const agg = await db.prepare(`
    SELECT
      COUNT(DISTINCT CASE WHEN verdict NOT IN ('bot','crawler') THEN visitor_id END) AS online,
      COALESCE(SUM(event = 'pageview' AND verdict NOT IN ('bot','crawler')), 0) AS pageviews
    FROM (${u.sql})
  `).bind(...u.binds).first<{ online: number; pageviews: number }>();

  const perMin = await db.prepare(`
    SELECT CAST((ts - ?) / 60000 AS INTEGER) AS m, COUNT(*) AS pv
    FROM (${u.sql})
    WHERE event = 'pageview' AND verdict NOT IN ('bot','crawler')
    GROUP BY m
  `).bind(startTs, ...u.binds).all<{ m: number; pv: number }>();

  const minutes = new Array(windowMin).fill(0);
  for (const r of perMin.results) if (r.m >= 0 && r.m < windowMin) minutes[r.m] = r.pv;
  return { window_minutes: windowMin, online: agg?.online ?? 0, pageviews: agg?.pageviews ?? 0, minutes };
}

// ---------------------------------------------------------------------------
// GET /sites/:id/timeseries?metric=pv&interval=day  — rollup history + live today
// ---------------------------------------------------------------------------

const TS_METRICS = new Set([
  'pv', 'uv', 'sessions', 'bounce_rate', 'bounce_rate_single',
  'avg_duration_ms', 'visit_duration_ms', 'pv_per_visitor',
  'bot_count', 'suspect_count', 'crawler_count', 'clean_count',
]);
const TS_INTERVALS = new Set(['minute', 'hour', 'day', 'week', 'month']);
const RATE_METRICS = new Set(['bounce_rate', 'bounce_rate_single', 'avg_duration_ms', 'visit_duration_ms', 'pv_per_visitor']);

/** All calendar-day labels from start..end inclusive ('YYYY-MM-DD' strings). */
function enumerateDays(start: string, end: string): string[] {
  const out: string[] = [];
  let t = Date.parse(`${start}T00:00:00Z`);
  const endT = Date.parse(`${end}T00:00:00Z`);
  for (let i = 0; t <= endT && i < 800; i++, t += 86400e3) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

// A per-bucket accumulator carrying enough to derive ANY metric (counts sum;
// rate metrics keep weighted numerator/denominator so buckets can be merged).
interface Acc {
  pv: number; uv: number; sessions: number;
  bounce_num: number; bounce_den: number; bs_num: number; bs_den: number;
  dur_num: number; dur_den: number; vdur_num: number; vdur_den: number;
  clean: number; suspect: number; bot: number; crawler: number;
}
const emptyAcc = (): Acc => ({ pv: 0, uv: 0, sessions: 0, bounce_num: 0, bounce_den: 0, bs_num: 0, bs_den: 0, dur_num: 0, dur_den: 0, vdur_num: 0, vdur_den: 0, clean: 0, suspect: 0, bot: 0, crawler: 0 });
function addAcc(dst: Acc, s: Acc): void {
  dst.pv += s.pv; dst.uv += s.uv; dst.sessions += s.sessions;
  dst.bounce_num += s.bounce_num; dst.bounce_den += s.bounce_den;
  dst.bs_num += s.bs_num; dst.bs_den += s.bs_den;
  dst.dur_num += s.dur_num; dst.dur_den += s.dur_den;
  dst.vdur_num += s.vdur_num; dst.vdur_den += s.vdur_den;
  dst.clean += s.clean; dst.suspect += s.suspect; dst.bot += s.bot; dst.crawler += s.crawler;
}
function metricOf(a: Acc, metric: string): number | null {
  switch (metric) {
    case 'pv': return a.pv;
    case 'uv': return a.uv;
    case 'sessions': return a.sessions;
    case 'clean_count': return a.clean;
    case 'suspect_count': return a.suspect;
    case 'bot_count': return a.bot;
    case 'crawler_count': return a.crawler;
    case 'bounce_rate': return a.bounce_den ? Math.round((a.bounce_num / a.bounce_den) * 1e4) / 1e4 : null;
    case 'bounce_rate_single': return a.bs_den ? Math.round((a.bs_num / a.bs_den) * 1e4) / 1e4 : null;
    case 'avg_duration_ms': return a.dur_den ? Math.round(a.dur_num / a.dur_den) : null;
    case 'visit_duration_ms': return a.vdur_den ? Math.round(a.vdur_num / a.vdur_den) : null;
    case 'pv_per_visitor': return a.uv ? Math.round((a.pv / a.uv) * 100) / 100 : null;
    default: return 0;
  }
}

/** Raw session counts over a span (exact bounce/dwell numerators). */
async function sessionRaw(db: D1Database, siteId: string, startTs: number, endTs: number, filters: Filter[] = []):
  Promise<{ sessions: number; bounces: number; bounces_single: number; duration_sum: number; visit_duration_sum: number; visit_duration_n: number }> {
  const sf = seFilter(filters);
  const r = await db.prepare(`
    SELECT COUNT(*) AS sessions,
           COALESCE(SUM(is_bounce), 0) AS bounces,
           COALESCE(SUM(CASE WHEN pageviews <= 1 THEN 1 ELSE 0 END), 0) AS bounces_single,
           COALESCE(SUM(duration_ms), 0) AS duration_sum,
           -- visit duration sums/counts only sessions with a known last pageview
           -- (post-migration); NULL = unknown, excluded from BOTH sum and denom
           COALESCE(SUM(CASE WHEN last_pageview_at IS NOT NULL THEN last_pageview_at - started_at ELSE 0 END), 0) AS visit_duration_sum,
           COALESCE(SUM(CASE WHEN last_pageview_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS visit_duration_n
    FROM sessions WHERE site_id = ? AND started_at >= ? AND started_at < ?${sf.sql ? ` AND ${sf.sql}` : ''}
  `).bind(siteId, startTs, endTs, ...sf.binds).first<{ sessions: number; bounces: number; bounces_single: number; duration_sum: number; visit_duration_sum: number; visit_duration_n: number }>();
  return r ?? { sessions: 0, bounces: 0, bounces_single: 0, duration_sum: 0, visit_duration_sum: 0, visit_duration_n: 0 };
}

/**
 * Metric-over-time series. `interval` controls the bucket size and defaults to
 * 'day'. minute/hour buckets are computed live from raw events + sessions;
 * day/week/month are built from the daily rollup (past) + live today, then
 * regrouped. Every metric (incl. derived pv_per_visitor) is supported.
 */
export async function timeseries(db: D1Database, siteId: string, metric: string, period: Period, interval = 'day', filters: Filter[] = []) {
  if (!TS_METRICS.has(metric)) throw new ApiError(400, `unknown metric: ${metric}`);
  if (!TS_INTERVALS.has(interval)) throw new ApiError(400, `unknown interval: ${interval}`);
  // a rolling intraday window (last 24h) can't use day/week/month rollup buckets
  // (that would pull whole calendar days) — force an intraday bucket size.
  if (period.subDay && interval !== 'minute' && interval !== 'hour') interval = 'hour';
  const points = interval === 'minute' || interval === 'hour'
    ? await subDaySeries(db, siteId, period, interval, metric, filters)
    : await calendarSeries(db, siteId, period, interval, metric, filters);
  return { metric, interval, points };
}

/** minute/hour buckets, live from raw events (+ sessions for rate metrics). */
async function subDaySeries(db: D1Database, siteId: string, period: Period, interval: string, metric: string, filters: Filter[] = []) {
  const step = interval === 'minute' ? 60_000 : 3_600_000;
  const n = Math.round((period.endTs - period.startTs) / step);
  if (n > 2000) throw new ApiError(400, 'range too large for this interval');
  const accs = Array.from({ length: n }, emptyAcc);
  const ef = evFilter(filters);
  const sf = seFilter(filters);

  const tables = await eventTables(db, period.startTs, period.endTs);
  if (tables.length) {
    const u = unionOver(tables, 'event, visitor_id, session_id, verdict, ts', siteId, period.startTs, period.endTs, ef.sql, ef.binds);
    const rows = await db.prepare(`
      SELECT CAST((ts - ?) / ? AS INTEGER) AS b,
        COALESCE(SUM(event = 'pageview'), 0) AS pv,
        COUNT(DISTINCT CASE WHEN event = 'pageview' THEN visitor_id END) AS uv,
        COUNT(DISTINCT CASE WHEN event = 'pageview' THEN session_id END) AS sessions,
        COALESCE(SUM(event = 'pageview' AND verdict = 'clean'), 0) AS clean,
        COALESCE(SUM(event = 'pageview' AND verdict = 'suspect'), 0) AS suspect,
        COALESCE(SUM(event = 'pageview' AND verdict = 'bot'), 0) AS bot,
        COALESCE(SUM(event = 'pageview' AND verdict = 'crawler'), 0) AS crawler
      FROM (${u.sql}) GROUP BY b
    `).bind(period.startTs, step, ...u.binds).all<Acc & { b: number }>();
    for (const r of rows.results) {
      const a = accs[r.b];
      if (a) { a.pv = r.pv; a.uv = r.uv; a.sessions = r.sessions; a.clean = r.clean; a.suspect = r.suspect; a.bot = r.bot; a.crawler = r.crawler; }
    }
  }

  if (metric === 'bounce_rate' || metric === 'bounce_rate_single'
      || metric === 'avg_duration_ms' || metric === 'visit_duration_ms') {
    const rows = await db.prepare(`
      SELECT CAST((started_at - ?) / ? AS INTEGER) AS b,
        COUNT(*) AS sc, COALESCE(SUM(is_bounce), 0) AS bc,
        COALESCE(SUM(CASE WHEN pageviews <= 1 THEN 1 ELSE 0 END), 0) AS bsc,
        COALESCE(SUM(duration_ms), 0) AS ds,
        COALESCE(SUM(CASE WHEN last_pageview_at IS NOT NULL THEN last_pageview_at - started_at ELSE 0 END), 0) AS vds,
        COALESCE(SUM(CASE WHEN last_pageview_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS vdn
      FROM sessions WHERE site_id = ? AND started_at >= ? AND started_at < ?${sf.sql ? ` AND ${sf.sql}` : ''} GROUP BY b
    `).bind(period.startTs, step, siteId, period.startTs, period.endTs, ...sf.binds).all<{ b: number; sc: number; bc: number; bsc: number; ds: number; vds: number; vdn: number }>();
    for (const r of rows.results) {
      const a = accs[r.b];
      if (a) {
        a.bounce_num = r.bc; a.bounce_den = r.sc; a.bs_num = r.bsc; a.bs_den = r.sc;
        a.dur_num = r.ds; a.dur_den = r.sc; a.vdur_num = r.vds; a.vdur_den = r.vdn;
      }
    }
  }

  const multiDay = period.endTs - period.startTs > 86400e3;
  return accs.map((a, i) => {
    const start = period.startTs + i * step;
    // 'future' = bucket hasn't begun; 'partial' = in progress (contains now);
    // 'complete' = fully elapsed. Lets the chart dash/omit non-final buckets.
    const status = start >= period.now ? 'future' : (start + step > period.now ? 'partial' : 'complete');
    return { label: subDayLabel(start, period.tz, interval, multiDay), value: metricOf(a, metric), status };
  });
}

/** day/week/month buckets. Day = rollup history + live today (exact per day).
 *  week/month = computed EXACTLY from raw events per bucket, because distinct
 *  visitor counts don't decompose across days (summing daily uv overcounts) and
 *  daily rollup rates would be mis-weighted when merged. */
async function calendarSeries(db: D1Database, siteId: string, period: Period, interval: string, metric: string, filters: Filter[] = []) {
  const t = localYMD(period.now, period.tz);
  const today = dayStr(t.y, t.m0, t.d);

  // group the period's days into buckets, tracking each bucket's day span
  const order: Array<{ label: string; min: string; max: string }> = [];
  const byKey = new Map<string, { label: string; min: string; max: string }>();
  for (const day of enumerateDays(period.start, period.end)) {
    const [key, label] = bucketKey(day, interval);
    let bk = byKey.get(key);
    if (!bk) { bk = { label, min: day, max: day }; byKey.set(key, bk); order.push(bk); }
    bk.max = day; // enumerateDays is chronological
  }
  const statusOf = (b: { min: string; max: string }) => b.max < today ? 'complete' : (b.min > today ? 'future' : 'partial');

  // Unfiltered day interval uses the fast rollup path; any active filter forces
  // live per-day computation (rollups are pre-aggregated and can't be filtered).
  if (interval === 'day' && filters.length === 0) {
    const daily = await dailyAccs(db, siteId, period);
    return order.map((b) => ({ label: b.label, value: metricOf(daily.get(b.min) ?? emptyAcc(), metric), status: statusOf(b) }));
  }

  // week/month (or filtered day): exact from raw events (+ sessions for rate
  // metrics) per bucket, because distinct visitor counts don't decompose.
  const needSess = metric === 'bounce_rate' || metric === 'bounce_rate_single'
    || metric === 'avg_duration_ms' || metric === 'visit_duration_ms';
  const out: Array<{ label: string; value: number | null; status: string }> = [];
  for (const b of order) {
    const [y1, m1, d1] = b.min.split('-').map(Number);
    const [y2, m2, d2] = b.max.split('-').map(Number);
    const startTs = localMidnightUtc(period.tz, y1, m1 - 1, d1);
    const nxt = addDays(y2, m2 - 1, d2, 1);
    const endTs = localMidnightUtc(period.tz, nxt.y, nxt.m0, nxt.d);
    const ev = await eventsSiteAgg(db, siteId, startTs, endTs, filters);
    const a = emptyAcc();
    a.pv = ev.pv; a.uv = ev.uv; a.sessions = ev.sessions;
    a.clean = ev.clean_count; a.suspect = ev.suspect_count; a.bot = ev.bot_count; a.crawler = ev.crawler_count;
    if (needSess) {
      const sr = await sessionRaw(db, siteId, startTs, endTs, filters);
      a.bounce_num = sr.bounces; a.bounce_den = sr.sessions;
      a.bs_num = sr.bounces_single; a.bs_den = sr.sessions;
      a.dur_num = sr.duration_sum; a.dur_den = sr.sessions;
      a.vdur_num = sr.visit_duration_sum; a.vdur_den = sr.visit_duration_n;
    }
    out.push({ label: b.label, value: metricOf(a, metric), status: statusOf(b) });
  }
  return out;
}

/** Per-day accumulators over the period: rollup for past days, live today. */
async function dailyAccs(db: D1Database, siteId: string, period: Period): Promise<Map<string, Acc>> {
  const split = hybridSplit(period);
  const map = new Map<string, Acc>();
  if (split.hasPast) {
    const rows = await db.prepare(`
      SELECT day, pv, uv, sessions, bounce_rate, bounce_rate_single, avg_duration_ms, visit_duration_ms, clean_count, suspect_count, bot_count, crawler_count
      FROM rollup_site_daily WHERE site_id = ? AND day BETWEEN ? AND ?
    `).bind(siteId, split.pastStart, split.pastEnd).all<{
      day: string; pv: number; uv: number; sessions: number; bounce_rate: number | null; bounce_rate_single: number | null;
      avg_duration_ms: number | null; visit_duration_ms: number | null;
      clean_count: number; suspect_count: number; bot_count: number; crawler_count: number;
    }>();
    for (const r of rows.results) {
      const a = emptyAcc();
      a.pv = r.pv; a.uv = r.uv; a.sessions = r.sessions;
      a.clean = r.clean_count; a.suspect = r.suspect_count; a.bot = r.bot_count; a.crawler = r.crawler_count;
      if (r.bounce_rate != null) { a.bounce_num = r.bounce_rate * r.sessions; a.bounce_den = r.sessions; }
      if (r.bounce_rate_single != null) { a.bs_num = r.bounce_rate_single * r.sessions; a.bs_den = r.sessions; }
      if (r.avg_duration_ms != null) { a.dur_num = r.avg_duration_ms * r.sessions; a.dur_den = r.sessions; }
      if (r.visit_duration_ms != null) { a.vdur_num = r.visit_duration_ms * r.sessions; a.vdur_den = r.sessions; }
      map.set(r.day, a);
    }
  }
  if (split.today) {
    const ev = await eventsSiteAgg(db, siteId, split.today.startTs, split.today.endTs);
    const sr = await sessionRaw(db, siteId, split.today.startTs, split.today.endTs);
    const a = emptyAcc();
    a.pv = ev.pv; a.uv = ev.uv; a.sessions = ev.sessions;
    a.clean = ev.clean_count; a.suspect = ev.suspect_count; a.bot = ev.bot_count; a.crawler = ev.crawler_count;
    a.bounce_num = sr.bounces; a.bounce_den = sr.sessions; a.bs_num = sr.bounces_single; a.bs_den = sr.sessions;
    a.dur_num = sr.duration_sum; a.dur_den = sr.sessions;
    a.vdur_num = sr.visit_duration_sum; a.vdur_den = sr.visit_duration_n;
    map.set(split.today.day, a);
  }
  return map;
}

/** Bucket key + label for a day string under a day/week/month interval. */
function bucketKey(day: string, interval: string): [string, string] {
  if (interval === 'month') return [day.slice(0, 7), day.slice(0, 7)];
  if (interval === 'week') {
    const [y, m, d] = day.split('-').map(Number);
    const mon = addDays(y, m - 1, d, -weekdayMon0(y, m - 1, d));
    const key = dayStr(mon.y, mon.m0, mon.d);
    return [key, key.slice(5)];
  }
  return [day, day.slice(5)]; // day → MM-DD
}

/** Local-time label for a minute/hour bucket start instant. */
function subDayLabel(instant: number, tz: string, interval: string, withDate: boolean): string {
  const p: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  } as Intl.DateTimeFormatOptions).formatToParts(new Date(instant))) p[part.type] = part.value;
  const hm = interval === 'minute' ? `${p.hour}:${p.minute}` : `${p.hour}:00`;
  return withDate ? `${p.month}-${p.day} ${hm}` : hm;
}

// ---------------------------------------------------------------------------
// GET /sites/:id/breakdown?dim=page|source|utm_campaign|country|device  (live)
// ---------------------------------------------------------------------------

export async function breakdown(db: D1Database, siteId: string, dim: string, period: Period, limit: number, key: string | null = null, filters: Filter[] = []) {
  limit = Math.min(Math.max(Number.isFinite(limit) ? limit : 20, 1), 100); // NaN → default, not a 500
  // active filters narrow every row; the grouped dim itself is excluded so the
  // list still shows all of its values within the other filters.
  const ef = evFilter(filters, dim);
  const sf = seFilter(filters, dim);

  // referrer drill-down: the specific referring URLs behind ONE source (the
  // `key`), from the live sessions table. '(direct)' means no referrer.
  if (dim === 'referrer') {
    const direct = key === '(direct)' || key == null || key === '';
    const rows = await db.prepare(`
      SELECT COALESCE(NULLIF(referrer, ''), '(none)') AS key,
        COALESCE(SUM(pageviews), 0) AS pv,
        COUNT(DISTINCT visitor_id) AS uv,
        COUNT(*) AS sessions,
        COALESCE(SUM(CASE WHEN verdict NOT IN ('bot','crawler') THEN pageviews ELSE 0 END), 0) AS pv_clean
      FROM sessions
      WHERE site_id = ? AND started_at >= ? AND started_at < ?
        AND ${direct ? 'source IS NULL' : 'source = ?'}
      GROUP BY 1 ORDER BY sessions DESC LIMIT ?
    `).bind(...(direct ? [siteId, period.startTs, period.endTs, limit] : [siteId, period.startTs, period.endTs, key, limit])).all();
    return { dim, key, rows: rows.results };
  }

  // page: pv/uv/clean from raw events; bounces from the live sessions table,
  // attributed to (entry_host, entry_page) — matched strictly so a shared path
  // on multiple hosts isn't double-counted.
  if (dim === 'page') {
    const tables = await eventTables(db, period.startTs, period.endTs);
    if (tables.length === 0) return { dim, rows: [] };
    const u = unionOver(tables, 'event, visitor_id, session_id, verdict, hostname, path, duration_ms', siteId, period.startTs, period.endTs, ef.sql, ef.binds);
    const res = await db.prepare(`
      SELECT hostname, path,
        COALESCE(SUM(event = 'pageview'), 0) AS pv,
        COUNT(DISTINCT CASE WHEN event = 'pageview' THEN visitor_id END) AS uv,
        COUNT(DISTINCT CASE WHEN event = 'pageview' THEN session_id END) AS sessions,
        COALESCE(SUM(event = 'pageview' AND verdict NOT IN ('bot','crawler')), 0) AS pv_clean,
        COUNT(DISTINCT CASE WHEN event = 'pageview' AND verdict NOT IN ('bot','crawler') THEN visitor_id END) AS uv_clean,
        COALESCE(SUM(CASE WHEN event = 'page_leave' THEN COALESCE(duration_ms, 0) ELSE 0 END), 0) AS total_duration_ms
      FROM (${u.sql})
      GROUP BY hostname, path ORDER BY pv DESC LIMIT ?
    `).bind(...u.binds, limit).all<Record<string, unknown> & { hostname: string; path: string }>();

    const bounceRows = await db.prepare(`
      SELECT entry_host AS hostname, entry_page AS path, COUNT(*) AS bounces
      FROM sessions
      WHERE site_id = ? AND is_bounce = 1 AND started_at >= ? AND started_at < ?${sf.sql ? ` AND ${sf.sql}` : ''}
      GROUP BY entry_host, entry_page
    `).bind(siteId, period.startTs, period.endTs, ...sf.binds).all<{ hostname: string; path: string; bounces: number }>();
    const bmap = new Map(bounceRows.results.map((r) => [`${r.hostname} ${r.path}`, r.bounces]));
    const rows = res.results.map((r) => ({ ...r, bounces: bmap.get(`${r.hostname} ${r.path}`) ?? 0 }));
    return { dim, rows };
  }

  // source / campaign: from the live sessions table (session-level attribution)
  if (dim === 'source' || dim === 'utm_campaign') {
    const keyExpr = dim === 'source' ? "COALESCE(source, '(direct)')" : "COALESCE(campaign, '')";
    const rows = await db.prepare(`
      SELECT ${keyExpr} AS key,
        COALESCE(SUM(pageviews), 0) AS pv,
        COUNT(DISTINCT visitor_id) AS uv,
        COUNT(*) AS sessions,
        COALESCE(SUM(CASE WHEN verdict NOT IN ('bot','crawler') THEN pageviews ELSE 0 END), 0) AS pv_clean,
        COUNT(DISTINCT CASE WHEN verdict NOT IN ('bot','crawler') THEN visitor_id END) AS uv_clean
      FROM sessions
      WHERE site_id = ? AND started_at >= ? AND started_at < ?
        ${dim === 'utm_campaign' ? "AND campaign IS NOT NULL AND campaign != ''" : ''}${sf.sql ? ` AND ${sf.sql}` : ''}
      GROUP BY key ORDER BY pv DESC LIMIT ?
    `).bind(siteId, period.startTs, period.endTs, ...sf.binds, limit).all();
    return { dim, rows: rows.results };
  }

  // UTM detail + first-touch dimensions, straight from the pageview events
  // (only rows actually tagged with that param; the huge untagged bucket is
  // excluded). utm_source/utm_campaign come from the sessions table above.
  const EVENT_DIMS: Record<string, string> = {
    utm_medium: 'utm_medium', utm_term: 'utm_term', utm_content: 'utm_content',
    ft_source: 'ft_source', ft_medium: 'ft_medium', ft_campaign: 'ft_campaign',
  };
  if (Object.prototype.hasOwnProperty.call(EVENT_DIMS, dim)) {
    const col = EVENT_DIMS[dim];
    const tables = await eventTables(db, period.startTs, period.endTs);
    if (tables.length === 0) return { dim, rows: [] };
    const u = unionOver(tables, `${col} AS k, visitor_id, verdict`, siteId, period.startTs, period.endTs, `event = 'pageview' AND ${col} IS NOT NULL AND ${col} != ''${ef.sql ? ` AND ${ef.sql}` : ''}`, ef.binds);
    const rows = await db.prepare(`
      SELECT k AS key,
             COUNT(*) AS pv,
             COUNT(DISTINCT visitor_id) AS uv,
             COALESCE(SUM(CASE WHEN verdict NOT IN ('bot','crawler') THEN 1 ELSE 0 END), 0) AS pv_clean
      FROM (${u.sql})
      GROUP BY k ORDER BY pv DESC LIMIT ?
    `).bind(...u.binds, limit).all();
    return { dim, rows: rows.results };
  }

  // country / device / browser / os / region / city: raw pageviews, exact
  // cross-month uv via COUNT(DISTINCT). Sub-tab dimensions of the geo/device panels.
  const SIMPLE_EVENT_DIMS: Record<string, string> = {
    country: 'country', device: 'device_type', browser: 'browser',
    os: 'os', region: 'region', city: 'city',
  };
  if (Object.prototype.hasOwnProperty.call(SIMPLE_EVENT_DIMS, dim)) {
    const col = SIMPLE_EVENT_DIMS[dim];
    const tables = await eventTables(db, period.startTs, period.endTs);
    if (tables.length === 0) return { dim, rows: [] };
    const u = unionOver(tables, `${col} AS k, visitor_id, verdict, event`, siteId, period.startTs, period.endTs, ef.sql, ef.binds);
    const rows = await db.prepare(`
      SELECT COALESCE(NULLIF(k, ''), '(unknown)') AS key,
             COALESCE(SUM(event = 'pageview'), 0) AS pv,
             COUNT(DISTINCT CASE WHEN event = 'pageview' THEN visitor_id END) AS uv,
             COALESCE(SUM(event = 'pageview' AND verdict NOT IN ('bot','crawler')), 0) AS pv_clean
      FROM (${u.sql})
      GROUP BY key ORDER BY pv DESC LIMIT ?
    `).bind(...u.binds, limit).all();
    return { dim, rows: rows.results };
  }

  // screen-size buckets (Plausible-style "Size"), from the pageview's viewport width
  if (dim === 'size') {
    const tables = await eventTables(db, period.startTs, period.endTs);
    if (tables.length === 0) return { dim, rows: [] };
    const u = unionOver(tables, 'screen_w, visitor_id, verdict, event', siteId, period.startTs, period.endTs, ef.sql, ef.binds);
    const bucket = `CASE
      WHEN screen_w IS NULL OR screen_w = 0 THEN '(unknown)'
      WHEN screen_w < 576 THEN 'Mobile (< 576px)'
      WHEN screen_w < 992 THEN 'Tablet (576–991px)'
      WHEN screen_w < 1440 THEN 'Laptop (992–1439px)'
      ELSE 'Desktop (≥ 1440px)' END`;
    const rows = await db.prepare(`
      SELECT ${bucket} AS key,
             COALESCE(SUM(event = 'pageview'), 0) AS pv,
             COUNT(DISTINCT CASE WHEN event = 'pageview' THEN visitor_id END) AS uv,
             COALESCE(SUM(event = 'pageview' AND verdict NOT IN ('bot','crawler')), 0) AS pv_clean
      FROM (${u.sql})
      GROUP BY key ORDER BY pv DESC LIMIT ?
    `).bind(...u.binds, limit).all();
    return { dim, rows: rows.results };
  }

  // entry / exit pages: session-level (which page began / ended the visit)
  if (dim === 'entry_page' || dim === 'exit_page') {
    const col = dim === 'entry_page' ? 'entry_page' : 'exit_page';
    const rows = await db.prepare(`
      SELECT COALESCE(NULLIF(${col}, ''), '(unknown)') AS key,
             COALESCE(SUM(pageviews), 0) AS pv,
             COUNT(DISTINCT visitor_id) AS uv,
             COUNT(*) AS sessions,
             COALESCE(SUM(CASE WHEN verdict NOT IN ('bot','crawler') THEN pageviews ELSE 0 END), 0) AS pv_clean
      FROM sessions
      WHERE site_id = ? AND started_at >= ? AND started_at < ?${sf.sql ? ` AND ${sf.sql}` : ''}
      GROUP BY key ORDER BY sessions DESC LIMIT ?
    `).bind(siteId, period.startTs, period.endTs, ...sf.binds, limit).all();
    return { dim, rows: rows.results };
  }

  throw new ApiError(400, `unknown dim: ${dim}`);
}

// ---------------------------------------------------------------------------
// GET /sites/:id/quality — verdict split (live), daily series, fired-flag counts
// ---------------------------------------------------------------------------

export async function quality(db: D1Database, siteId: string, period: Period, filters: Filter[] = []) {
  const ef = evFilter(filters);
  // verdict totals: live from raw events over the whole span
  const ev = await eventsSiteAgg(db, siteId, period.startTs, period.endTs, filters);
  const totals = { clean: ev.clean_count, suspect: ev.suspect_count, bot: ev.bot_count, crawler: ev.crawler_count };

  // daily verdict series (for external api consumers). For a rolling intraday
  // window (24h) each day entry is CLAMPED to the window and computed live, so
  // Σdaily reconciles with totals; otherwise rollup history + live today.
  // filters force live per-day computation (rollups can't be filtered)
  const daily: Array<Record<string, unknown>> = [];
  if (period.subDay || filters.length) {
    for (const day of enumerateDays(period.start, period.end)) {
      const [y, m, d] = day.split('-').map(Number);
      const nxt = addDays(y, m - 1, d, 1);
      const s = Math.max(localMidnightUtc(period.tz, y, m - 1, d), period.startTs);
      const e = Math.min(localMidnightUtc(period.tz, nxt.y, nxt.m0, nxt.d), period.endTs);
      if (e <= s) continue;
      const t = await eventsSiteAgg(db, siteId, s, e, filters);
      daily.push({ day, pv: t.pv, bot_count: t.bot_count, suspect_count: t.suspect_count, crawler_count: t.crawler_count, clean_count: t.clean_count });
    }
  } else {
    const split = hybridSplit(period);
    if (split.hasPast) {
      const rows = await db.prepare(`
        SELECT day, pv, bot_count, suspect_count, crawler_count, clean_count
        FROM rollup_site_daily WHERE site_id = ? AND day BETWEEN ? AND ? ORDER BY day
      `).bind(siteId, split.pastStart, split.pastEnd).all();
      daily.push(...rows.results);
    }
    if (split.today) {
      const t = await eventsSiteAgg(db, siteId, split.today.startTs, split.today.endTs);
      daily.push({ day: split.today.day, pv: t.pv, bot_count: t.bot_count, suspect_count: t.suspect_count, crawler_count: t.crawler_count, clean_count: t.clean_count });
    }
  }

  // which signals fire most (evidence panel, §11.2) — bit-counted in SQL over
  // pageview events only, so they're comparable to the pageview verdict totals.
  const flagCols = ALL_FLAGS.map((n) => `SUM(CASE WHEN bot_flags & ${FLAG[n]} THEN 1 ELSE 0 END) AS ${n}`).join(', ');
  const flags: Record<string, number> = {};
  for (const table of await eventTables(db, period.startTs, period.endTs)) {
    const row = await db.prepare(
      `SELECT ${flagCols} FROM ${table} WHERE site_id = ? AND event = 'pageview' AND ts >= ? AND ts < ?${ef.sql ? ` AND ${ef.sql}` : ''}`,
    ).bind(siteId, period.startTs, period.endTs, ...ef.binds).first<Record<FlagName, number>>();
    for (const n of ALL_FLAGS) flags[n] = (flags[n] ?? 0) + (row?.[n] ?? 0);
  }

  return { totals, daily, flags };
}

// ---------------------------------------------------------------------------
// GET /sites/:id/alerts — rule-based "this data looks wrong" checks over the
// selected period. Self-contained (no external baseline); thresholds from
// config [alerts]. min_pageviews mutes small samples so quiet sites stay quiet.
// ---------------------------------------------------------------------------

const ALERT_DEFAULTS = {
  min_pageviews: 50, invalid_share: 0.30, datacenter_share: 0.25,
  fake_search_share: 0.10, zero_interaction_share: 0.40, bounce_low: 0.05,
  pages_per_visitor_high: 15, source_concentration: 0.60,
};

export interface Alert { id: string; severity: 'warning' | 'critical'; title: string; detail: string; }

export async function alerts(db: D1Database, siteId: string, period: Period, filters: Filter[] = []) {
  const A = { ...ALERT_DEFAULTS, ...(CONFIG.alerts ?? {}) };
  const ev = await eventsSiteAgg(db, siteId, period.startTs, period.endTs, filters);
  const pv = ev.pv;

  // pageview-level flag tallies (datacenter / no-interaction / forged-search),
  // plus a count of search-engine-referred pageviews (the denominator for the
  // "forged share of search traffic" card). The search predicate mirrors the
  // scorer's classifier: google.<tld> / bing / duckduckgo / yahoo / baidu /
  // yandex, but NOT google SUBDOMAINS like accounts./mail. (login, not search).
  const FAKE = FLAG.SEARCH_REF_DATACENTER | FLAG.FORGED_SEARCH_REFERRER;
  const SEARCH_REF = `(ref_domain LIKE 'google.%' OR ref_domain LIKE 'www.google.%'
    OR ref_domain LIKE '%bing.com' OR ref_domain LIKE '%duckduckgo.com'
    OR ref_domain LIKE '%yahoo.com' OR ref_domain LIKE '%baidu.com'
    OR ref_domain LIKE 'yandex.%' OR ref_domain LIKE 'www.yandex.%')`;
  const ef = evFilter(filters);
  let dc = 0, zero = 0, fake = 0, searchPv = 0;
  for (const table of await eventTables(db, period.startTs, period.endTs)) {
    const r = await db.prepare(
      `SELECT COALESCE(SUM(CASE WHEN bot_flags & ${FLAG.DATACENTER_ASN} THEN 1 ELSE 0 END), 0) AS dc,
              COALESCE(SUM(CASE WHEN bot_flags & ${FLAG.ZERO_INTERACTION_NO_LEAVE} THEN 1 ELSE 0 END), 0) AS zero,
              COALESCE(SUM(CASE WHEN bot_flags & ${FAKE} THEN 1 ELSE 0 END), 0) AS fake,
              COALESCE(SUM(CASE WHEN ${SEARCH_REF} THEN 1 ELSE 0 END), 0) AS search_pv
       FROM ${table} WHERE site_id = ? AND event = 'pageview' AND ts >= ? AND ts < ?${ef.sql ? ` AND ${ef.sql}` : ''}`,
    ).bind(siteId, period.startTs, period.endTs, ...ef.binds).first<{ dc: number; zero: number; fake: number; search_pv: number }>();
    dc += r?.dc ?? 0; zero += r?.zero ?? 0; fake += r?.fake ?? 0; searchPv += r?.search_pv ?? 0;
  }

  const stats = {
    pv, search_pv: searchPv, fake_search: fake, datacenter: dc,
    zero_interaction: zero, invalid: ev.suspect_count + ev.bot_count,
  };
  if (pv < A.min_pageviews) return { alerts: [] as Alert[], pv, stats };

  const s = await sessionAgg(db, siteId, period.startTs, period.endTs, filters);
  const sf = seFilter(filters);
  const topSrc = await db.prepare(
    `SELECT source AS key, COUNT(*) AS n FROM sessions
     WHERE site_id = ? AND started_at >= ? AND started_at < ? AND source IS NOT NULL${sf.sql ? ` AND ${sf.sql}` : ''}
     GROUP BY source ORDER BY n DESC LIMIT 1`,
  ).bind(siteId, period.startTs, period.endTs, ...sf.binds).first<{ key: string; n: number }>();

  const out: Alert[] = [];
  const pct = (x: number) => (x * 100).toFixed(1) + '%';
  const sev = (ratio: number): Alert['severity'] => (ratio >= 2 ? 'critical' : 'warning');
  const add = (id: string, ratio: number, title: string, detail: string) => out.push({ id, severity: sev(ratio), title, detail });

  const invalid = (ev.suspect_count + ev.bot_count) / pv;
  if (invalid > A.invalid_share) add('invalid_share', invalid / A.invalid_share,
    'High invalid-traffic share', `${pct(invalid)} of pageviews are bot/suspect (alert above ${pct(A.invalid_share)}).`);

  const dcShare = dc / pv;
  if (dcShare > A.datacenter_share) add('datacenter', dcShare / A.datacenter_share,
    'Lots of datacenter traffic', `${pct(dcShare)} of pageviews come from cloud/hosting IPs (alert above ${pct(A.datacenter_share)}).`);

  const fakeShare = fake / pv;
  if (fakeShare > A.fake_search_share) add('fake_search', fakeShare / A.fake_search_share,
    'Forged search-referrer traffic', `${pct(fakeShare)} of pageviews claim a search referrer but look forged (alert above ${pct(A.fake_search_share)}).`);

  const zeroShare = zero / pv;
  if (zeroShare > A.zero_interaction_share) add('zero_interaction', zeroShare / A.zero_interaction_share,
    'Many no-interaction visits', `${pct(zeroShare)} of pageviews had no click / scroll / leave (alert above ${pct(A.zero_interaction_share)}).`);

  if (s.bounce_rate_single != null && ev.sessions >= 30 && s.bounce_rate_single < A.bounce_low)
    out.push({ id: 'bounce_low', severity: 'warning', title: 'Implausibly low bounce rate',
      detail: `Single-page bounce is only ${pct(s.bounce_rate_single)} — real audiences rarely fall below ${pct(A.bounce_low)}; often automated multi-hit traffic.` });

  const ppv = ev.uv ? pv / ev.uv : 0;
  if (ppv > A.pages_per_visitor_high) add('pages_per_visitor', ppv / A.pages_per_visitor_high,
    'Very high pages per visitor', `${ppv.toFixed(1)} pages/visitor (alert above ${A.pages_per_visitor_high}) — can indicate scraping.`);

  if (topSrc && ev.sessions >= 30) {
    const share = topSrc.n / ev.sessions;
    if (share > A.source_concentration) add('source_concentration', share / A.source_concentration,
      'One source dominates', `“${topSrc.key}” is ${pct(share)} of sessions (alert above ${pct(A.source_concentration)}) — check for referral spam or forged referrers.`);
  }

  return { alerts: out, pv, stats };
}

// ---------------------------------------------------------------------------
// GET /sites/:id/traffic?verdict=&min_score=&limit= — drill-down list (§11.2)
// ---------------------------------------------------------------------------

const VERDICT_BY_RANK: Record<number, string> = { 4: 'bot', 3: 'crawler', 2: 'suspect', 1: 'clean' };

export async function traffic(
  db: D1Database, siteId: string, period: Period,
  opts: { verdict?: string | null; minScore?: number; limit?: number },
  filters: Filter[] = [],
) {
  const limit = Math.min(Math.max(Number.isFinite(opts.limit) ? opts.limit! : 50, 1), 200);
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
  const ef = evFilter(filters);
  if (ef.sql) { conds.push(ef.sql); binds.push(...ef.binds); }

  // Aggregate by VISITOR (not per event): worst score/verdict, OR'd evidence
  // flags (bits are disjoint, so Σ MAX(flags & bit) = bitwise OR), event/session
  // counts, and a representative agent. Group per month table, then merge the
  // same visitor across months in the isolate.
  const flagsOr = ALL_FLAGS.map((n) => `MAX(bot_flags & ${FLAG[n]})`).join(' + ');
  type V = {
    visitor_id: string; events: number; sessions: number; bot_score: number;
    flags_or: number; verdict_rank: number; last_ts: number; first_ts: number;
    country: string | null; browser: string | null; os: string | null; asn_type: string | null; path: string | null;
  };
  const acc = new Map<string, V>();
  for (const table of await eventTables(db, period.startTs, period.endTs)) {
    const rows = await db.prepare(`
      SELECT visitor_id,
        COUNT(*) AS events,
        COUNT(DISTINCT session_id) AS sessions,
        MAX(bot_score) AS bot_score,
        (${flagsOr}) AS flags_or,
        MAX(CASE verdict WHEN 'bot' THEN 4 WHEN 'crawler' THEN 3 WHEN 'suspect' THEN 2 ELSE 1 END) AS verdict_rank,
        MAX(ts) AS last_ts, MIN(ts) AS first_ts,
        MAX(country) AS country, MAX(browser) AS browser, MAX(os) AS os,
        MAX(asn_type) AS asn_type, MAX(path) AS path
      FROM ${table} WHERE ${conds.join(' AND ')}
      GROUP BY visitor_id ORDER BY bot_score DESC LIMIT ?
    `).bind(...binds, limit).all<V>();
    for (const r of rows.results) {
      const p = acc.get(r.visitor_id);
      if (!p) { acc.set(r.visitor_id, r); continue; }
      p.events += r.events; p.sessions += r.sessions;
      p.bot_score = Math.max(p.bot_score, r.bot_score);
      p.flags_or |= r.flags_or;
      p.verdict_rank = Math.max(p.verdict_rank, r.verdict_rank);
      if (r.last_ts > p.last_ts) { p.last_ts = r.last_ts; p.path = r.path; }
      p.first_ts = Math.min(p.first_ts, r.first_ts);
      p.country ??= r.country; p.browser ??= r.browser; p.os ??= r.os; p.asn_type ??= r.asn_type;
    }
  }
  const rows = [...acc.values()]
    .sort((a, b) => b.bot_score - a.bot_score || b.last_ts - a.last_ts)
    .slice(0, limit)
    .map((v) => ({
      visitor_id: v.visitor_id, events: v.events, sessions: v.sessions,
      bot_score: v.bot_score, bot_flags: v.flags_or, verdict: VERDICT_BY_RANK[v.verdict_rank] ?? 'clean',
      last_ts: v.last_ts, first_ts: v.first_ts,
      country: v.country, browser: v.browser, os: v.os, asn_type: v.asn_type, path: v.path,
    }));
  return { rows };
}

// ---------------------------------------------------------------------------
// GET /sites/:id/visitors?path=&limit= — visitor finder (journey entry point)
// ---------------------------------------------------------------------------

const VERDICT_OF_RANK: Record<number, string> = { 1: 'clean', 2: 'suspect', 3: 'crawler', 4: 'bot' };

/** Visitors active in the period, newest activity first. With `path`, only
 *  visitors who had a pageview on that path (exact match; trailing '*' =
 *  prefix) — answers "who opened the payment page?" — and the aggregates then
 *  cover just the matching events. Verdict shown is the visitor's worst. */
export async function visitorsList(
  db: D1Database, siteId: string, period: Period,
  opts: { path?: string | null; limit?: number },
) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const tables = await eventTables(db, period.startTs, period.endTs);
  if (tables.length === 0) return { path: opts.path ?? null, rows: [] };

  let pathCond = '';
  const pathBinds: unknown[] = [];
  if (opts.path) {
    if (opts.path.endsWith('*')) {
      pathCond = " AND path LIKE ? || '%'";
      pathBinds.push(opts.path.slice(0, -1));
    } else {
      pathCond = ' AND path = ?';
      pathBinds.push(opts.path);
    }
  }
  const parts = tables.map((t) =>
    `SELECT visitor_id, session_id, event, verdict, country, device_type, ts FROM ${t}
     WHERE site_id = ? AND ts >= ? AND ts < ?${pathCond}`);
  const binds = tables.flatMap(() => [siteId, period.startTs, period.endTs, ...pathBinds]);

  const rows = await db.prepare(`
    SELECT visitor_id,
      COALESCE(SUM(event = 'pageview'), 0) AS pv,
      COUNT(DISTINCT session_id) AS sessions,
      MIN(ts) AS first_ts, MAX(ts) AS last_ts,
      MAX(CASE verdict WHEN 'bot' THEN 4 WHEN 'crawler' THEN 3 WHEN 'suspect' THEN 2 ELSE 1 END) AS vrank,
      MAX(country) AS country, MAX(device_type) AS device_type
    FROM (${parts.join(' UNION ALL ')})
    GROUP BY visitor_id
    HAVING pv > 0
    ORDER BY last_ts DESC LIMIT ?
  `).bind(...binds, limit).all<Record<string, unknown> & { vrank: number }>();

  return {
    path: opts.path ?? null,
    rows: rows.results.map(({ vrank, ...r }) => ({ ...r, verdict: VERDICT_OF_RANK[vrank] ?? 'clean' })),
  };
}

// ---------------------------------------------------------------------------
// GET /sites/:id/visitors/:vid/profile
// ---------------------------------------------------------------------------

/** Event-trail cap for the journey timeline (newest first). */
const PROFILE_EVENTS_MAX = 300;

export async function visitorProfile(db: D1Database, siteId: string, vid: string, period: Period) {
  const profile = await db.prepare(
    'SELECT * FROM visitor_profiles WHERE site_id = ? AND visitor_id = ?',
  ).bind(siteId, vid).first();

  const sessions = await db.prepare(`
    SELECT session_id, entry_page, exit_page, pageviews, duration_ms, had_interaction,
           is_bounce, source, medium, campaign, bot_score, verdict, started_at, last_active_at
    FROM sessions WHERE site_id = ? AND visitor_id = ? ORDER BY started_at DESC LIMIT 50
  `).bind(siteId, vid).all();

  // session_id groups the timeline; hostname disambiguates multi-domain sites;
  // props carries custom-event payloads (e.g. revenue) for display.
  const events: unknown[] = [];
  for (const table of (await eventTables(db, period.startTs, period.endTs)).reverse()) {
    if (events.length >= PROFILE_EVENTS_MAX) break;
    const rows = await db.prepare(`
      SELECT ts, event, session_id, hostname, path, referrer, duration_ms, scroll_depth,
             had_interaction, props, bot_score, verdict, bot_flags, score_stage
      FROM ${table} WHERE site_id = ? AND visitor_id = ? ORDER BY ts DESC LIMIT ?
    `).bind(siteId, vid, PROFILE_EVENTS_MAX - events.length).all();
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
