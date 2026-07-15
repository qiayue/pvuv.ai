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
import { localYMD, localMidnightUtc, localDaySpan, addDays, weekdayMon0, dayStr } from '../../../shared/tz';
import { monthSuffix } from '../../../shared/events';

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
function unionOver(tables: string[], cols: string, siteId: string, startTs: number, endTs: number):
  { sql: string; binds: unknown[] } {
  const parts = tables.map((t) => `SELECT ${cols} FROM ${t} WHERE site_id = ? AND ts >= ? AND ts < ?`);
  return { sql: parts.join(' UNION ALL '), binds: tables.flatMap(() => [siteId, startTs, endTs]) };
}

/** Site-level pageview aggregates over a UTC span, live from raw events.
 *  Mirrors the rollup's definitions exactly (clean = verdict NOT bot/crawler). */
interface SiteAgg {
  pv: number; uv: number; sessions: number;
  clean_count: number; suspect_count: number; bot_count: number; crawler_count: number;
}
async function eventsSiteAgg(db: D1Database, siteId: string, startTs: number, endTs: number): Promise<SiteAgg> {
  const zero: SiteAgg = { pv: 0, uv: 0, sessions: 0, clean_count: 0, suspect_count: 0, bot_count: 0, crawler_count: 0 };
  const tables = await eventTables(db, startTs, endTs);
  if (tables.length === 0) return zero;
  const u = unionOver(tables, 'event, visitor_id, session_id, verdict', siteId, startTs, endTs);
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

/** Session-derived bounce rate + avg dwell over a UTC span (live sessions table). */
async function sessionAgg(db: D1Database, siteId: string, startTs: number, endTs: number):
  Promise<{ bounce_rate: number | null; avg_duration_ms: number | null }> {
  const row = await db.prepare(`
    SELECT
      ROUND(AVG(CASE WHEN is_bounce = 1 THEN 1.0 ELSE 0.0 END), 4) AS bounce_rate,
      CAST(AVG(duration_ms) AS INTEGER) AS avg_duration_ms
    FROM sessions WHERE site_id = ? AND started_at >= ? AND started_at < ?
  `).bind(siteId, startTs, endTs).first<{ bounce_rate: number | null; avg_duration_ms: number | null }>();
  return row ?? { bounce_rate: null, avg_duration_ms: null };
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

export async function overview(db: D1Database, siteId: string, period: Period) {
  const ev = await eventsSiteAgg(db, siteId, period.startTs, period.endTs);
  const s = await sessionAgg(db, siteId, period.startTs, period.endTs);
  return {
    period: { start: period.start, end: period.end },
    pv: ev.pv, uv: ev.uv, sessions: ev.sessions,
    bounce_rate: s.bounce_rate, avg_duration_ms: s.avg_duration_ms,
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
  'pv', 'uv', 'sessions', 'bounce_rate', 'avg_duration_ms', 'pv_per_visitor',
  'bot_count', 'suspect_count', 'crawler_count', 'clean_count',
]);
const TS_INTERVALS = new Set(['minute', 'hour', 'day', 'week', 'month']);
const RATE_METRICS = new Set(['bounce_rate', 'avg_duration_ms', 'pv_per_visitor']);

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
  bounce_num: number; bounce_den: number; dur_num: number; dur_den: number;
  clean: number; suspect: number; bot: number; crawler: number;
}
const emptyAcc = (): Acc => ({ pv: 0, uv: 0, sessions: 0, bounce_num: 0, bounce_den: 0, dur_num: 0, dur_den: 0, clean: 0, suspect: 0, bot: 0, crawler: 0 });
function addAcc(dst: Acc, s: Acc): void {
  dst.pv += s.pv; dst.uv += s.uv; dst.sessions += s.sessions;
  dst.bounce_num += s.bounce_num; dst.bounce_den += s.bounce_den;
  dst.dur_num += s.dur_num; dst.dur_den += s.dur_den;
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
    case 'avg_duration_ms': return a.dur_den ? Math.round(a.dur_num / a.dur_den) : null;
    case 'pv_per_visitor': return a.uv ? Math.round((a.pv / a.uv) * 100) / 100 : null;
    default: return 0;
  }
}

/** Raw session counts over a span (exact bounce/dwell numerators). */
async function sessionRaw(db: D1Database, siteId: string, startTs: number, endTs: number):
  Promise<{ sessions: number; bounces: number; duration_sum: number }> {
  const r = await db.prepare(`
    SELECT COUNT(*) AS sessions, COALESCE(SUM(is_bounce), 0) AS bounces, COALESCE(SUM(duration_ms), 0) AS duration_sum
    FROM sessions WHERE site_id = ? AND started_at >= ? AND started_at < ?
  `).bind(siteId, startTs, endTs).first<{ sessions: number; bounces: number; duration_sum: number }>();
  return r ?? { sessions: 0, bounces: 0, duration_sum: 0 };
}

/**
 * Metric-over-time series. `interval` controls the bucket size and defaults to
 * 'day'. minute/hour buckets are computed live from raw events + sessions;
 * day/week/month are built from the daily rollup (past) + live today, then
 * regrouped. Every metric (incl. derived pv_per_visitor) is supported.
 */
export async function timeseries(db: D1Database, siteId: string, metric: string, period: Period, interval = 'day') {
  if (!TS_METRICS.has(metric)) throw new ApiError(400, `unknown metric: ${metric}`);
  if (!TS_INTERVALS.has(interval)) throw new ApiError(400, `unknown interval: ${interval}`);
  const points = interval === 'minute' || interval === 'hour'
    ? await subDaySeries(db, siteId, period, interval, metric)
    : await calendarSeries(db, siteId, period, interval, metric);
  return { metric, interval, points };
}

/** minute/hour buckets, live from raw events (+ sessions for rate metrics). */
async function subDaySeries(db: D1Database, siteId: string, period: Period, interval: string, metric: string) {
  const step = interval === 'minute' ? 60_000 : 3_600_000;
  const n = Math.round((period.endTs - period.startTs) / step);
  if (n > 2000) throw new ApiError(400, 'range too large for this interval');
  const accs = Array.from({ length: n }, emptyAcc);

  const tables = await eventTables(db, period.startTs, period.endTs);
  if (tables.length) {
    const u = unionOver(tables, 'event, visitor_id, session_id, verdict, ts', siteId, period.startTs, period.endTs);
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

  if (metric === 'bounce_rate' || metric === 'avg_duration_ms') {
    const rows = await db.prepare(`
      SELECT CAST((started_at - ?) / ? AS INTEGER) AS b,
        COUNT(*) AS sc, COALESCE(SUM(is_bounce), 0) AS bc, COALESCE(SUM(duration_ms), 0) AS ds
      FROM sessions WHERE site_id = ? AND started_at >= ? AND started_at < ? GROUP BY b
    `).bind(period.startTs, step, siteId, period.startTs, period.endTs).all<{ b: number; sc: number; bc: number; ds: number }>();
    for (const r of rows.results) {
      const a = accs[r.b];
      if (a) { a.bounce_num = r.bc; a.bounce_den = r.sc; a.dur_num = r.ds; a.dur_den = r.sc; }
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

/** day/week/month buckets from rollup history + live today. */
async function calendarSeries(db: D1Database, siteId: string, period: Period, interval: string, metric: string) {
  const t = localYMD(period.now, period.tz);
  const today = dayStr(t.y, t.m0, t.d);
  const daily = await dailyAccs(db, siteId, period);
  const buckets = new Map<string, { label: string; acc: Acc; min: string; max: string }>();
  for (const day of enumerateDays(period.start, period.end)) {
    const [key, label] = bucketKey(day, interval);
    let bk = buckets.get(key);
    if (!bk) { bk = { label, acc: emptyAcc(), min: day, max: day }; buckets.set(key, bk); }
    bk.max = day; // enumerateDays is chronological
    addAcc(bk.acc, daily.get(day) ?? emptyAcc());
  }
  // Map preserves insertion order, and enumerateDays is chronological.
  // A bucket that spans today is still filling; one entirely after today is future.
  return [...buckets.values()].map((b) => ({
    label: b.label,
    value: metricOf(b.acc, metric),
    status: b.max < today ? 'complete' : (b.min > today ? 'future' : 'partial'),
  }));
}

/** Per-day accumulators over the period: rollup for past days, live today. */
async function dailyAccs(db: D1Database, siteId: string, period: Period): Promise<Map<string, Acc>> {
  const split = hybridSplit(period);
  const map = new Map<string, Acc>();
  if (split.hasPast) {
    const rows = await db.prepare(`
      SELECT day, pv, uv, sessions, bounce_rate, avg_duration_ms, clean_count, suspect_count, bot_count, crawler_count
      FROM rollup_site_daily WHERE site_id = ? AND day BETWEEN ? AND ?
    `).bind(siteId, split.pastStart, split.pastEnd).all<{
      day: string; pv: number; uv: number; sessions: number; bounce_rate: number | null; avg_duration_ms: number | null;
      clean_count: number; suspect_count: number; bot_count: number; crawler_count: number;
    }>();
    for (const r of rows.results) {
      const a = emptyAcc();
      a.pv = r.pv; a.uv = r.uv; a.sessions = r.sessions;
      a.clean = r.clean_count; a.suspect = r.suspect_count; a.bot = r.bot_count; a.crawler = r.crawler_count;
      if (r.bounce_rate != null) { a.bounce_num = r.bounce_rate * r.sessions; a.bounce_den = r.sessions; }
      if (r.avg_duration_ms != null) { a.dur_num = r.avg_duration_ms * r.sessions; a.dur_den = r.sessions; }
      map.set(r.day, a);
    }
  }
  if (split.today) {
    const ev = await eventsSiteAgg(db, siteId, split.today.startTs, split.today.endTs);
    const sr = await sessionRaw(db, siteId, split.today.startTs, split.today.endTs);
    const a = emptyAcc();
    a.pv = ev.pv; a.uv = ev.uv; a.sessions = ev.sessions;
    a.clean = ev.clean_count; a.suspect = ev.suspect_count; a.bot = ev.bot_count; a.crawler = ev.crawler_count;
    a.bounce_num = sr.bounces; a.bounce_den = sr.sessions; a.dur_num = sr.duration_sum; a.dur_den = sr.sessions;
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

export async function breakdown(db: D1Database, siteId: string, dim: string, period: Period, limit: number) {
  limit = Math.min(Math.max(limit, 1), 100);

  // page: pv/uv/clean from raw events; bounces from the live sessions table,
  // attributed to (entry_host, entry_page) — matched strictly so a shared path
  // on multiple hosts isn't double-counted.
  if (dim === 'page') {
    const tables = await eventTables(db, period.startTs, period.endTs);
    if (tables.length === 0) return { dim, rows: [] };
    const u = unionOver(tables, 'event, visitor_id, session_id, verdict, hostname, path, duration_ms', siteId, period.startTs, period.endTs);
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
      WHERE site_id = ? AND is_bounce = 1 AND started_at >= ? AND started_at < ?
      GROUP BY entry_host, entry_page
    `).bind(siteId, period.startTs, period.endTs).all<{ hostname: string; path: string; bounces: number }>();
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
        ${dim === 'utm_campaign' ? "AND campaign IS NOT NULL AND campaign != ''" : ''}
      GROUP BY key ORDER BY pv DESC LIMIT ?
    `).bind(siteId, period.startTs, period.endTs, limit).all();
    return { dim, rows: rows.results };
  }

  // country / device: raw pageviews, exact cross-month uv via COUNT(DISTINCT)
  if (dim === 'country' || dim === 'device') {
    const col = dim === 'country' ? 'country' : 'device_type';
    const tables = await eventTables(db, period.startTs, period.endTs);
    if (tables.length === 0) return { dim, rows: [] };
    const u = unionOver(tables, `${col} AS k, visitor_id, verdict, event`, siteId, period.startTs, period.endTs);
    const rows = await db.prepare(`
      SELECT COALESCE(k, '(unknown)') AS key,
             COALESCE(SUM(event = 'pageview'), 0) AS pv,
             COUNT(DISTINCT CASE WHEN event = 'pageview' THEN visitor_id END) AS uv,
             COALESCE(SUM(event = 'pageview' AND verdict NOT IN ('bot','crawler')), 0) AS pv_clean
      FROM (${u.sql})
      GROUP BY key ORDER BY pv DESC LIMIT ?
    `).bind(...u.binds, limit).all();
    return { dim, rows: rows.results };
  }

  throw new ApiError(400, `unknown dim: ${dim}`);
}

// ---------------------------------------------------------------------------
// GET /sites/:id/quality — verdict split (live), daily series, fired-flag counts
// ---------------------------------------------------------------------------

export async function quality(db: D1Database, siteId: string, period: Period) {
  // verdict totals: live from raw events over the whole span
  const ev = await eventsSiteAgg(db, siteId, period.startTs, period.endTs);
  const totals = { clean: ev.clean_count, suspect: ev.suspect_count, bot: ev.bot_count, crawler: ev.crawler_count };

  // daily verdict series: rollup history + live today (for external api consumers)
  const split = hybridSplit(period);
  const daily: Array<Record<string, unknown>> = [];
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

  // which signals fire most (evidence panel, §11.2) — bit-counted in SQL over
  // pageview events only, so they're comparable to the pageview verdict totals.
  const flagCols = ALL_FLAGS.map((n) => `SUM(CASE WHEN bot_flags & ${FLAG[n]} THEN 1 ELSE 0 END) AS ${n}`).join(', ');
  const flags: Record<string, number> = {};
  for (const table of await eventTables(db, period.startTs, period.endTs)) {
    const row = await db.prepare(
      `SELECT ${flagCols} FROM ${table} WHERE site_id = ? AND event = 'pageview' AND ts >= ? AND ts < ?`,
    ).bind(siteId, period.startTs, period.endTs).first<Record<FlagName, number>>();
    for (const n of ALL_FLAGS) flags[n] = (flags[n] ?? 0) + (row?.[n] ?? 0);
  }

  return { totals, daily, flags };
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
  for (const table of await eventTables(db, period.startTs, period.endTs)) {
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
  for (const table of (await eventTables(db, period.startTs, period.endTs)).reverse()) {
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
