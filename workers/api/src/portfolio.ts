/**
 * Portfolio overview — GET /api/portfolio (console) and GET /v1/portfolio (api).
 * Contract: docs/design/portfolio-ui.md §2–§3.
 *
 * One payload for an owner of many sites (50–500): totals with the previous
 * period, the lifecycle funnel, stage counts, and one row per site with its
 * trend, crawl milestones, daily health, lifecycle stage and the reasons it
 * needs attention.
 *
 * Cost model. Everything comes from the pre-aggregated tables — no raw event
 * partition is touched:
 *   rollup_site_daily    pv / uv / verdict counts per site-day (the hourly job
 *                        recomputes the current local day too, so "today" is at
 *                        most an hour behind — fine behind a 5-minute cache)
 *   rollup_source_daily  clean visitors per source → organic search / AI
 *   crawler_milestones   first / last crawl per engine
 *   sessions             one index seek per site for "last event" (no scan)
 * Sites are read in chunks of PORTFOLIO_CHUNK ids (`site_id IN (…)`, D1 binds
 * at most 100 parameters), and each chunk's statements go out as ONE
 * db.batch() round trip, so the statement count grows with ⌈sites / chunk⌉,
 * never with the number of sites (⌈sites / chunk⌉ + 1 round trips in all). Day bounds are generated here (validated
 * YYYY-MM-DD) and inlined so the whole parameter budget goes to the IN list.
 *
 * uv over several days is a per-day sum (a visitor seen on three days counts
 * three times) — the same approximation the site list and daily charts use.
 * "Clean visitors" = uv × clean pageviews / pageviews.
 */
import { parsePeriod, previousPeriod, ApiError, type Period } from './queries';
import { localYMD, addDays, dayStr, localMidnightUtc } from '../../../shared/tz';
import { classifyChannel, searchOrAiSourceSql } from '../../../shared/channel';
import { loadExternal, type Attention, type ExternalSite } from './external';
import { cohortTag } from '../../../shared/labels';
import { readPortfolioThresholds, PORTFOLIO_DEFAULTS, type PortfolioThresholds } from '../../../shared/thresholds';

export { cohortTag };

export type Stage = 'setup' | 'awaiting_crawl' | 'crawled' | 'organic' | 'growing' | 'declining' | 'archived';
export const STAGES: Stage[] = ['setup', 'awaiting_crawl', 'crawled', 'organic', 'growing', 'declining', 'archived'];
export type Health = 'ok' | 'warn' | 'bad' | 'none';

/** Lifecycle / attention thresholds. The four the owner can tune (contract
 *  §1) come from shared/thresholds.ts — instance setting
 *  `portfolio_thresholds`, edited on the settings page. The rest are fixed by
 *  the contract and shipped here so the payload documents every number used. */
export const FIXED_THRESHOLDS = {
  /** declining needs at least this many clean visitors in the previous 28 days */
  decline_min_uv: 100,
  /** waiting for a crawl longer than this many days since going live */
  crawl_overdue_days: 3,
  /** crawled this many days ago and still no organic-search / AI visitor */
  organic_overdue_days: 14,
  /** no event for this many hours */
  no_data_hours: 24,
  /** IVT spike: the last complete day's share at least this many points above the previous period */
  ivt_spike_pts: 10,
  /** ignore IVT on fewer pageviews than this (too noisy) */
  ivt_min_pv: 50,
};
export const DEFAULT_THRESHOLDS = { ...PORTFOLIO_DEFAULTS, ...FIXED_THRESHOLDS };
export type Thresholds = PortfolioThresholds & typeof FIXED_THRESHOLDS;

export async function loadThresholds(db: D1Database): Promise<Thresholds> {
  return { ...(await readPortfolioThresholds(db)), ...FIXED_THRESHOLDS };
}

/** The four engines shown as chips; values are shared/crawlers.ts engine ids. */
export const CRAWL_ENGINES: Record<'google' | 'bing' | 'yandex' | 'baidu', string> = {
  google: 'googlebot', bing: 'bingbot', yandex: 'yandex', baidu: 'baidu',
};

const DAY = 86_400_000;
export const PORTFOLIO_CHUNK = 95;
const SERIES_DAYS = 14;
const CACHE_TTL_S = 300;

// ---------------------------------------------------------------------------
// pure rules (exported for tests)
// ---------------------------------------------------------------------------

export interface StageInput {
  status: string;
  has_data: boolean;
  first_data_at: number | null;
  first_search_crawl_at: number | null;
  first_organic_at: number | null;   // null = never seen an organic-search / AI visitor
  clean_uv_7d: number;               // last 7 complete days
  clean_uv_prev_7d: number;
  clean_uv_28d: number;
  clean_uv_prev_28d: number;
  growing_since?: number | null;
  declining_since?: number | null;
}

const pct = (cur: number, prev: number): number | null => (prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : null);

export function isGrowing(i: StageInput, th: Thresholds): boolean {
  if (i.clean_uv_7d < th.growth_uv_7d) return false;
  const d = pct(i.clean_uv_7d, i.clean_uv_prev_7d);
  return d === null || d >= th.growth_min_delta_pct;
}
export function isDeclining(i: StageInput, th: Thresholds): boolean {
  if (i.clean_uv_prev_28d < th.decline_min_uv) return false;
  const d = pct(i.clean_uv_28d, i.clean_uv_prev_28d);
  return d !== null && d < -th.decline_pct;
}

/** Lifecycle stage (§2): archived wins; otherwise the latest stage whose rule
 *  holds, with `declining` taking precedence over growing / organic. */
export function computeStage(i: StageInput, th: Thresholds): { stage: Stage; since: number | null } {
  if (i.status === 'archived') return { stage: 'archived', since: null };
  if (!i.has_data) return { stage: 'setup', since: null };
  if (isDeclining(i, th)) return { stage: 'declining', since: i.declining_since ?? null };
  if (i.first_organic_at != null && isGrowing(i, th)) return { stage: 'growing', since: i.growing_since ?? i.first_organic_at };
  if (i.first_organic_at != null) return { stage: 'organic', since: i.first_organic_at };
  if (i.first_search_crawl_at != null) return { stage: 'crawled', since: i.first_search_crawl_at };
  return { stage: 'awaiting_crawl', since: i.first_data_at };
}

export interface AttentionInput extends StageInput {
  created_at: number;
  last_event_at: number | null;
  adguard_mode: string;
  stage: Stage;
  uv_28d: number; uv_prev_28d: number;
  ivt_pct: number | null; ivt_pct_prev: number | null; pv: number;
  last_day_ivt_pct: number | null; last_day_pv: number;
}

/** P1 attention codes (§3.1). Severity: critical | high | normal. */
export function computeAttention(i: AttentionInput, th: Thresholds, now: number): Attention[] {
  const out: Attention[] = [];
  if (i.status === 'archived') return out;
  const hours = th.no_data_hours;
  if (now - i.created_at > hours * 3_600_000 && (i.last_event_at == null || now - i.last_event_at > hours * 3_600_000)) {
    out.push({
      code: 'no_data_24h', severity: i.has_data ? 'critical' : 'high',
      params: { hours, ever: i.has_data, last_event_at: i.last_event_at },
    });
  }
  if (i.has_data && i.first_search_crawl_at == null) {
    const live = Math.floor((now - (i.first_data_at ?? i.created_at)) / DAY);
    if (live > th.crawl_overdue_days) out.push({ code: 'crawl_overdue', severity: 'normal', params: { days: live } });
  }
  if (i.first_search_crawl_at != null && i.first_organic_at == null) {
    const days = Math.floor((now - i.first_search_crawl_at) / DAY);
    if (days > th.organic_overdue_days) out.push({ code: 'organic_overdue', severity: 'normal', params: { days } });
  }
  if (i.stage === 'declining') {
    out.push({ code: 'declining', severity: 'high', params: { pct: pct(i.clean_uv_28d, i.clean_uv_prev_28d) ?? 0, days: 28 } });
  }
  const ivtHigh = i.ivt_pct != null && i.pv >= th.ivt_min_pv && i.ivt_pct > th.ivt_pct;
  if (ivtHigh) {
    out.push({
      code: 'ivt_high', severity: i.adguard_mode === 'off' ? 'critical' : 'high',
      params: { ivt_pct: i.ivt_pct, adguard_mode: i.adguard_mode },
    });
  } else if (
    i.last_day_ivt_pct != null && i.last_day_pv >= th.ivt_min_pv
    && i.last_day_ivt_pct >= (i.ivt_pct_prev ?? 0) + th.ivt_spike_pts
    && i.last_day_ivt_pct > th.ivt_pct / 2
  ) {
    out.push({ code: 'ivt_spike', severity: 'high', params: { ivt_pct: i.last_day_ivt_pct, prev_pct: i.ivt_pct_prev ?? 0 } });
  }
  return out;
}

const SEV_RANK: Record<string, number> = { critical: 0, high: 1, normal: 2 };

// ---------------------------------------------------------------------------
// payload
// ---------------------------------------------------------------------------

export interface PortfolioSite {
  site_id: string; name: string; domains: string[]; status: string;
  created_at: number; days_live: number; timezone: string;
  starred: boolean; tags: string[];
  /** automatic launch cohort, `launch:YYYY-Www` (shared/labels.ts) */
  cohort: string;
  adguard_mode: string;
  stage: Stage; stage_since: number | null;
  uv: number; uv_prev: number; pv: number; pv_prev: number; delta_pct: number | null;
  series: { day: string; uv: number }[];
  organic_uv: number; ai_uv: number; ivt_pct: number | null;
  crawl: Record<keyof typeof CRAWL_ENGINES, { first_seen_at: number; last_seen_at: number } | null>;
  first_search_crawl_at: number | null;
  last_event_at: number | null;
  health: Health[];
  attention: Attention[];
  external: ExternalSite | null;
}

export interface PortfolioPayload {
  period: { token: string; start: string; end: string };
  compare: 'previous' | null;
  generated_at: number;
  thresholds: Thresholds;
  totals: {
    uv: number; uv_prev: number; pv: number; pv_prev: number;
    ivt_pct: number | null; ivt_pct_prev: number | null;
    organic_uv: number; organic_uv_prev: number; ai_uv: number; ai_uv_prev: number;
    top10_share: number | null;
    series: { day: string; uv: number; pv: number; ivt_pct: number | null; organic_uv: number; ai_uv: number; launched_per_day: number }[];
  };
  funnel: { total: number; has_data: number; google_crawled: number; organic: number; weekly_1000: number };
  stage_counts: Record<Stage, number>;
  attention_count: number;
  sites: PortfolioSite[];
}

interface SiteRow {
  site_id: string; name: string; allowed_domains: string; status: string | null;
  created_at: number; timezone: string | null; adguard_mode: string | null;
  starred?: number | null; tags?: string | null;
  last_event_at: number | null; first_day: string | null;
}

interface Windows {
  tz: string; period: Period; prev: Period;
  today: string; todayStartTs: number; frac: number;
  cur: [string, string]; prevFull: [string, string] | null; prevLast: string;
  l7: [string, string]; p7: [string, string]; l28: [string, string]; p28: [string, string];
  s14: [string, string]; min: string; max: string;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const lit = (d: string): string => { if (!DAY_RE.test(d)) throw new Error('bad day ' + d); return `'${d}'`; };
const between = (w: [string, string]) => `day BETWEEN ${lit(w[0])} AND ${lit(w[1])}`;
const shift = (day: string, n: number): string => {
  const [y, m, d] = day.split('-').map(Number);
  const r = addDays(y, m - 1, d, n);
  return dayStr(r.y, r.m0, r.d);
};
const dayStart = (day: string, tz: string): number => {
  const [y, m, d] = day.split('-').map(Number);
  return localMidnightUtc(tz, y, m - 1, d);
};

function windowsFor(token: string, tz: string, now: number): Windows {
  const period = parsePeriod(token, tz, now);
  const prev = previousPeriod(period);
  const t = localYMD(now, tz);
  const today = dayStr(t.y, t.m0, t.d);
  const todayStartTs = localMidnightUtc(tz, t.y, t.m0, t.d);
  // a window running into today compares with a previous window whose last day
  // is counted only for the elapsed fraction of today (the rollup holds whole days)
  const includesToday = period.start <= today && today <= period.end;
  const frac = includesToday ? Math.min(1, Math.max(0, (now - todayStartTs) / DAY)) : 1;
  const yday = shift(today, -1);
  const w: Windows = {
    tz, period, prev, today, todayStartTs, frac,
    cur: [period.start, period.end],
    prevFull: prev.start < prev.end ? [prev.start, shift(prev.end, -1)] : null,
    prevLast: prev.end,
    l7: [shift(yday, -6), yday], p7: [shift(yday, -13), shift(yday, -7)],
    l28: [shift(yday, -27), yday], p28: [shift(yday, -55), shift(yday, -28)],
    s14: [shift(today, -(SERIES_DAYS - 1)), today],
    min: '', max: '',
  };
  w.min = [prev.start, w.p28[0], w.s14[0]].sort()[0];
  w.max = [period.end, today].sort()[1];
  return w;
}

interface Agg {
  uv: number; pv: number; ivt: number;
  uv_p: number; pv_p: number; ivt_p: number; uv_pl: number; pv_pl: number; ivt_pl: number;
  uv7: number; pv7: number; c7: number; uv7p: number; pv7p: number; c7p: number;
  uv28: number; pv28: number; c28: number; uv28p: number; pv28p: number; c28p: number;
}

const cleanUv = (uv: number, clean: number, pv: number) => (pv > 0 ? Math.round(uv * (clean / pv)) : 0);
const ivtPct = (ivt: number, pv: number) => (pv > 0 ? Math.round((ivt / pv) * 1000) / 10 : null);

/** Build the overview for the given sites (already scoped to the caller). */
export async function portfolio(
  db: D1Database,
  sitesIn: SiteRow[] | null,
  opts: { ownerId: string | null; period?: string | null; compare?: string | null; now?: number },
): Promise<PortfolioPayload> {
  const now = opts.now ?? Date.now();
  const token = (opts.period || '7d').toLowerCase();
  const compare = opts.compare === undefined || opts.compare === null || opts.compare === '' || opts.compare === 'previous'
    ? 'previous' : opts.compare === 'none' ? null : (() => { throw new ApiError(400, `unknown compare: ${opts.compare} (previous|none)`); })();
  if (token === '24h') throw new ApiError(400, 'period 24h is not supported here (daily rollups) — use today, 7d, 30d, …');
  parsePeriod(token, 'UTC', now); // validates
  const th = await loadThresholds(db);
  const rows = sitesIn ?? await listSites(db, opts.ownerId);

  // ---- groups by timezone, then chunks ------------------------------------
  const byTz = new Map<string, SiteRow[]>();
  for (const s of rows) {
    const tz = s.timezone || 'UTC';
    (byTz.get(tz) ?? byTz.set(tz, []).get(tz)!).push(s);
  }

  const agg = new Map<string, Agg>();
  const daily = new Map<string, Map<string, { uv: number; pv: number; ivt: number }>>();
  const organic = new Map<string, { o: number; a: number; op: number; ap: number }>();
  const crawl = new Map<string, Map<string, { kind: string; first_seen_at: number; last_seen_at: number }>>();
  const firstOrganicDay = new Map<string, string>();
  const totalSeries = new Map<string, { uv: number; pv: number; ivt: number; o: number; a: number }>();
  const winOf = new Map<string, Windows>();
  const activeIds = new Set(rows.filter((r) => (r.status || 'active') === 'active').map((r) => r.site_id));

  const searchPred = searchOrAiSourceSql('source');
  for (const [tz, group] of byTz) {
    const w = windowsFor(token, tz, now);
    for (const s of group) winOf.set(s.site_id, w);
    for (let i = 0; i < group.length; i += PORTFOLIO_CHUNK) {
      const ids = group.slice(i, i + PORTFOLIO_CHUNK).map((s) => s.site_id);
      const activeChunk = ids.filter((id) => activeIds.has(id));
      const marks = ids.map(() => '?').join(',');
      const sumIf = (cond: string, col: string) => `COALESCE(SUM(CASE WHEN ${cond} THEN ${col} ELSE 0 END), 0)`;
      const ivtCol = '(suspect_count + bot_count)';
      const prevFull = w.prevFull ? between(w.prevFull) : '0';
      const stmts: D1PreparedStatement[] = [
        db.prepare(`
          SELECT site_id,
            ${sumIf(between(w.cur), 'uv')} AS uv, ${sumIf(between(w.cur), 'pv')} AS pv, ${sumIf(between(w.cur), ivtCol)} AS ivt,
            ${sumIf(prevFull, 'uv')} AS uv_p, ${sumIf(prevFull, 'pv')} AS pv_p, ${sumIf(prevFull, ivtCol)} AS ivt_p,
            ${sumIf(`day = ${lit(w.prevLast)}`, 'uv')} AS uv_pl, ${sumIf(`day = ${lit(w.prevLast)}`, 'pv')} AS pv_pl, ${sumIf(`day = ${lit(w.prevLast)}`, ivtCol)} AS ivt_pl,
            ${sumIf(between(w.l7), 'uv')} AS uv7, ${sumIf(between(w.l7), 'pv')} AS pv7, ${sumIf(between(w.l7), 'clean_count')} AS c7,
            ${sumIf(between(w.p7), 'uv')} AS uv7p, ${sumIf(between(w.p7), 'pv')} AS pv7p, ${sumIf(between(w.p7), 'clean_count')} AS c7p,
            ${sumIf(between(w.l28), 'uv')} AS uv28, ${sumIf(between(w.l28), 'pv')} AS pv28, ${sumIf(between(w.l28), 'clean_count')} AS c28,
            ${sumIf(between(w.p28), 'uv')} AS uv28p, ${sumIf(between(w.p28), 'pv')} AS pv28p, ${sumIf(between(w.p28), 'clean_count')} AS c28p
          FROM rollup_site_daily
          WHERE site_id IN (${marks}) AND day BETWEEN ${lit(w.min)} AND ${lit(w.max)}
          GROUP BY site_id`).bind(...ids),
        db.prepare(`
          SELECT site_id, day, uv, pv, ${ivtCol} AS ivt FROM rollup_site_daily
          WHERE site_id IN (${marks}) AND ${between(w.s14)}`).bind(...ids),
        db.prepare(`
          SELECT site_id, source, medium,
            ${sumIf(between(w.cur), 'uv_clean')} AS cur,
            ${sumIf(`day BETWEEN ${lit(w.prev.start)} AND ${lit(w.prev.end)}`, 'uv_clean')} AS prev
          FROM rollup_source_daily
          WHERE site_id IN (${marks}) AND day BETWEEN ${lit(w.prev.start < w.cur[0] ? w.prev.start : w.cur[0])} AND ${lit(w.cur[1])}
            AND ${searchPred}
          GROUP BY site_id, source, medium`).bind(...ids),
        db.prepare(`
          SELECT site_id, engine, kind, first_seen_at, last_seen_at FROM crawler_milestones
          WHERE kind = 'search' AND site_id IN (${marks})`).bind(...ids),
      ];
      // portfolio totals cover active sites only
      if (activeChunk.length) {
        const am = activeChunk.map(() => '?').join(',');
        stmts.push(
          db.prepare(`
            SELECT day, COALESCE(SUM(uv), 0) AS uv, COALESCE(SUM(pv), 0) AS pv, COALESCE(SUM(${ivtCol}), 0) AS ivt
            FROM rollup_site_daily WHERE site_id IN (${am}) AND ${between(w.cur)} GROUP BY day`).bind(...activeChunk),
          db.prepare(`
            SELECT day, source, medium, COALESCE(SUM(uv_clean), 0) AS uv FROM rollup_source_daily
            WHERE site_id IN (${am}) AND ${between(w.cur)} AND ${searchPred}
            GROUP BY day, source, medium`).bind(...activeChunk),
        );
      }
      let results: D1Result[];
      try {
        results = await db.batch(stmts);
      } catch (err) {
        // crawler_milestones missing (0024 not applied) → retry without it
        if (!/crawler_milestones/.test(String(err))) throw err;
        stmts.splice(3, 1);
        results = await db.batch(stmts);
        results.splice(3, 0, { results: [], success: true, meta: {} } as unknown as D1Result);
      }
      for (const r of results[0].results as unknown as (Agg & { site_id: string })[]) agg.set(r.site_id, r);
      for (const r of results[1].results as unknown as { site_id: string; day: string; uv: number; pv: number; ivt: number }[]) {
        (daily.get(r.site_id) ?? daily.set(r.site_id, new Map()).get(r.site_id)!).set(r.day, { uv: r.uv, pv: r.pv, ivt: r.ivt });
      }
      for (const r of results[2].results as unknown as { site_id: string; source: string; medium: string; cur: number; prev: number }[]) {
        const ch = classifyChannel({ refDomain: r.source, utmSource: r.source, utmMedium: r.medium, clickIdType: null });
        if (ch !== 'organic_search' && ch !== 'ai') continue;
        const o = organic.get(r.site_id) ?? { o: 0, a: 0, op: 0, ap: 0 };
        if (ch === 'ai') { o.a += r.cur; o.ap += r.prev; } else { o.o += r.cur; o.op += r.prev; }
        organic.set(r.site_id, o);
      }
      for (const r of results[3].results as unknown as { site_id: string; engine: string; kind: string; first_seen_at: number; last_seen_at: number }[]) {
        (crawl.get(r.site_id) ?? crawl.set(r.site_id, new Map()).get(r.site_id)!).set(r.engine, r);
      }
      if (activeChunk.length) {
        for (const r of results[4].results as unknown as { day: string; uv: number; pv: number; ivt: number }[]) {
          const t = totalSeries.get(r.day) ?? { uv: 0, pv: 0, ivt: 0, o: 0, a: 0 };
          t.uv += r.uv; t.pv += r.pv; t.ivt += r.ivt; totalSeries.set(r.day, t);
        }
        for (const r of results[5].results as unknown as { day: string; source: string; medium: string; uv: number }[]) {
          const ch = classifyChannel({ refDomain: r.source, utmSource: r.source, utmMedium: r.medium, clickIdType: null });
          if (ch !== 'organic_search' && ch !== 'ai') continue;
          const t = totalSeries.get(r.day) ?? { uv: 0, pv: 0, ivt: 0, o: 0, a: 0 };
          if (ch === 'ai') t.a += r.uv; else t.o += r.uv;
          totalSeries.set(r.day, t);
        }
      }
    }
  }

  const allIds = rows.map((r) => r.site_id);

  // ---- first organic / AI visit (stage + stage_since) ----------------------
  // a lifetime read of rollup_source_daily, narrowed to search/AI sources and
  // to sites that were crawled or show organic traffic now — never-crawled,
  // never-organic sites (most new ones) are skipped
  const needFirst = rows.filter((r) => crawl.has(r.site_id) || (organic.get(r.site_id)?.o ?? 0) + (organic.get(r.site_id)?.a ?? 0) > 0)
    .map((r) => r.site_id);
  if (needFirst.length) {
    const stmts: D1PreparedStatement[] = [];
    for (let i = 0; i < needFirst.length; i += PORTFOLIO_CHUNK) {
      const ids = needFirst.slice(i, i + PORTFOLIO_CHUNK);
      stmts.push(db.prepare(`
        SELECT site_id, source, medium, MIN(day) AS first_day FROM rollup_source_daily
        WHERE site_id IN (${ids.map(() => '?').join(',')}) AND uv_clean > 0 AND ${searchPred}
        GROUP BY site_id, source, medium`).bind(...ids));
    }
    for (const res of await db.batch(stmts)) {
      for (const r of res.results as unknown as { site_id: string; source: string; medium: string; first_day: string }[]) {
        const ch = classifyChannel({ refDomain: r.source, utmSource: r.source, utmMedium: r.medium, clickIdType: null });
        if (ch !== 'organic_search' && ch !== 'ai') continue;
        const cur = firstOrganicDay.get(r.site_id);
        if (!cur || r.first_day < cur) firstOrganicDay.set(r.site_id, r.first_day);
      }
    }
  }

  // ---- external data (integrations stream) --------------------------------
  const anyPeriod = parsePeriod(token, 'UTC', now);
  let external: Record<string, ExternalSite> = {};
  try { external = await loadExternal(db, allIds, anyPeriod); } catch (err) { console.error('loadExternal failed', err); }

  // ---- per-site rows -------------------------------------------------------
  const sites: PortfolioSite[] = rows.map((r) => {
    const w = winOf.get(r.site_id)!;
    const a = agg.get(r.site_id);
    const z = (n: number | undefined) => n ?? 0;
    const uv = z(a?.uv), pv = z(a?.pv);
    const uvPrev = Math.round(z(a?.uv_p) + z(a?.uv_pl) * w.frac);
    const pvPrev = Math.round(z(a?.pv_p) + z(a?.pv_pl) * w.frac);
    const ivtPrev = z(a?.ivt_p) + z(a?.ivt_pl) * w.frac;
    const days = daily.get(r.site_id) ?? new Map();
    const status = r.status || 'active';
    const firstDataAt = r.first_day ? dayStart(r.first_day, w.tz) : null;
    const hasData = !!r.first_day || r.last_event_at != null;
    const ms = crawl.get(r.site_id);
    let firstSearch: number | null = null;
    for (const m of ms?.values() ?? []) if (firstSearch == null || m.first_seen_at < firstSearch) firstSearch = m.first_seen_at;
    const fo = firstOrganicDay.get(r.site_id);
    const org = organic.get(r.site_id) ?? { o: 0, a: 0, op: 0, ap: 0 };
    const firstOrganicAt = fo ? dayStart(fo, w.tz) : (org.o + org.a > 0 ? w.period.startTs : null);

    // 14-day series + health, oldest first
    const series: { day: string; uv: number }[] = [];
    const health: Health[] = [];
    const createdDay = (() => { const c = localYMD(r.created_at, w.tz); return dayStr(c.y, c.m0, c.d); })();
    for (let k = SERIES_DAYS - 1; k >= 0; k--) {
      const day = shift(w.today, -k);
      const d = days.get(day);
      series.push({ day, uv: d?.uv ?? 0 });
      if (day < createdDay || !r.first_day || day < r.first_day) health.push('none');
      else if (!d || d.pv === 0) health.push(day === w.today ? 'none' : 'bad');
      else {
        const share = d.pv >= th.ivt_min_pv ? (d.ivt / d.pv) * 100 : 0;
        health.push(share > th.ivt_pct ? 'bad' : share > th.ivt_pct / 2 ? 'warn' : 'ok');
      }
    }

    // stage
    const stageIn: StageInput = {
      status, has_data: hasData, first_data_at: firstDataAt, first_search_crawl_at: firstSearch, first_organic_at: firstOrganicAt,
      clean_uv_7d: cleanUv(z(a?.uv7), z(a?.c7), z(a?.pv7)), clean_uv_prev_7d: cleanUv(z(a?.uv7p), z(a?.c7p), z(a?.pv7p)),
      clean_uv_28d: cleanUv(z(a?.uv28), z(a?.c28), z(a?.pv28)), clean_uv_prev_28d: cleanUv(z(a?.uv28p), z(a?.c28p), z(a?.pv28p)),
      growing_since: growingSince(series, w, th), declining_since: dayStart(w.l28[0], w.tz),
    };
    const { stage, since } = computeStage(stageIn, th);

    const yday = shift(w.today, -1);
    const yd = days.get(yday);
    const attention = computeAttention({
      ...stageIn, created_at: r.created_at, last_event_at: r.last_event_at, adguard_mode: r.adguard_mode || 'off', stage,
      uv_28d: z(a?.uv28), uv_prev_28d: z(a?.uv28p),
      ivt_pct: ivtPct(z(a?.ivt), pv), ivt_pct_prev: ivtPct(ivtPrev, pvPrev), pv,
      last_day_ivt_pct: yd ? ivtPct(yd.ivt, yd.pv) : null, last_day_pv: yd?.pv ?? 0,
    }, th, now);
    const ext = external[r.site_id] ?? null;
    if (ext?.attention?.length && status === 'active') attention.push(...ext.attention);
    attention.sort((x, y) => (SEV_RANK[x.severity] ?? 9) - (SEV_RANK[y.severity] ?? 9));

    const crawlOut = {} as PortfolioSite['crawl'];
    for (const [k, engine] of Object.entries(CRAWL_ENGINES) as [keyof typeof CRAWL_ENGINES, string][]) {
      const m = ms?.get(engine);
      crawlOut[k] = m ? { first_seen_at: m.first_seen_at, last_seen_at: m.last_seen_at } : null;
    }
    let domains: string[] = [];
    try { const d = JSON.parse(r.allowed_domains); if (Array.isArray(d)) domains = d.map(String); } catch { /* malformed → none */ }
    let tags: string[] = [];
    try { const t = JSON.parse(r.tags || '[]'); if (Array.isArray(t)) tags = t.filter((x) => typeof x === 'string'); } catch { /* none */ }

    return {
      site_id: r.site_id, name: r.name, domains, status,
      created_at: r.created_at, days_live: Math.max(0, Math.floor((now - r.created_at) / DAY)), timezone: w.tz,
      starred: !!r.starred, tags, cohort: cohortTag(r.created_at, w.tz), adguard_mode: r.adguard_mode || 'off',
      stage, stage_since: since,
      uv, uv_prev: uvPrev, pv, pv_prev: pvPrev, delta_pct: compare ? pct(uv, uvPrev) : null,
      series,
      organic_uv: org.o, ai_uv: org.a, ivt_pct: ivtPct(z(a?.ivt), pv),
      crawl: crawlOut, first_search_crawl_at: firstSearch, last_event_at: r.last_event_at,
      health, attention, external: ext,
      // internal, stripped below
      _o: org, _ivt: z(a?.ivt), _ivtPrev: ivtPrev, _clean7: stageIn.clean_uv_7d,
    } as PortfolioSite & { _o: typeof org; _ivt: number; _ivtPrev: number; _clean7: number };
  });

  // ---- totals / funnel / counts (active sites) -----------------------------
  const active = sites.filter((s) => s.status === 'active') as (PortfolioSite & { _o: { o: number; a: number; op: number; ap: number }; _ivt: number; _ivtPrev: number; _clean7: number })[];
  const sum = (f: (s: (typeof active)[number]) => number) => active.reduce((acc, s) => acc + f(s), 0);
  const tUv = sum((s) => s.uv), tPv = sum((s) => s.pv), tUvP = sum((s) => s.uv_prev), tPvP = sum((s) => s.pv_prev);
  const sorted = active.map((s) => s.uv).sort((x, y) => y - x);
  const topN = Math.max(1, Math.ceil(active.length * 0.1));
  // every day of the period (UTC-resolved), zero-filled, plus sites launched that day
  const days: string[] = [];
  for (let d = anyPeriod.start; d <= anyPeriod.end && days.length < 800; d = shift(d, 1)) days.push(d);
  for (const k of totalSeries.keys()) if (!days.includes(k)) days.push(k);
  days.sort();
  const launched = new Map<string, number>();
  for (const s of active) {
    const c = localYMD(s.created_at, s.timezone);
    const d = dayStr(c.y, c.m0, c.d);
    launched.set(d, (launched.get(d) ?? 0) + 1);
  }
  const stageCounts = Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<Stage, number>;
  for (const s of sites) stageCounts[s.stage]++;

  const out: PortfolioPayload = {
    period: { token, start: anyPeriod.start, end: anyPeriod.end },
    compare,
    generated_at: now,
    thresholds: th,
    totals: {
      uv: tUv, uv_prev: tUvP, pv: tPv, pv_prev: tPvP,
      ivt_pct: ivtPct(sum((s) => s._ivt), tPv), ivt_pct_prev: ivtPct(sum((s) => s._ivtPrev), tPvP),
      organic_uv: sum((s) => s._o.o), organic_uv_prev: sum((s) => s._o.op),
      ai_uv: sum((s) => s._o.a), ai_uv_prev: sum((s) => s._o.ap),
      top10_share: tUv > 0 ? Math.round((sorted.slice(0, topN).reduce((a, b) => a + b, 0) / tUv) * 1000) / 1000 : null,
      series: days.map((day) => {
        const t = totalSeries.get(day) ?? { uv: 0, pv: 0, ivt: 0, o: 0, a: 0 };
        return { day, uv: t.uv, pv: t.pv, ivt_pct: ivtPct(t.ivt, t.pv), organic_uv: t.o, ai_uv: t.a, launched_per_day: launched.get(day) ?? 0 };
      }),
    },
    funnel: {
      total: active.length,
      has_data: active.filter((s) => s.stage !== 'setup').length,
      google_crawled: active.filter((s) => s.crawl.google).length,
      organic: active.filter((s) => firstOrganicDay.has(s.site_id) || s._o.o + s._o.a > 0).length,
      weekly_1000: active.filter((s) => s._clean7 >= th.growth_uv_7d).length,
    },
    stage_counts: stageCounts,
    attention_count: active.filter((s) => s.attention.length > 0).length,
    sites: sites.map((s) => {
      const { _o, _ivt, _ivtPrev, _clean7, ...rest } = s as PortfolioSite & Record<string, unknown>;
      void _o; void _ivt; void _ivtPrev; void _clean7;
      return rest as PortfolioSite;
    }),
  };
  return out;
}

/** Best-effort start of the current growth run: the earliest day d in the
 *  series such that every trailing-7-day uv sum from d onwards stays at or
 *  above the growth threshold (raw uv, so an upper bound of clean). */
function growingSince(series: { day: string; uv: number }[], w: Windows, th: Thresholds): number | null {
  let since: string | null = null;
  for (let k = series.length - 1; k >= 6; k--) {
    let s = 0;
    for (let j = k - 6; j <= k; j++) s += series[j].uv;
    if (s >= th.growth_uv_7d) since = series[k - 6].day; else break;
  }
  return since ? dayStart(since, w.tz) : null;
}

/** The caller's sites (all statuses; the self-test site excluded), with their
 *  labels, last event (one index seek on sessions per site) and first day with
 *  data (first rollup row with pageviews). */
export async function listSites(db: D1Database, ownerId: string | null, siteId: string | null = null): Promise<SiteRow[]> {
  const where = ["s.name != '__pvuv_selftest'"];
  const binds: unknown[] = [];
  if (ownerId) { where.push('s.owner_id = ?'); binds.push(ownerId); }
  if (siteId) { where.push('s.site_id = ?'); binds.push(siteId); }
  const base = `s.site_id, s.name, s.allowed_domains, s.status, s.created_at, s.timezone, s.adguard_mode,
    (SELECT started_at FROM sessions WHERE sessions.site_id = s.site_id ORDER BY started_at DESC LIMIT 1) AS last_event_at,
    (SELECT day FROM rollup_site_daily r WHERE r.site_id = s.site_id AND r.pv > 0 ORDER BY day LIMIT 1) AS first_day`;
  try {
    const r = await db.prepare(`SELECT ${base}, l.starred, l.tags FROM sites s LEFT JOIN site_labels l ON l.site_id = s.site_id
      WHERE ${where.join(' AND ')} ORDER BY s.created_at DESC`).bind(...binds).all<SiteRow>();
    return r.results;
  } catch {
    // 0026 not applied yet → no labels
    const r = await db.prepare(`SELECT ${base} FROM sites s WHERE ${where.join(' AND ')} ORDER BY s.created_at DESC`)
      .bind(...binds).all<SiteRow>();
    return r.results;
  }
}

/** portfolio() behind a 5-minute per-(owner, period, compare) edge cache
 *  (Cache API; absent outside Workers, e.g. in tests → uncached). `fresh`
 *  bypasses and refreshes it — the console sends it after a write. */
export async function cachedPortfolio(
  db: D1Database, ownerId: string | null, period: string | null, compare: string | null, fresh = false,
): Promise<{ body: string; hit: boolean }> {
  const cache = (globalThis as unknown as { caches?: { default?: Cache } }).caches?.default;
  const key = new Request(`https://portfolio.cache/v1/${encodeURIComponent(ownerId ?? '*')}/${encodeURIComponent(period || '7d')}/${encodeURIComponent(compare || 'previous')}`);
  if (cache && !fresh) {
    const hit = await cache.match(key);
    if (hit) return { body: await hit.text(), hit: true };
  }
  const body = JSON.stringify(await portfolio(db, null, { ownerId, period, compare }));
  if (cache) {
    try {
      await cache.put(key, new Response(body, { headers: { 'content-type': 'application/json', 'cache-control': `max-age=${CACHE_TTL_S}` } }));
    } catch { /* cache is best effort */ }
  }
  return { body, hit: false };
}
