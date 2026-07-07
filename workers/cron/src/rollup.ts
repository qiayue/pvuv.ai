/**
 * Hourly rollup (PROJECT_PLAN.md §9.1, §9.3, §18.4).
 *
 * Recomputes the current UTC day's rollup_page_daily / rollup_source_daily /
 * rollup_site_daily from raw events + sessions (idempotent INSERT OR REPLACE
 * keyed by the tables' primary keys — safe to run every hour). The first
 * runs after midnight also recompute yesterday to absorb late events.
 *
 * Clean bucket = verdict NOT IN ('bot','crawler') (§9.3: suspect is counted
 * but flagged; dashboards default to clean and can switch).
 */

import type { Env } from './index';

export async function runHourlyRollup(env: Env): Promise<void> {
  const now = new Date();
  const days = [dayStr(now)];
  if (now.getUTCHours() < 2) days.push(dayStr(new Date(now.getTime() - 86400e3)));

  for (const day of days) {
    await rollupDay(env.DB, day);
  }
}

function dayStr(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

async function rollupDay(db: D1Database, day: string): Promise<void> {
  const table = `events_${day.slice(0, 7).replace('-', '')}`;
  const exists = await db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?")
    .bind(table)
    .first();
  if (!exists) return;

  // day filter on the indexed ts column (UTC midnight bounds), not strftime()
  const start = Date.parse(`${day}T00:00:00Z`);
  const end = start + 86400e3;

  const stmts: D1PreparedStatement[] = [];

  // --- rollup_page_daily ---------------------------------------------------
  stmts.push(db.prepare(`
    INSERT OR REPLACE INTO rollup_page_daily
      (site_id, day, hostname, path, pv, uv, sessions, bounces, total_duration_ms, pv_clean, uv_clean)
    SELECT site_id, ?1, hostname, path,
      SUM(event = 'pageview'),
      COUNT(DISTINCT CASE WHEN event = 'pageview' THEN visitor_id END),
      COUNT(DISTINCT CASE WHEN event = 'pageview' THEN session_id END),
      0,
      SUM(CASE WHEN event = 'page_leave' THEN COALESCE(duration_ms, 0) ELSE 0 END),
      SUM(event = 'pageview' AND verdict NOT IN ('bot','crawler')),
      COUNT(DISTINCT CASE WHEN event = 'pageview' AND verdict NOT IN ('bot','crawler') THEN visitor_id END)
    FROM ${table}
    WHERE ts >= ?2 AND ts < ?3
    GROUP BY site_id, hostname, path
  `).bind(day, start, end));

  // bounces are a session-level fact attributed to the entry page (§9.3)
  stmts.push(db.prepare(`
    UPDATE rollup_page_daily SET bounces = (
      SELECT COUNT(*) FROM sessions s
      WHERE s.site_id = rollup_page_daily.site_id
        AND s.entry_page = rollup_page_daily.path
        AND s.is_bounce = 1
        AND s.started_at >= ?2 AND s.started_at < ?3
    )
    WHERE day = ?1
  `).bind(day, start, end));

  // --- rollup_source_daily (session-attributed dimensions) ------------------
  stmts.push(db.prepare(`
    INSERT OR REPLACE INTO rollup_source_daily
      (site_id, day, source, medium, campaign, pv, uv, sessions, conversions, revenue_usd, pv_clean, uv_clean)
    SELECT site_id, ?1,
      COALESCE(source, '(direct)'), COALESCE(medium, ''), COALESCE(campaign, ''),
      SUM(pageviews),
      COUNT(DISTINCT visitor_id),
      COUNT(*),
      0, 0,
      SUM(CASE WHEN verdict NOT IN ('bot','crawler') THEN pageviews ELSE 0 END),
      COUNT(DISTINCT CASE WHEN verdict NOT IN ('bot','crawler') THEN visitor_id END)
    FROM sessions
    WHERE started_at >= ?2 AND started_at < ?3
    GROUP BY site_id, COALESCE(source, '(direct)'), COALESCE(medium, ''), COALESCE(campaign, '')
  `).bind(day, start, end));

  // --- rollup_site_daily -----------------------------------------------------
  // event-derived totals + verdict split (pageview events, §11.3 crawler kept
  // separate from bot share)
  stmts.push(db.prepare(`
    INSERT OR REPLACE INTO rollup_site_daily
      (site_id, day, pv, uv, sessions, bounce_rate, avg_duration_ms,
       bot_count, suspect_count, crawler_count, clean_count, conversions, revenue_usd)
    SELECT site_id, ?1,
      SUM(event = 'pageview'),
      COUNT(DISTINCT CASE WHEN event = 'pageview' THEN visitor_id END),
      COUNT(DISTINCT CASE WHEN event = 'pageview' THEN session_id END),
      NULL, NULL,
      SUM(event = 'pageview' AND verdict = 'bot'),
      SUM(event = 'pageview' AND verdict = 'suspect'),
      SUM(event = 'pageview' AND verdict = 'crawler'),
      SUM(event = 'pageview' AND verdict = 'clean'),
      0, 0
    FROM ${table}
    WHERE ts >= ?2 AND ts < ?3
    GROUP BY site_id
  `).bind(day, start, end));

  // session-derived metrics (bounce rate §9.3 inverse definition, avg dwell)
  stmts.push(db.prepare(`
    UPDATE rollup_site_daily SET
      bounce_rate = (
        SELECT ROUND(AVG(CASE WHEN s.is_bounce = 1 THEN 1.0 ELSE 0.0 END), 4)
        FROM sessions s
        WHERE s.site_id = rollup_site_daily.site_id
          AND s.started_at >= ?2 AND s.started_at < ?3
      ),
      avg_duration_ms = (
        SELECT CAST(AVG(s.duration_ms) AS INTEGER)
        FROM sessions s
        WHERE s.site_id = rollup_site_daily.site_id
          AND s.started_at >= ?2 AND s.started_at < ?3
      )
    WHERE day = ?1
  `).bind(day, start, end));

  await db.batch(stmts);
}
