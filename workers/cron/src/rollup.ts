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
import { SESSION_IDLE_MS } from '../../../shared/ids';
import { FLAG, FAKE_SEARCH_MASK, searchRefDomainSql } from '../../../shared/flags';
import { monthSuffix, eventsTableName, eventsIndexDDL, RESERVED_EVENTS_SQL } from '../../../shared/events';

export async function runHourlyRollup(env: Env): Promise<void> {
  const now = Date.now();
  await backfillHotColumnsOnce(env); // one-time; no-op after the first run
  const existing = await existingEventTables(env.DB);
  // A session is "closed" (no further interaction/leave can arrive) once it has
  // been idle past the session window — only then is "no page_leave" final.
  const idleCutoff = now - SESSION_IDLE_MS;

  const sites = await env.DB
    .prepare("SELECT site_id, COALESCE(timezone, 'UTC') AS timezone FROM sites WHERE status = 'active'")
    .all<{ site_id: string; timezone: string }>();

  for (const site of sites.results) {
    const tz = site.timezone || 'UTC';
    const t = localYMD(now, tz);
    const yday = addDays(t.y, t.m0, t.d, -1);
    for (const ymd of [t, yday]) {
      const span = localDaySpan(tz, ymd.y, ymd.m0, ymd.d);
      await rollupSiteDay(env.DB, site.site_id, span.day, span.startTs, span.endTs, existing, idleCutoff);
    }
  }
}

const BACKFILL_FLAG = 'rollup_hotcols_backfilled_v12';
const BACKFILL_CURSOR = 'rollup_hotcols_cursor_v12';
/** Max (site, day) rows rebuilt per hourly run — keeps the one-time backfill
 *  well inside a cron invocation's budget on deployments with many site-days.
 *  Progress is checkpointed, so it resumes on the next run instead of redoing
 *  the whole sweep (and never finishing). */
const BACKFILL_DAYS_PER_RUN = 60;

const readSetting = async (db: D1Database, key: string): Promise<string | null> => {
  const r = await db.prepare('SELECT value FROM instance_settings WHERE key = ?').bind(key).first<{ value: string }>();
  return r?.value ?? null;
};
const writeSetting = (db: D1Database, key: string, value: string): Promise<unknown> => db.prepare(`
  INSERT INTO instance_settings (key, value, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
`).bind(key, value, Date.now()).run();

/** One-time, guarded maintenance for migration 0012:
 *
 *  1. Create the new (site_id, event, ts) index on EVERY existing month
 *     partition. The migration can only name the initial month, and the
 *     consumer only issues DDL for months it is actively writing — so
 *     back-months would otherwise never gain the index and keep full-scanning.
 *  2. Backfill the eight new rollup_site_daily columns. ALTER TABLE ADD COLUMN
 *     defaults them to 0 on existing rows and the hourly job only revisits
 *     today+yesterday, so without this alerts/adguard would undercount every
 *     older day. Rewrites ONLY those eight columns (never pv/uv/bounce/sources).
 *
 *  Retention-safe: a day whose raw partition was already dropped is skipped and
 *  stays 0 — exactly what the old raw scan produced for a missing partition.
 *  Resumable: work is capped per run and the cursor is checkpointed; the done
 *  flag is set only once a run finds nothing left to do. */
async function backfillHotColumnsOnce(env: Env): Promise<void> {
  let cursor: string;
  try {
    if (await readSetting(env.DB, BACKFILL_FLAG) === '1') return;
    cursor = await readSetting(env.DB, BACKFILL_CURSOR) ?? '';
  } catch { return; } // instance_settings not present → skip quietly

  const existing = await existingEventTables(env.DB);

  // 1. bring every existing partition's indexes up to date (idempotent)
  if (!cursor) {
    for (const table of existing) {
      const suffix = table.slice('events_'.length);
      try {
        await env.DB.batch(eventsIndexDDL(suffix).map((sql) => env.DB.prepare(sql)));
      } catch (err) {
        console.error(`rollup: index ensure failed for ${table}`, err);
      }
    }
  }

  // 2. backfill the new columns, resuming after the cursor, capped per run.
  //    Ordering by (site_id, day) makes "> cursor" a stable resume point.
  const rows = await env.DB.prepare(`
    SELECT r.site_id AS site_id, r.day AS day, COALESCE(s.timezone, 'UTC') AS timezone
    FROM rollup_site_daily r LEFT JOIN sites s ON s.site_id = r.site_id
    WHERE r.site_id || '|' || r.day > ?
    ORDER BY r.site_id, r.day LIMIT ?
  `).bind(cursor, BACKFILL_DAYS_PER_RUN).all<{ site_id: string; day: string; timezone: string }>();

  for (const row of rows.results) {
    const [y, m, d] = row.day.split('-').map(Number);
    if (y && m && d) {
      const span = localDaySpan(row.timezone || 'UTC', y, m - 1, d);
      const tables = tablesForSpan(span.startTs, span.endTs, existing);
      if (tables.length > 0) { // else raw dropped by retention → leave 0
        const tallyParts = tables.map((tb) =>
          `SELECT event, bot_flags, ref_domain FROM ${tb} WHERE site_id = ? AND ts >= ? AND ts < ?`);
        const tallyBinds = tables.flatMap(() => [row.site_id, span.startTs, span.endTs]);
        await env.DB.batch([
          env.DB.prepare(`
            UPDATE rollup_site_daily SET (dc_pv, zero_pv, fake_pv, search_ref_pv) = (
              SELECT ${HOT_TALLY_SQL} FROM (${tallyParts.join(' UNION ALL ')})
            ) WHERE site_id = ? AND day = ?
          `).bind(...tallyBinds, row.site_id, row.day),
          engagedUpdate(env.DB, tables, row.site_id, span.startTs, span.endTs, row.day),
        ]);
      }
    }
    cursor = `${row.site_id}|${row.day}`;
  }

  if (rows.results.length < BACKFILL_DAYS_PER_RUN) {
    await writeSetting(env.DB, BACKFILL_FLAG, '1'); // caught up — never run again
    console.log('rollup: 0012 hot-column backfill complete');
  } else {
    await writeSetting(env.DB, BACKFILL_CURSOR, cursor);
    console.log(`rollup: 0012 backfill progress → ${cursor}`);
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

// Hot flag-tally SUM expressions over pageview rows (dc_pv, zero_pv, fake_pv,
// search_ref_pv, in column order) — shared by the rollup INSERT and the one-time
// backfill so the two can never drift. Must mirror the alerts scan exactly.
// COALESCE so a day with no matching rows stores 0 rather than NULL (the
// backfill's subquery yields a single all-NULL row when a site had no traffic).
const HOT_TALLY_SQL =
  `COALESCE(SUM(CASE WHEN event = 'pageview' AND (bot_flags & ${FLAG.DATACENTER_ASN}) != 0 THEN 1 ELSE 0 END), 0),
   COALESCE(SUM(CASE WHEN event = 'pageview' AND (bot_flags & ${FLAG.ZERO_INTERACTION_NO_LEAVE}) != 0 THEN 1 ELSE 0 END), 0),
   COALESCE(SUM(CASE WHEN event = 'pageview' AND (bot_flags & ${FAKE_SEARCH_MASK}) != 0 THEN 1 ELSE 0 END), 0),
   COALESCE(SUM(CASE WHEN event = 'pageview' AND ${searchRefDomainSql('ref_domain')} THEN 1 ELSE 0 END), 0)`;

/** Row-value UPDATE that fills rollup_site_daily's four per-verdict engaged-
 *  pageview columns for one (site, day) in a single events↔sessions scan. Used
 *  by the hourly rollup and the one-time backfill. */
function engagedUpdate(db: D1Database, tables: string[], siteId: string, startTs: number, endTs: number, day: string): D1PreparedStatement {
  const parts = tables.map((tb) =>
    `SELECT site_id, session_id, verdict FROM ${tb} WHERE site_id = ? AND event = 'pageview' AND ts >= ? AND ts < ?`);
  const binds = tables.flatMap(() => [siteId, startTs, endTs]);
  return db.prepare(`
    UPDATE rollup_site_daily SET
      (clean_eng_pv, suspect_eng_pv, bot_eng_pv, crawler_eng_pv) = (
        SELECT
          COALESCE(SUM(CASE WHEN e.verdict = 'clean'   THEN 1 ELSE 0 END), 0),
          COALESCE(SUM(CASE WHEN e.verdict = 'suspect' THEN 1 ELSE 0 END), 0),
          COALESCE(SUM(CASE WHEN e.verdict = 'bot'     THEN 1 ELSE 0 END), 0),
          COALESCE(SUM(CASE WHEN e.verdict = 'crawler' THEN 1 ELSE 0 END), 0)
        FROM (${parts.join(' UNION ALL ')}) e
        JOIN sessions s ON s.site_id = e.site_id AND s.session_id = e.session_id
        WHERE s.had_interaction = 1
      )
    WHERE site_id = ? AND day = ?
  `).bind(...binds, siteId, day);
}

export async function rollupSiteDay(
  db: D1Database, siteId: string, day: string, startTs: number, endTs: number, existing: Set<string>,
  idleCutoff = 0,
): Promise<void> {
  const tables = tablesForSpan(startTs, endTs, existing);
  if (tables.length === 0) return; // no events partition for this day yet

  const stmts: D1PreparedStatement[] = [];

  // --- session-layer behavioral flag (§6.2 0x0040, §6.3) -------------------
  // Mark the pageviews of CLOSED sessions that had zero interaction AND never
  // sent page_leave (duration stays 0) — the most basic "pulled the page but
  // behaved like nothing" bot tell, only knowable once the session is over.
  // Evidence/reporting only: the realtime scorer already separates these via
  // the WITHHELD has_interaction / has_page_leave trust credits (§6.2), so we
  // deliberately do NOT touch bot_score or verdict here (no double penalty).
  // Idempotent — the (bot_flags & FLAG) = 0 guard writes each event at most once.
  for (const tbl of tables) {
    stmts.push(db.prepare(`
      UPDATE ${tbl} SET bot_flags = bot_flags | ${FLAG.ZERO_INTERACTION_NO_LEAVE}
      WHERE site_id = ? AND event = 'pageview' AND ts >= ? AND ts < ?
        AND (bot_flags & ${FLAG.ZERO_INTERACTION_NO_LEAVE}) = 0
        AND verdict != 'crawler'
        AND session_id IN (
          SELECT session_id FROM sessions s
          WHERE s.site_id = ? AND s.had_interaction = 0
            AND COALESCE(s.duration_ms, 0) = 0
            AND COALESCE(s.last_pageview_at, s.started_at) < ?
        )
    `).bind(siteId, startTs, endTs, siteId, idleCutoff));
  }

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
  const siteEv = eventSpan(tables, 'site_id, event, visitor_id, session_id, verdict, revenue_usd, bot_flags, ref_domain', siteId, startTs, endTs);
  stmts.push(db.prepare(`
    INSERT OR REPLACE INTO rollup_site_daily
      (site_id, day, pv, uv, sessions, bounce_rate, avg_duration_ms, visit_duration_ms,
       bot_count, suspect_count, crawler_count, clean_count, conversions, revenue_usd,
       dc_pv, zero_pv, fake_pv, search_ref_pv)
    SELECT site_id, ?,
      SUM(event = 'pageview'),
      COUNT(DISTINCT CASE WHEN event = 'pageview' THEN visitor_id END),
      COUNT(DISTINCT CASE WHEN event = 'pageview' THEN session_id END),
      NULL, NULL, NULL,
      SUM(event = 'pageview' AND verdict = 'bot'),
      SUM(event = 'pageview' AND verdict = 'suspect'),
      SUM(event = 'pageview' AND verdict = 'crawler'),
      SUM(event = 'pageview' AND verdict = 'clean'),
      -- conversions/revenue: custom (goal) events from non-bot/crawler traffic
      SUM(CASE WHEN event NOT IN (${RESERVED_EVENTS_SQL}) AND verdict NOT IN ('bot','crawler') THEN 1 ELSE 0 END),
      COALESCE(SUM(CASE WHEN verdict NOT IN ('bot','crawler') THEN revenue_usd ELSE 0 END), 0),
      -- hot flag tallies (shared HOT_TALLY_SQL — mirrors the alerts scan). bot_flags
      -- already carries the zero-interaction bit set earlier in this same batch.
      ${HOT_TALLY_SQL}
    FROM ${siteEv.sql}
    GROUP BY site_id
  `).bind(day, ...siteEv.binds));

  // per-verdict engaged pageviews (session had a real interaction) — powers the
  // adguard fp_rate without the per-period events↔sessions JOIN on dashboard
  // load. INSERT OR REPLACE above reset these to 0; recompute them here (runs
  // after, in the same ordered batch).
  stmts.push(engagedUpdate(db, tables, siteId, startTs, endTs, day));

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
      ),
      -- Plausible/UA visit duration: last−first pageview per session, exit page
      -- and single-page visits count as 0 (last_pageview_at = started_at → 0).
      -- Sessions predating migration 0010 have NULL last_pageview_at (unknown) —
      -- AVG skips them rather than counting them as 0 and diluting the average.
      visit_duration_ms = (
        SELECT CAST(AVG(CASE WHEN s.last_pageview_at IS NOT NULL
                             THEN s.last_pageview_at - s.started_at END) AS INTEGER)
        FROM sessions s WHERE s.site_id = ? AND s.started_at >= ? AND s.started_at < ?
      )
    WHERE site_id = ? AND day = ?
  `).bind(siteId, startTs, endTs, siteId, startTs, endTs, siteId, startTs, endTs, siteId, startTs, endTs, siteId, day));

  await db.batch(stmts);
}
