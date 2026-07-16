/**
 * Hourly rollup (PROJECT_PLAN.md §9.1, §9.3, §18.4).
 *
 * Recomputes each site's rollup_page_daily / rollup_source_daily /
 * rollup_site_daily for its recent LOCAL calendar days, from raw events +
 * sessions. Every rollup row's `day` is the site's local day (in the site's
 * fixed timezone), because unique-visitor counts can't be re-bucketed into a
 * different timezone after the fact — so the timezone is chosen at site
 * creation and the daily buckets follow it.
 *
 * Idempotent (INSERT OR REPLACE keyed by the tables' primary keys), so it is
 * safe to run hourly. Each run recomputes the site's local today + yesterday
 * to keep the current day fresh and settle the just-closed day. A local day's
 * UTC span can straddle a month boundary, so events are read from a UNION of
 * the covering monthly partitions.
 *
 * Clean bucket = verdict NOT IN ('bot','crawler') (§9.3).
 */

import type { Env } from './index';
import { localYMD, localDaySpan, addDays } from '../../../shared/tz';
import { monthSuffix, eventsTableName } from '../../../shared/events';

export async function runHourlyRollup(env: Env): Promise<void> {
  const now = Date.now();
  const existing = await existingEventTables(env.DB);

  const sites = await env.DB
    .prepare("SELECT site_id, COALESCE(timezone, 'UTC') AS timezone FROM sites WHERE status = 'active'")
    .all<{ site_id: string; timezone: string }>();

  for (const site of sites.results) {
    const tz = site.timezone || 'UTC';
    const t = localYMD(now, tz);
    const yday = addDays(t.y, t.m0, t.d, -1);
    for (const ymd of [t, yday]) {
      const span = localDaySpan(tz, ymd.y, ymd.m0, ymd.d);
      await rollupSiteDay(env.DB, site.site_id, span.day, span.startTs, span.endTs, existing);
    }
  }
}

/** All existing events_YYYYMM partitions. */
export async function existingEventTables(db: D1Database): Promise<Set<string>> {
  const rows = await db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'events_[0-9][0-9][0-9][0-9][0-9][0-9]'")
    .all<{ name: string }>();
  return new Set(rows.results.map((r) => r.name));
}

/** Monthly partitions covering a UTC [start, end) span that actually exist. */
function tablesForSpan(startTs: number, endTs: number, existing: Set<string>): string[] {
  const months = new Set([monthSuffix(startTs), monthSuffix(endTs - 1)]);
  return [...months].map(eventsTableName).filter((t) => existing.has(t));
}

/** A UNION-ALL subquery over the span's partitions, scoped to one site. */
function eventSpan(tables: string[], cols: string, siteId: string, startTs: number, endTs: number):
  { sql: string; binds: unknown[] } {
  const parts = tables.map((t) => `SELECT ${cols} FROM ${t} WHERE site_id = ? AND ts >= ? AND ts < ?`);
  return { sql: `(${parts.join(' UNION ALL ')})`, binds: tables.flatMap(() => [siteId, startTs, endTs]) };
}

export async function rollupSiteDay(
  db: D1Database, siteId: string, day: string, startTs: number, endTs: number, existing: Set<string>,
): Promise<void> {
  const tables = tablesForSpan(startTs, endTs, existing);
  if (tables.length === 0) return; // no events partition for this day yet

  const stmts: D1PreparedStatement[] = [];

  // --- rollup_page_daily ---------------------------------------------------
  const pageEv = eventSpan(tables, 'site_id, event, visitor_id, session_id, verdict, hostname, path, duration_ms', siteId, startTs, endTs);
  stmts.push(db.prepare(`
    INSERT OR REPLACE INTO rollup_page_daily
      (site_id, day, hostname, path, pv, uv, sessions, bounces, total_duration_ms, pv_clean, uv_clean)
    SELECT site_id, ?, hostname, path,
      SUM(event = 'pageview'),
      COUNT(DISTINCT CASE WHEN event = 'pageview' THEN visitor_id END),
      COUNT(DISTINCT CASE WHEN event = 'pageview' THEN session_id END),
      0,
      SUM(CASE WHEN event = 'page_leave' THEN COALESCE(duration_ms, 0) ELSE 0 END),
      SUM(event = 'pageview' AND verdict NOT IN ('bot','crawler')),
      COUNT(DISTINCT CASE WHEN event = 'pageview' AND verdict NOT IN ('bot','crawler') THEN visitor_id END)
    FROM ${pageEv.sql}
    GROUP BY site_id, hostname, path
  `).bind(day, ...pageEv.binds));

  // bounces: session-level, attributed to (hostname, entry_page); scoped to
  // this site + local day. Match hostname strictly — a NULL entry_host (only
  // possible for legacy pre-0003 sessions) is NOT matched to every hostname
  // row, which would double-count a shared path across hostnames.
  stmts.push(db.prepare(`
    UPDATE rollup_page_daily SET bounces = (
      SELECT COUNT(*) FROM sessions s
      WHERE s.site_id = rollup_page_daily.site_id
        AND s.entry_page = rollup_page_daily.path
        AND s.entry_host = rollup_page_daily.hostname
        AND s.is_bounce = 1
        AND s.started_at >= ? AND s.started_at < ?
    )
    WHERE site_id = ? AND day = ?
  `).bind(startTs, endTs, siteId, day));

  // --- rollup_source_daily (from sessions) ---------------------------------
  stmts.push(db.prepare(`
    INSERT OR REPLACE INTO rollup_source_daily
      (site_id, day, source, medium, campaign, pv, uv, sessions, conversions, revenue_usd, pv_clean, uv_clean)
    SELECT site_id, ?,
      COALESCE(source, '(direct)'), COALESCE(medium, ''), COALESCE(campaign, ''),
      SUM(pageviews),
      COUNT(DISTINCT visitor_id),
      COUNT(*),
      0, 0,
      SUM(CASE WHEN verdict NOT IN ('bot','crawler') THEN pageviews ELSE 0 END),
      COUNT(DISTINCT CASE WHEN verdict NOT IN ('bot','crawler') THEN visitor_id END)
    FROM sessions
    WHERE site_id = ? AND started_at >= ? AND started_at < ?
    GROUP BY site_id, COALESCE(source, '(direct)'), COALESCE(medium, ''), COALESCE(campaign, '')
  `).bind(day, siteId, startTs, endTs));

  // --- rollup_site_daily ---------------------------------------------------
  const siteEv = eventSpan(tables, 'site_id, event, visitor_id, session_id, verdict', siteId, startTs, endTs);
  stmts.push(db.prepare(`
    INSERT OR REPLACE INTO rollup_site_daily
      (site_id, day, pv, uv, sessions, bounce_rate, avg_duration_ms,
       bot_count, suspect_count, crawler_count, clean_count, conversions, revenue_usd)
    SELECT site_id, ?,
      SUM(event = 'pageview'),
      COUNT(DISTINCT CASE WHEN event = 'pageview' THEN visitor_id END),
      COUNT(DISTINCT CASE WHEN event = 'pageview' THEN session_id END),
      NULL, NULL,
      SUM(event = 'pageview' AND verdict = 'bot'),
      SUM(event = 'pageview' AND verdict = 'suspect'),
      SUM(event = 'pageview' AND verdict = 'crawler'),
      SUM(event = 'pageview' AND verdict = 'clean'),
      0, 0
    FROM ${siteEv.sql}
    GROUP BY site_id
  `).bind(day, ...siteEv.binds));

  // session-derived metrics (bounce rate §9.3, avg dwell). Two bounce rates:
  // GA4 engagement-based (is_bounce) and single-page (UA/Plausible style).
  stmts.push(db.prepare(`
    UPDATE rollup_site_daily SET
      bounce_rate = (
        SELECT ROUND(AVG(CASE WHEN s.is_bounce = 1 THEN 1.0 ELSE 0.0 END), 4)
        FROM sessions s WHERE s.site_id = ? AND s.started_at >= ? AND s.started_at < ?
      ),
      bounce_rate_single = (
        SELECT ROUND(AVG(CASE WHEN s.pageviews <= 1 THEN 1.0 ELSE 0.0 END), 4)
        FROM sessions s WHERE s.site_id = ? AND s.started_at >= ? AND s.started_at < ?
      ),
      avg_duration_ms = (
        SELECT CAST(AVG(s.duration_ms) AS INTEGER)
        FROM sessions s WHERE s.site_id = ? AND s.started_at >= ? AND s.started_at < ?
      )
    WHERE site_id = ? AND day = ?
  `).bind(siteId, startTs, endTs, siteId, startTs, endTs, siteId, startTs, endTs, siteId, day));

  await db.batch(stmts);
}
