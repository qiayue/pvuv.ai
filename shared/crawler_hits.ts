/**
 * Server-side crawler reporting (migration 0025) — the `server` source of the
 * crawler / indexing metric, next to `beacon` and `edge`.
 *
 * A site served by a Worker (e.g. a site launcher) sees every crawler
 * request, including the many crawlers that never run the tracking script. It
 * reports them with POST /v1/sites/:id/crawler_hits, authenticated by a
 * site-scoped, ingest-only token (POST /v1/sites/:id/tokens).
 *
 * HARD RULE: these hits are written ONLY to the crawler tables
 * (rollup_crawler_daily source='server', rollup_crawler_server_page_daily,
 * crawler_milestones). They never touch events_*, sessions, PV/UV rollups,
 * scoring, verdicts or the ad-guard decision.
 *
 * Cost model: every crawler hit on every reporting site calls this, so one
 * request is one token+site point read and ONE batched set of upserts —
 * grouped per (day, engine) and (day, engine, path), never a row per hit.
 */

import { classifyCrawler, type CrawlerKind } from './crawlers';
import { localYMD, dayStr } from './tz';

// The slice of D1 used here, typed structurally: shared/ is also compiled by
// the SDK's tsconfig, which has no Workers types. D1Database satisfies these.
/** Any D1-like database; S is its prepared-statement type (D1PreparedStatement). */
type Db<S> = { prepare(sql: string): { bind(...values: unknown[]): S } };

/** Per-request limits (documented in docs/API.md §6). */
export const CRAWLER_HITS_MAX_PER_REQUEST = 100;
export const CRAWLER_HITS_MAX_BODY_BYTES = 64 * 1024;
export const CRAWLER_HIT_MAX_PATH = 512;
export const CRAWLER_HIT_MAX_UA = 512;
/** A hit older than this is ignored (a stale retry queue must not rewrite history). */
export const CRAWLER_HIT_MAX_AGE_MS = 48 * 3600e3;
/** Distinct paths stored per engine per local day for the server source. The
 *  daily hit count is always exact; paths past the cap are just not listed. */
export const MAX_SERVER_PAGES_PER_ENGINE_DAY = 200;
/** Live ingest tokens one site may hold — POST /tokens mints a new one per call. */
export const MAX_INGEST_TOKENS_PER_SITE = 20;

export type CrawlerSource = 'beacon' | 'edge' | 'server';

/**
 * Normalize a reported path: absolute URLs reduce to their path; the query
 * string and fragment are DROPPED (they explode cardinality and can carry
 * session ids / tokens); must start with '/'; capped at 512 chars. Null when
 * unusable.
 */
export function normalizeHitPath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let p = raw.trim();
  if (!p) return null;
  if (/^https?:\/\//i.test(p)) {
    try { p = new URL(p).pathname; } catch { return null; }
  }
  const cut = p.search(/[?#]/);
  if (cut !== -1) p = p.slice(0, cut);
  if (!p.startsWith('/')) return null;
  // control characters never belong in a stored path
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(p)) return null;
  return p.length > CRAWLER_HIT_MAX_PATH ? p.slice(0, CRAWLER_HIT_MAX_PATH) : p;
}

export interface ServerEngineDay {
  day: string;
  engine: string;
  kind: CrawlerKind;
  hits: number;
  /** hits answered with status >= 400 (404s, 5xx …) */
  errors: number;
  /** hits the reporter marked `verified: true` (see docs: self-asserted) */
  verified: number;
  first_ts: number;
  last_ts: number;
  first_path: string;
  paths: Map<string, number>;
}

export interface PreparedHits {
  accepted: number;
  ignored: number;
  /** per (day, engine) */
  groups: ServerEngineDay[];
}

/**
 * Validate and group a request's hits. Non-crawler user agents, unusable
 * paths and hits older than 48h are ignored (counted in `ignored`); a missing,
 * malformed or future `ts` is clamped to `now`. `ip` and `country` are
 * accepted for forward compatibility but not stored.
 */
export function prepareCrawlerHits(hits: unknown[], tz: string, now = Date.now()): PreparedHits {
  const groups = new Map<string, ServerEngineDay>();
  let accepted = 0;
  let ignored = 0;
  for (const h of hits) {
    if (!h || typeof h !== 'object' || Array.isArray(h)) { ignored++; continue; }
    const hit = h as Record<string, unknown>;
    const ua = typeof hit.ua === 'string' ? hit.ua.slice(0, CRAWLER_HIT_MAX_UA) : null;
    const c = classifyCrawler(ua, null);
    const path = normalizeHitPath(hit.path);
    if (!c || !path) { ignored++; continue; }
    let ts = typeof hit.ts === 'number' && Number.isFinite(hit.ts) ? Math.floor(hit.ts) : now;
    if (ts > now) ts = now;
    if (ts < now - CRAWLER_HIT_MAX_AGE_MS) { ignored++; continue; }
    const status = typeof hit.status === 'number' ? hit.status : 0;
    const { y, m0, d } = localYMD(ts, tz);
    const day = dayStr(y, m0, d);
    const key = `${day}|${c.engine}`;
    let g = groups.get(key);
    if (!g) {
      g = { day, engine: c.engine, kind: c.kind, hits: 0, errors: 0, verified: 0, first_ts: ts, last_ts: ts, first_path: path, paths: new Map() };
      groups.set(key, g);
    }
    g.hits++;
    if (status >= 400) g.errors++;
    if (hit.verified === true) g.verified++;
    if (ts < g.first_ts) { g.first_ts = ts; g.first_path = path; }
    if (ts > g.last_ts) g.last_ts = ts;
    g.paths.set(path, (g.paths.get(path) ?? 0) + 1);
    accepted++;
  }
  return { accepted, ignored, groups: [...groups.values()] };
}

/**
 * Upsert one engine's durable first/last-seen milestone. SET expressions all
 * see the OLD row (SQLite assigns simultaneously), so the CASEs compare
 * against the stored first_seen_at before MIN() lowers it.
 *
 * `keepKind`: the server source classifies by UA only (no imported bot
 * directory), so it never overwrites a kind the cron already settled.
 */
export function milestoneUpsert<S>(
  db: Db<S>, siteId: string, engine: string, kind: string,
  firstAt: number, lastAt: number, source: CrawlerSource, firstPath: string | null, now: number,
  keepKind = false,
): S {
  return db.prepare(`
    INSERT INTO crawler_milestones (site_id, engine, kind, first_seen_at, last_seen_at, first_source, first_path, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(site_id, engine) DO UPDATE SET
      kind = ${keepKind ? 'crawler_milestones.kind' : 'excluded.kind'},
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

/**
 * The write set for one request: per (day, engine) an additive upsert of the
 * `server` daily row, per (day, engine, path) an additive upsert of the page
 * row (new paths only while the engine-day is under the cap), and one
 * milestone merge per engine. Unlike beacon/edge (recomputed and replaced),
 * server rows ACCUMULATE — each request carries new hits, not a recount.
 */
export function crawlerHitStatements<S>(db: Db<S>, siteId: string, groups: ServerEngineDay[], now = Date.now()): S[] {
  const stmts: S[] = [];
  const milestones = new Map<string, { kind: string; first: number; last: number; path: string }>();
  for (const g of groups) {
    stmts.push(db.prepare(`
      INSERT INTO rollup_crawler_daily (site_id, day, engine, source, kind, hits, pages, first_ts, last_ts, error_hits, verified_hits)
      VALUES (?, ?, ?, 'server', ?, ?, NULL, ?, ?, ?, ?)
      ON CONFLICT(site_id, day, engine, source) DO UPDATE SET
        hits = rollup_crawler_daily.hits + excluded.hits,
        first_ts = MIN(rollup_crawler_daily.first_ts, excluded.first_ts),
        last_ts = MAX(rollup_crawler_daily.last_ts, excluded.last_ts),
        error_hits = COALESCE(rollup_crawler_daily.error_hits, 0) + excluded.error_hits,
        verified_hits = COALESCE(rollup_crawler_daily.verified_hits, 0) + excluded.verified_hits
    `).bind(siteId, g.day, g.engine, g.kind, g.hits, g.first_ts, g.last_ts, g.errors, g.verified));
    for (const [path, hits] of g.paths) {
      // an existing path always accumulates; a new one only while under the cap
      stmts.push(db.prepare(`
        INSERT INTO rollup_crawler_server_page_daily (site_id, day, engine, path, hits)
        SELECT ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM rollup_crawler_server_page_daily WHERE site_id = ? AND day = ? AND engine = ? AND path = ?)
           OR (SELECT COUNT(*) FROM rollup_crawler_server_page_daily WHERE site_id = ? AND day = ? AND engine = ?) < ?
        ON CONFLICT(site_id, day, engine, path) DO UPDATE SET hits = rollup_crawler_server_page_daily.hits + excluded.hits
      `).bind(siteId, g.day, g.engine, path, hits, siteId, g.day, g.engine, path, siteId, g.day, g.engine, MAX_SERVER_PAGES_PER_ENGINE_DAY));
    }
    const m = milestones.get(g.engine);
    if (!m) milestones.set(g.engine, { kind: g.kind, first: g.first_ts, last: g.last_ts, path: g.first_path });
    else {
      if (g.first_ts < m.first) { m.first = g.first_ts; m.path = g.first_path; }
      if (g.last_ts > m.last) m.last = g.last_ts;
    }
  }
  for (const [engine, m] of milestones) {
    stmts.push(milestoneUpsert(db, siteId, engine, m.kind, m.first, m.last, 'server', m.path, now, true));
  }
  return stmts;
}
