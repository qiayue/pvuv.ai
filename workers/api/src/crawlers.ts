/**
 * Crawler / indexing signals read path (migration 0024) — shared by the api
 * worker (GET /v1/sites/:id/crawlers) and the console (/api/sites/:id/crawlers).
 *
 * A SEPARATE metric: reads only the crawler_* tables the cron fills, never the
 * events/rollup tables PV/UV come from, and nothing it returns feeds scoring,
 * verdicts or the ad-guard decision.
 *
 * Two sources, reported side by side rather than added together — a crawler
 * that renders JavaScript is counted by BOTH the beacon and Cloudflare's edge,
 * so a sum would double it:
 *   beacon — crawler pageviews (JS-rendering crawlers only), with pages
 *   edge   — Cloudflare's top user agents per day (any crawler; optional, needs
 *            the read-only CF token; day-granular; no pages)
 * `hits` is the per-day larger of the two, summed: the best single estimate.
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
  /** first page crawled (beacon only) */
  first_path: string | null;
  last_seen_at: number;
  /** in the period: per-day max(beacon, edge), summed */
  hits: number;
  beacon_hits: number;
  edge_hits: number;
  /** distinct paths the beacon saw in the period (approximate past 50/day) */
  pages: number;
  days: Array<{ day: string; beacon: number; edge: number }>;
}

const SEARCH_KIND = 'search';

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

export async function crawlers(db: D1Database, siteId: string, period: Period, opts: { limit?: number } = {}) {
  const limit = Math.min(Math.max(Number.isFinite(opts.limit) ? opts.limit as number : 20, 1), 100);
  const edgeAvailable = await edgeSeen(db, siteId);
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
  };
  const base = {
    site_id: siteId,
    period: { start: period.start, end: period.end },
    sources,
    first_search_crawl_at: null as number | null,
    engines: [] as CrawlerEngineReport[],
    top_pages: {
      source: 'beacon' as const,
      note: 'Beacon data only: pages fetched by crawlers that executed the tracking script. Edge data carries no paths.',
      pages: [] as Array<{ path: string; hits: number; engines: Record<string, number> }>,
    },
  };
  if (!(await hasCrawlerTables(db))) return { ...base, available: false };

  const [ms, daily, pages, pageCount] = await Promise.all([
    db.prepare(`
      SELECT engine, kind, first_seen_at, last_seen_at, first_source, first_path
      FROM crawler_milestones WHERE site_id = ? ORDER BY first_seen_at
    `).bind(siteId).all<{ engine: string; kind: string; first_seen_at: number; last_seen_at: number; first_source: string | null; first_path: string | null }>(),
    db.prepare(`
      SELECT day, engine, source, hits FROM rollup_crawler_daily
      WHERE site_id = ? AND day BETWEEN ? AND ? ORDER BY day
    `).bind(siteId, period.start, period.end).all<{ day: string; engine: string; source: string; hits: number }>(),
    db.prepare(`
      SELECT path, engine, SUM(hits) AS hits FROM rollup_crawler_page_daily
      WHERE site_id = ? AND day BETWEEN ? AND ?
      GROUP BY path, engine
    `).bind(siteId, period.start, period.end).all<{ path: string; engine: string; hits: number }>(),
    db.prepare(`
      SELECT engine, COUNT(DISTINCT path) AS n FROM rollup_crawler_page_daily
      WHERE site_id = ? AND day BETWEEN ? AND ? GROUP BY engine
    `).bind(siteId, period.start, period.end).all<{ engine: string; n: number }>(),
  ]);

  // per engine, per day: beacon and edge side by side
  const series = new Map<string, Map<string, { beacon: number; edge: number }>>();
  for (const r of daily.results) {
    let byDay = series.get(r.engine);
    if (!byDay) { byDay = new Map(); series.set(r.engine, byDay); }
    const d = byDay.get(r.day) ?? { beacon: 0, edge: 0 };
    if (r.source === 'edge') d.edge += r.hits; else d.beacon += r.hits;
    byDay.set(r.day, d);
  }
  const pagesBy = new Map(pageCount.results.map((r) => [r.engine, r.n]));

  const engines: CrawlerEngineReport[] = ms.results.map((m) => {
    const days = [...(series.get(m.engine) ?? new Map<string, { beacon: number; edge: number }>())]
      .map(([day, v]) => ({ day, beacon: v.beacon, edge: v.edge }))
      .sort((a, b) => (a.day < b.day ? -1 : 1));
    return {
      engine: m.engine,
      label: engineInfo(m.engine).label,
      kind: m.kind,
      first_seen_at: m.first_seen_at,
      first_source: m.first_source,
      first_path: m.first_path,
      last_seen_at: m.last_seen_at,
      hits: days.reduce((n, d) => n + Math.max(d.beacon, d.edge), 0),
      beacon_hits: days.reduce((n, d) => n + d.beacon, 0),
      edge_hits: days.reduce((n, d) => n + d.edge, 0),
      pages: pagesBy.get(m.engine) ?? 0,
      days,
    };
  });
  // search engines first (the launch question), then by activity
  const kindRank = (k: string) => (k === SEARCH_KIND ? 0 : k === 'ads' ? 1 : k === 'ai' ? 2 : 3);
  engines.sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || b.hits - a.hits || a.first_seen_at - b.first_seen_at);

  const byPath = new Map<string, { path: string; hits: number; engines: Record<string, number> }>();
  for (const r of pages.results) {
    const p = byPath.get(r.path) ?? { path: r.path, hits: 0, engines: {} };
    p.hits += r.hits;
    p.engines[r.engine] = (p.engines[r.engine] ?? 0) + r.hits;
    byPath.set(r.path, p);
  }
  const topPages = [...byPath.values()].sort((a, b) => b.hits - a.hits || (a.path < b.path ? -1 : 1)).slice(0, limit);

  const search = ms.results.filter((m) => m.kind === SEARCH_KIND).map((m) => m.first_seen_at);
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
