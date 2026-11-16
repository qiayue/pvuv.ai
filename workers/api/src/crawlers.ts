/**
 * Crawler / indexing signals read path (migrations 0024, 0025) — shared by the
 * api worker (GET /v1/sites/:id/crawlers) and the console
 * (/api/sites/:id/crawlers).
 *
 * A SEPARATE metric: reads only the crawler_* tables, never the events/rollup
 * tables PV/UV come from, and nothing it returns feeds scoring, verdicts or the
 * ad-guard decision.
 *
 * Three sources, reported side by side rather than added together — the same
 * fetch can be seen by several of them (a JS-rendering crawler is counted by
 * the beacon AND the edge AND, on a Worker-served site, the server report), so
 * a sum would double it:
 *   beacon — crawler pageviews (JS-rendering crawlers only), with pages
 *   edge   — Cloudflare's top user agents per day (any crawler; optional, needs
 *            the read-only CF token; day-granular; no pages)
 *   server — reported by the site's own Worker via POST /crawler_hits (any
 *            crawler that reached the Worker, with pages and status)
 * `hits` is, per engine per day, the largest of the three, summed: the best
 * single estimate. Top pages use the same rule per (day, engine, path).
 */

import type { Period } from './queries';
import { engineInfo, type CrawlerKind } from '../../../shared/crawlers';

export interface CrawlerEngineReport {
  engine: string;
  label: string;
  kind: CrawlerKind | string;
  first_seen_at: number;
  /** which source saw it first; an edge-sourced time is the start of that local day */
  first_source: string | null;
  /** first page crawled (beacon / server) */
  first_path: string | null;
  last_seen_at: number;
  /** in the period: per-day max(beacon, edge, server), summed */
  hits: number;
  beacon_hits: number;
  edge_hits: number;
  server_hits: number;
  /** server source only: hits answered with HTTP status >= 400 */
  server_error_hits: number;
  /** server source only: hits the reporter marked verified (self-asserted) */
  server_verified_hits: number;
  /** distinct paths seen in the period, beacon + server (approximate past the per-day caps) */
  pages: number;
  days: Array<{ day: string; beacon: number; edge: number; server: number }>;
}

export interface CrawlerOptions {
  limit?: number;
  /** only this engine id (case-insensitive), e.g. 'googlebot' */
  bot?: string | null;
  /** only kind = 'search' engines */
  search?: boolean;
}

const SEARCH_KIND = 'search';

/** Query-string truthiness for `search=`: anything but '', '0', 'false', 'no', 'off'. */
export function truthyParam(v: string | null | undefined): boolean {
  if (v == null) return false;
  return !['', '0', 'false', 'no', 'off'].includes(v.trim().toLowerCase());
}

/** Does the 0024 schema exist? An optional panel must not break around it. */
async function hasCrawlerTables(db: D1Database): Promise<boolean> {
  try {
    await db.prepare('SELECT 1 FROM crawler_milestones LIMIT 1').first();
    return true;
  } catch {
    return false;
  }
}

/** Was the edge pull ever configured AND did it ever reach this site? */
async function edgeSeen(db: D1Database, siteId: string): Promise<boolean> {
  try {
    const r = await db.prepare('SELECT 1 AS ok FROM rollup_edge_daily WHERE site_id = ? LIMIT 1').bind(siteId).first<{ ok: number }>();
    return !!r;
  } catch {
    return false;
  }
}

/** Has this site's Worker ever reported a crawler hit (0025 server source)? */
async function serverSeen(db: D1Database, siteId: string): Promise<boolean> {
  try {
    const r = await db.prepare("SELECT 1 AS ok FROM rollup_crawler_daily WHERE site_id = ? AND source = 'server' LIMIT 1")
      .bind(siteId).first<{ ok: number }>();
    return !!r;
  } catch {
    return false;
  }
}

/** Does the 0025 server page table exist? */
async function hasServerPages(db: D1Database): Promise<boolean> {
  try {
    await db.prepare('SELECT 1 FROM rollup_crawler_server_page_daily LIMIT 1').first();
    return true;
  } catch {
    return false;
  }
}

export async function crawlers(db: D1Database, siteId: string, period: Period, opts: CrawlerOptions = {}) {
  const limit = Math.min(Math.max(Number.isFinite(opts.limit) ? opts.limit as number : 20, 1), 100);
  const bot = opts.bot ? opts.bot.trim().toLowerCase() : null;
  const searchOnly = !!opts.search;
  const [edgeAvailable, serverAvailable, serverPagesTable] = await Promise.all([
    edgeSeen(db, siteId), serverSeen(db, siteId), hasServerPages(db),
  ]);
  const sources = {
    beacon: {
      available: true,
      note: 'Crawler pageviews from the tracking script: only crawlers that execute JavaScript (Googlebot does; many others do not). User agents are as declared.',
    },
    edge: {
      available: edgeAvailable,
      note: edgeAvailable
        ? 'Cloudflare edge HTML requests by user agent (top agents per day, completed days only). Catches crawlers that never run JavaScript; user agents are as declared, not verified.'
        : 'Not available: no read-only Cloudflare API token is configured, or this site\'s zone is not visible to it. Only crawlers that run JavaScript are counted.',
    },
    server: {
      available: serverAvailable,
      note: serverAvailable
        ? 'Reported by the site\'s own server (POST /v1/sites/{id}/crawler_hits with a site-scoped ingest token): every crawler request the server answered, JavaScript or not, with paths and status. User agents are as declared by the crawler and the report is trusted as sent by the token holder; verified_hits only counts hits the reporter itself marked verified.'
        : 'No server-side reports for this site. A Worker-served site can report crawler requests with a site-scoped ingest token (POST /v1/sites/{id}/tokens, then POST /v1/sites/{id}/crawler_hits).',
    },
  };
  const base = {
    site_id: siteId,
    period: { start: period.start, end: period.end },
    filters: { bot, search: searchOnly },
    sources,
    merge: 'Sources overlap (one fetch can be seen by several), so per engine per day hits = max(beacon, edge, server), summed over the period; top pages use the same max per (day, engine, path).',
    first_search_crawl_at: null as number | null,
    engines: [] as CrawlerEngineReport[],
    top_pages: {
      source: (serverAvailable ? 'beacon+server' : 'beacon') as string,
      note: serverAvailable
        ? 'Beacon and server-reported pages (max of the two per day, engine and path): includes crawlers that never run JavaScript. Edge data carries no paths.'
        : 'Beacon data only: pages fetched by crawlers that executed the tracking script. Edge data carries no paths.',
      pages: [] as Array<{ path: string; hits: number; engines: Record<string, number> }>,
    },
  };
  if (!(await hasCrawlerTables(db))) return { ...base, available: false };

  // per (day, engine, path) max across the two path-carrying sources
  const pageUnion = serverPagesTable
    ? `SELECT day, engine, path, MAX(hits) AS hits FROM (
         SELECT day, engine, path, hits FROM rollup_crawler_page_daily WHERE site_id = ? AND day BETWEEN ? AND ?
         UNION ALL
         SELECT day, engine, path, hits FROM rollup_crawler_server_page_daily WHERE site_id = ? AND day BETWEEN ? AND ?
       ) GROUP BY day, engine, path`
    : 'SELECT day, engine, path, hits FROM rollup_crawler_page_daily WHERE site_id = ? AND day BETWEEN ? AND ?';
  const pageBinds = serverPagesTable
    ? [siteId, period.start, period.end, siteId, period.start, period.end]
    : [siteId, period.start, period.end];

  const [ms, daily, pages, pageCount, serverExtra] = await Promise.all([
    db.prepare(`
      SELECT engine, kind, first_seen_at, last_seen_at, first_source, first_path
      FROM crawler_milestones WHERE site_id = ? ORDER BY first_seen_at
    `).bind(siteId).all<{ engine: string; kind: string; first_seen_at: number; last_seen_at: number; first_source: string | null; first_path: string | null }>(),
    db.prepare(`
      SELECT day, engine, source, hits FROM rollup_crawler_daily
      WHERE site_id = ? AND day BETWEEN ? AND ? ORDER BY day
    `).bind(siteId, period.start, period.end).all<{ day: string; engine: string; source: string; hits: number }>(),
    db.prepare(`SELECT path, engine, SUM(hits) AS hits FROM (${pageUnion}) GROUP BY path, engine`)
      .bind(...pageBinds).all<{ path: string; engine: string; hits: number }>(),
    db.prepare(`SELECT engine, COUNT(DISTINCT path) AS n FROM (${pageUnion}) GROUP BY engine`)
      .bind(...pageBinds).all<{ engine: string; n: number }>(),
    serverAvailable
      ? db.prepare(`
          SELECT engine, SUM(COALESCE(error_hits, 0)) AS errors, SUM(COALESCE(verified_hits, 0)) AS verified
          FROM rollup_crawler_daily WHERE site_id = ? AND source = 'server' AND day BETWEEN ? AND ? GROUP BY engine
        `).bind(siteId, period.start, period.end).all<{ engine: string; errors: number; verified: number }>()
        .catch(() => ({ results: [] as Array<{ engine: string; errors: number; verified: number }> }))
      : Promise.resolve({ results: [] as Array<{ engine: string; errors: number; verified: number }> }),
  ]);

  // the engine filter (bot / search) applies to everything below
  const keep = new Set(ms.results
    .filter((m) => (!bot || m.engine.toLowerCase() === bot) && (!searchOnly || m.kind === SEARCH_KIND))
    .map((m) => m.engine));

  // per engine, per day: the three sources side by side
  type Day = { beacon: number; edge: number; server: number };
  const series = new Map<string, Map<string, Day>>();
  for (const r of daily.results) {
    if (!keep.has(r.engine)) continue;
    let byDay = series.get(r.engine);
    if (!byDay) { byDay = new Map(); series.set(r.engine, byDay); }
    const d = byDay.get(r.day) ?? { beacon: 0, edge: 0, server: 0 };
    if (r.source === 'edge') d.edge += r.hits;
    else if (r.source === 'server') d.server += r.hits;
    else d.beacon += r.hits;
    byDay.set(r.day, d);
  }
  const pagesBy = new Map(pageCount.results.map((r) => [r.engine, r.n]));
  const extraBy = new Map(serverExtra.results.map((r) => [r.engine, r]));

  const engines: CrawlerEngineReport[] = ms.results.filter((m) => keep.has(m.engine)).map((m) => {
    const days = [...(series.get(m.engine) ?? new Map<string, Day>())]
      .map(([day, v]) => ({ day, beacon: v.beacon, edge: v.edge, server: v.server }))
      .sort((a, b) => (a.day < b.day ? -1 : 1));
    const extra = extraBy.get(m.engine);
    return {
      engine: m.engine,
      label: engineInfo(m.engine).label,
      kind: m.kind,
      first_seen_at: m.first_seen_at,
      first_source: m.first_source,
      first_path: m.first_path,
      last_seen_at: m.last_seen_at,
      hits: days.reduce((n, d) => n + Math.max(d.beacon, d.edge, d.server), 0),
      beacon_hits: days.reduce((n, d) => n + d.beacon, 0),
      edge_hits: days.reduce((n, d) => n + d.edge, 0),
      server_hits: days.reduce((n, d) => n + d.server, 0),
      server_error_hits: Number(extra?.errors ?? 0),
      server_verified_hits: Number(extra?.verified ?? 0),
      pages: pagesBy.get(m.engine) ?? 0,
      days,
    };
  });
  // search engines first (the launch question), then by activity
  const kindRank = (k: string) => (k === SEARCH_KIND ? 0 : k === 'ads' ? 1 : k === 'ai' ? 2 : 3);
  engines.sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || b.hits - a.hits || a.first_seen_at - b.first_seen_at);

  const byPath = new Map<string, { path: string; hits: number; engines: Record<string, number> }>();
  for (const r of pages.results) {
    if (!keep.has(r.engine)) continue;
    const p = byPath.get(r.path) ?? { path: r.path, hits: 0, engines: {} };
    p.hits += r.hits;
    p.engines[r.engine] = (p.engines[r.engine] ?? 0) + r.hits;
    byPath.set(r.path, p);
  }
  const topPages = [...byPath.values()].sort((a, b) => b.hits - a.hits || (a.path < b.path ? -1 : 1)).slice(0, limit);

  const search = ms.results.filter((m) => keep.has(m.engine) && m.kind === SEARCH_KIND).map((m) => m.first_seen_at);
  return {
    ...base,
    available: true,
    first_search_crawl_at: search.length ? Math.min(...search) : null,
    engines,
    top_pages: { ...base.top_pages, pages: topPages },
  };
}

/**
 * First search-engine crawl per site (Google/Bing-class, kind = 'search'), for
 * site lists. Missing tables or no crawl yet → the site is simply absent.
 */
export async function firstSearchCrawls(db: D1Database, siteIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (siteIds.length === 0) return out;
  try {
    for (let i = 0; i < siteIds.length; i += 90) {
      const chunk = siteIds.slice(i, i + 90);
      const rows = await db.prepare(`
        SELECT site_id, MIN(first_seen_at) AS at FROM crawler_milestones
        WHERE kind = '${SEARCH_KIND}' AND site_id IN (${chunk.map(() => '?').join(',')})
        GROUP BY site_id
      `).bind(...chunk).all<{ site_id: string; at: number }>();
      for (const r of rows.results) out.set(r.site_id, r.at);
    }
  } catch { /* 0024 not applied yet → no milestones to report */ }
  return out;
}
