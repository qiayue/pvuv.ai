/**
 * Crawler / indexing signals (migration 0024) — a SEPARATE metric.
 *
 * Answers "has Googlebot (Bing, …) come yet, how often, which pages" for a
 * newly launched site, durably: raw crawler events are trimmed early by
 * retention (bot_events_days), so first-seen has to be recorded as it happens.
 *
 * Two sources, each written by the job that already owns its data:
 *   beacon — crawler pageviews (crawlers that render JS), recomputed for the
 *            site's local today (+ yesterday while it can still change) by the
 *            hourly rollup, from the crawler_engine stamped at ingest.
 *   edge   — Cloudflare's top user agents per local day, classified when the
 *            daily edge pull stores them (optional; needs the CF token). Sees
 *            crawlers that never run JavaScript.
 *
 * Idempotent: a (site, day, source) is rewritten whole on every pass, and the
 * milestones are merged with MIN/MAX, so re-running any step changes nothing.
 * Every entry point is wrapped by its caller — a failure here can never cost a
 * site its PV/UV rollup or the edge pull, and NOTHING here is read by scoring,
 * verdicts, PV/UV or the ad-guard decision.
 */

import type { Env } from './index';
import { localYMD, localDaySpan, addDays, dayStr } from '../../../shared/tz';
import { classifyCrawler, kindForEngine, otherEngine, type CrawlerKind } from '../../../shared/crawlers';
import { matchBot, type BotEntry } from '../../../shared/botdir';
import { monthSuffix, eventsTableName } from '../../../shared/events';

/** Paths stored per engine per day. A new site's crawl is a few dozen pages;
 *  the cap only bounds a large site being swept. `pages` keeps the true count. */
const MAX_PAGES_PER_ENGINE_DAY = 50;

/** One aggregated (engine, category, path) group of beacon crawler pageviews. */
export interface BeaconGroup {
  engine: string | null;
  bot_category: string | null;
  path: string;
  hits: number;
  first_ts: number;
  last_ts: number;
}

interface EngineDay {
  kind: CrawlerKind;
  hits: number;
  first_ts: number;
  last_ts: number;
  first_path: string | null;
  paths: Map<string, number>;
}

/** Fold grouped beacon rows into per-engine totals for one day. Rows written
 *  before ingest stamped an engine (crawler_engine NULL) fall back to their
 *  bot_category, i.e. to an other_<kind> bucket. */
export function foldBeacon(groups: BeaconGroup[]): Map<string, EngineDay> {
  const out = new Map<string, EngineDay>();
  for (const g of groups) {
    let engine = g.engine;
    let kind: CrawlerKind;
    if (engine) {
      kind = kindForEngine(engine, g.bot_category);
    } else {
      const c = classifyCrawler(null, g.bot_category);
      engine = c?.engine ?? otherEngine('other');
      kind = c?.kind ?? 'other';
    }
    let e = out.get(engine);
    if (!e) {
      e = { kind, hits: 0, first_ts: g.first_ts, last_ts: g.last_ts, first_path: g.path, paths: new Map() };
      out.set(engine, e);
    }
    e.hits += g.hits;
    if (g.first_ts < e.first_ts) { e.first_ts = g.first_ts; e.first_path = g.path; }
    if (g.last_ts > e.last_ts) e.last_ts = g.last_ts;
    e.paths.set(g.path, (e.paths.get(g.path) ?? 0) + g.hits);
  }
  return out;
}

function milestoneUpsert(
  db: D1Database, siteId: string, engine: string, kind: string,
  firstAt: number, lastAt: number, source: 'beacon' | 'edge', firstPath: string | null, now: number,
): D1PreparedStatement {
  // SET expressions all see the OLD row (SQLite assigns simultaneously), so the
  // CASEs compare against the stored first_seen_at before MIN() lowers it.
  return db.prepare(`
    INSERT INTO crawler_milestones (site_id, engine, kind, first_seen_at, last_seen_at, first_source, first_path, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(site_id, engine) DO UPDATE SET
      kind = excluded.kind,
      first_source = CASE WHEN excluded.first_seen_at < crawler_milestones.first_seen_at
                          THEN excluded.first_source ELSE crawler_milestones.first_source END,
      first_path = CASE WHEN excluded.first_seen_at < crawler_milestones.first_seen_at THEN excluded.first_path
                        WHEN excluded.first_seen_at = crawler_milestones.first_seen_at
                          THEN COALESCE(crawler_milestones.first_path, excluded.first_path)
                        ELSE crawler_milestones.first_path END,
      first_seen_at = MIN(crawler_milestones.first_seen_at, excluded.first_seen_at),
      last_seen_at = MAX(crawler_milestones.last_seen_at, excluded.last_seen_at),
      updated_at = excluded.updated_at
  `).bind(siteId, engine, kind, firstAt, lastAt, source, firstPath, now);
}

/** Existing monthly partitions covering a UTC [start, end) span. */
function tablesFor(startTs: number, endTs: number, existing: Set<string>): string[] {
  const months = new Set([monthSuffix(startTs), monthSuffix(endTs - 1)]);
  return [...months].map(eventsTableName).filter((t) => existing.has(t));
}

/**
 * Recompute the beacon crawler rows for one (site, local day). Called by the
 * hourly rollup right after rollupSiteDay, from the same raw partitions.
 */
export async function rollupCrawlerDay(
  db: D1Database, siteId: string, day: string, startTs: number, endTs: number, existing: Set<string>,
): Promise<number> {
  const tables = tablesFor(startTs, endTs, existing);
  if (tables.length === 0) return 0;
  // crawler_engine is set by ingest for every crawler-class event; verdict =
  // 'crawler' additionally picks up rows recorded before it existed
  const parts = tables.map((t) => `
    SELECT crawler_engine AS engine, bot_category, path, ts FROM ${t}
    WHERE site_id = ? AND event = 'pageview' AND ts >= ? AND ts < ?
      AND (crawler_engine IS NOT NULL OR verdict = 'crawler')`);
  const binds = tables.flatMap(() => [siteId, startTs, endTs]);
  const rows = await db.prepare(`
    SELECT engine, bot_category, path, COUNT(*) AS hits, MIN(ts) AS first_ts, MAX(ts) AS last_ts
    FROM (${parts.join(' UNION ALL ')})
    GROUP BY engine, bot_category, path
  `).bind(...binds).all<BeaconGroup>();
  if (rows.results.length === 0) return 0; // nothing crawled: nothing to write or undo

  const engines = foldBeacon(rows.results);
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [
    db.prepare("DELETE FROM rollup_crawler_daily WHERE site_id = ? AND day = ? AND source = 'beacon'").bind(siteId, day),
    db.prepare('DELETE FROM rollup_crawler_page_daily WHERE site_id = ? AND day = ?').bind(siteId, day),
  ];
  for (const [engine, e] of engines) {
    stmts.push(db.prepare(`
      INSERT INTO rollup_crawler_daily (site_id, day, engine, source, kind, hits, pages, first_ts, last_ts)
      VALUES (?, ?, ?, 'beacon', ?, ?, ?, ?, ?)
    `).bind(siteId, day, engine, e.kind, e.hits, e.paths.size, e.first_ts, e.last_ts));
    const top = [...e.paths].sort((a, b) => b[1] - a[1]).slice(0, MAX_PAGES_PER_ENGINE_DAY);
    for (const [path, hits] of top) {
      stmts.push(db.prepare(
        'INSERT INTO rollup_crawler_page_daily (site_id, day, engine, path, hits) VALUES (?, ?, ?, ?, ?)',
      ).bind(siteId, day, engine, path, hits));
    }
    stmts.push(milestoneUpsert(db, siteId, engine, e.kind, e.first_ts, e.last_ts, 'beacon', e.first_path, now));
  }
  await db.batch(stmts);
  return engines.size;
}

/**
 * Classify one local day of Cloudflare's top user agents and store the
 * crawler share of it. Browsers are skipped (classifyCrawler → null); the
 * owner-imported directory, when present, supplies the kind for agents the
 * built-in list does not know. Edge data is day-granular, so an edge-sourced
 * first/last seen is the start of that local day.
 */
export async function recordEdgeCrawlerDay(
  db: D1Database, siteId: string, day: string, dayStartTs: number,
  agents: Array<{ userAgent: string; requests: number }>, directory: BotEntry[] = [],
): Promise<number> {
  const engines = new Map<string, { kind: CrawlerKind; hits: number }>();
  for (const a of agents) {
    const c = classifyCrawler(a.userAgent, matchBot(a.userAgent, directory)?.category ?? null);
    if (!c || !(a.requests > 0)) continue;
    const e = engines.get(c.engine);
    if (e) e.hits += a.requests;
    else engines.set(c.engine, { kind: c.kind, hits: a.requests });
  }
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [
    // replace, same as the agent table it derives from: a re-pull is authoritative
    db.prepare("DELETE FROM rollup_crawler_daily WHERE site_id = ? AND day = ? AND source = 'edge'").bind(siteId, day),
  ];
  for (const [engine, e] of engines) {
    stmts.push(db.prepare(`
      INSERT INTO rollup_crawler_daily (site_id, day, engine, source, kind, hits, pages, first_ts, last_ts)
      VALUES (?, ?, ?, 'edge', ?, ?, NULL, ?, ?)
    `).bind(siteId, day, engine, e.kind, e.hits, dayStartTs, dayStartTs));
    stmts.push(milestoneUpsert(db, siteId, engine, e.kind, dayStartTs, dayStartTs, 'edge', null, now));
  }
  await db.batch(stmts);
  return engines.size;
}

/** The owner-imported bot directory, as the console stores it. Empty when
 *  none was imported (or the settings table is missing) — never throws. */
export async function loadBotDirectory(db: D1Database): Promise<BotEntry[]> {
  try {
    const r = await db.prepare('SELECT value FROM instance_settings WHERE key = ?')
      .bind('bot_directory').first<{ value: string }>();
    const v = r?.value ? JSON.parse(r.value) : [];
    return Array.isArray(v) ? v as BotEntry[] : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// one-time backfill from data already present
// ---------------------------------------------------------------------------

export const CRAWLER_BACKFILL_FLAG = 'crawler_backfill_done_v24';
const CRAWLER_BACKFILL_CURSOR = 'crawler_backfill_cursor_v24';
/** Sites per run — each costs one query per local day of retained crawler
 *  data, so the sweep is spread over hourly runs and checkpointed. */
const BACKFILL_SITES_PER_RUN = 10;
/** Upper bound on days walked back per site (raw crawler rows are trimmed at
 *  bot_events_days anyway; this only guards "keep forever" deployments). */
const BACKFILL_MAX_DAYS = 400;

const readSetting = async (db: D1Database, key: string): Promise<string | null> => {
  const r = await db.prepare('SELECT value FROM instance_settings WHERE key = ?').bind(key).first<{ value: string }>();
  return r?.value ?? null;
};
const writeSetting = (db: D1Database, key: string, value: string): Promise<unknown> => db.prepare(`
  INSERT INTO instance_settings (key, value, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
`).bind(key, value, Date.now()).run();

/**
 * Fill the crawler tables from what is already stored: retained crawler
 * events (beacon) and every rollup_edge_agent_daily day (edge). Resumable by
 * site; sets a done flag once a run finds no site left. Safe to run alongside
 * the regular jobs because every write it makes is the same idempotent write
 * they make.
 */
export async function backfillCrawlersOnce(env: Env, existing: Set<string>, now = Date.now()): Promise<void> {
  let cursor: string;
  try {
    if (await readSetting(env.DB, CRAWLER_BACKFILL_FLAG) === '1') return;
    cursor = await readSetting(env.DB, CRAWLER_BACKFILL_CURSOR) ?? '';
    await env.DB.prepare('SELECT 1 FROM crawler_milestones LIMIT 1').first(); // 0024 applied?
  } catch { return; }

  const sites = await env.DB.prepare(`
    SELECT site_id, COALESCE(timezone, 'UTC') AS timezone FROM sites
    WHERE site_id > ? ORDER BY site_id LIMIT ?
  `).bind(cursor, BACKFILL_SITES_PER_RUN).all<{ site_id: string; timezone: string }>();
  const directory = sites.results.length ? await loadBotDirectory(env.DB) : [];

  for (const site of sites.results) {
    const tz = site.timezone || 'UTC';
    try {
      // beacon: walk local days from the oldest retained crawler event
      let oldest = Infinity;
      for (const t of existing) {
        const r = await env.DB.prepare(
          `SELECT MIN(ts) AS ts FROM ${t} WHERE site_id = ? AND verdict = 'crawler'`,
        ).bind(site.site_id).first<{ ts: number | null }>();
        if (r?.ts != null && r.ts < oldest) oldest = r.ts;
      }
      if (Number.isFinite(oldest)) {
        const today = localYMD(now, tz);
        let ymd = localYMD(oldest, tz);
        for (let i = 0; i < BACKFILL_MAX_DAYS; i++) {
          const span = localDaySpan(tz, ymd.y, ymd.m0, ymd.d);
          await rollupCrawlerDay(env.DB, site.site_id, span.day, span.startTs, span.endTs, existing);
          if (span.day >= dayStr(today.y, today.m0, today.d)) break;
          ymd = addDays(ymd.y, ymd.m0, ymd.d, 1);
        }
      }

      // edge: every stored agent day
      const edgeRows = await env.DB.prepare(
        'SELECT day, user_agent, requests FROM rollup_edge_agent_daily WHERE site_id = ? ORDER BY day',
      ).bind(site.site_id).all<{ day: string; user_agent: string; requests: number }>();
      const byDay = new Map<string, Array<{ userAgent: string; requests: number }>>();
      for (const r of edgeRows.results) {
        const list = byDay.get(r.day) ?? [];
        list.push({ userAgent: r.user_agent, requests: r.requests });
        byDay.set(r.day, list);
      }
      for (const [day, agents] of byDay) {
        const [y, m, d] = day.split('-').map(Number);
        if (!y || !m || !d) continue;
        await recordEdgeCrawlerDay(env.DB, site.site_id, day, localDaySpan(tz, y, m - 1, d).startTs, agents, directory);
      }
    } catch (err) {
      // one site's history must not wedge the sweep for every later site
      console.error(`crawlers: backfill failed for ${site.site_id}`, err);
    }
    cursor = site.site_id;
  }

  if (sites.results.length < BACKFILL_SITES_PER_RUN) {
    await writeSetting(env.DB, CRAWLER_BACKFILL_FLAG, '1');
    console.log('crawlers: 0024 backfill complete');
  } else {
    await writeSetting(env.DB, CRAWLER_BACKFILL_CURSOR, cursor);
    console.log(`crawlers: 0024 backfill progress → ${cursor}`);
  }
}
