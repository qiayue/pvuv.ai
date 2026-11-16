/**
 * External data (ad revenue, ad-network status, search) for the portfolio
 * overview and the site drawer — read side. The cron worker fills the tables
 * (shared/external/sync.ts, migration 0028); this module only reads them.
 *
 * Contract (docs/design/portfolio-ui.md §3.3):
 *   loadExternal(db, siteIds, period) → Record<site_id, ExternalSite>
 * Batched: a fixed handful of queries per chunk of ≤ 90 site ids, all on
 * indexed columns (ext_properties.site_id, ext_daily(site_id, day),
 * rollup_site_daily PK). No per-site queries, no raw-event scans.
 *
 * Sites only appear in the result when there is something external to say
 * about them (a mapped property, an ads.txt check, or a connected ad network
 * to measure "traffic but no revenue" against). Nothing connected → {}.
 */

import { noRevenueMinUv } from '../../../shared/external/store';

export type Severity = 'critical' | 'high' | 'normal';
export interface Attention { code: string; severity: Severity; params?: Record<string, unknown> }

export interface ExternalSite {
  /** ad revenue (AdSense + Adsterra) in the period; null = no ad network connected */
  revenue_usd: number | null;
  revenue_prev_usd: number | null;
  /** revenue per 1,000 clean pageviews (pvuv's own measurement), null without pageviews */
  rpm_usd: number | null;
  adsense: {
    status: string | null;          // ready | getting_ready | requires_review | needs_attention | null (not in AdSense)
    ads_txt: string | null;         // ok | missing | mismatch | error | null (not checked)
    checked_at: number | null;
    revenue_usd?: number;
    policy?: { action: string; topics: string[] } | null;
  } | null;
  adsterra: { status: string | null; checked_at: number | null; revenue_usd?: number } | null;
  search: {
    indexed_pages: number | null;   // pages with ≥ 1 Google impression in 28 days (lower bound)
    impressions: number; clicks: number; checked_at: number | null;
    home_verdict?: string | null; home_coverage?: string | null;
  } | null;
  attention: Attention[];
}

/** Anything with a site-local start/end day (the queries layer's Period fits). */
export interface PeriodLike { start: string; end: string }

const STALE_MS = 48 * 3600e3;
const CHUNK = 90;
const AD_SOURCES = new Set(['adsense', 'adsterra']);

function dayNum(s: string): number { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d) / 86400e3; }
function dayStr(n: number): string { return new Date(n * 86400e3).toISOString().slice(0, 10); }

/** The equally long window immediately before `period`. */
export function previousWindow(period: PeriodLike): PeriodLike {
  const s = dayNum(period.start), e = dayNum(period.end);
  const len = e - s + 1;
  return { start: dayStr(s - len), end: dayStr(s - 1) };
}

const STATE_RANK: Record<string, number> = { needs_attention: 4, requires_review: 3, getting_ready: 2, state_unspecified: 1, ready: 0 };
const ADSTXT_RANK: Record<string, number> = { mismatch: 3, missing: 2, error: 1, ok: 0 };
const worst = (rank: Record<string, number>, a: string | null, b: string | null) =>
  a == null ? b : b == null ? a : ((rank[b] ?? 0) > (rank[a] ?? 0) ? b : a);

const r2 = (n: number) => Math.round(n * 100) / 100;

interface Ctx {
  statuses: Map<string, { last_ok_at: number | null; last_run_at: number | null }>;
  connected: Set<string>; // sources with a credential (or ads_txt with data)
  minUv: number;
  now: number;
}

async function context(db: D1Database, now: number): Promise<Ctx | null> {
  try {
    const [st, cr] = await Promise.all([
      db.prepare('SELECT source, last_ok_at, last_run_at FROM ext_sync_status').all<{ source: string; last_ok_at: number | null; last_run_at: number | null }>(),
      db.prepare('SELECT provider FROM ext_credentials').all<{ provider: string }>(),
    ]);
    const connected = new Set<string>();
    for (const c of cr.results) {
      if (c.provider === 'google') { connected.add('adsense'); connected.add('gsc'); }
      if (c.provider === 'adsterra') connected.add('adsterra');
    }
    return {
      statuses: new Map(st.results.map((s) => [s.source, s])),
      connected, minUv: await noRevenueMinUv(db), now,
    };
  } catch {
    return null; // migration 0028 not applied → no external data
  }
}

interface PropRow { site_id: string; source: string; property_id: string; label: string | null; state: string | null; ads_txt: string | null; indexed_pages: number | null; detail: string | null; checked_at: number | null; mapping: string }
interface DailySum { site_id: string; source: string; rev: number | null; rev_prev: number | null; imp: number | null; clk: number | null; any_cur: number }
interface Traffic { site_id: string; clean_pv: number | null; clean_uv: number | null }

export async function loadExternal(
  db: D1Database, siteIds: string[], period: PeriodLike, now: number = Date.now(),
): Promise<Record<string, ExternalSite>> {
  const out: Record<string, ExternalSite> = {};
  if (!siteIds.length) return out;
  const ctx = await context(db, now);
  if (!ctx) return out;
  const prev = previousWindow(period);
  const adConnected = [...AD_SOURCES].some((s) => ctx.connected.has(s));

  for (let i = 0; i < siteIds.length; i += CHUNK) {
    const ids = siteIds.slice(i, i + CHUNK);
    const ph = ids.map(() => '?').join(',');
    const [props, sums, traffic] = await Promise.all([
      db.prepare(`SELECT site_id, source, property_id, label, state, ads_txt, indexed_pages, detail, checked_at, mapping
        FROM ext_properties WHERE site_id IN (${ph}) AND mapping != 'ignored'`).bind(...ids).all<PropRow>(),
      db.prepare(`SELECT site_id, source,
          SUM(CASE WHEN day >= ? AND day <= ? THEN revenue_usd END) AS rev,
          SUM(CASE WHEN day <= ? THEN revenue_usd END) AS rev_prev,
          SUM(CASE WHEN day >= ? AND day <= ? THEN impressions END) AS imp,
          SUM(CASE WHEN day >= ? AND day <= ? THEN clicks END) AS clk,
          SUM(CASE WHEN day >= ? AND day <= ? THEN 1 ELSE 0 END) AS any_cur
        FROM ext_daily WHERE site_id IN (${ph}) AND day >= ? AND day <= ?
        GROUP BY site_id, source`)
        .bind(period.start, period.end, prev.end, period.start, period.end, period.start, period.end,
          period.start, period.end, ...ids, prev.start, period.end).all<DailySum>(),
      adConnected
        ? db.prepare(`SELECT site_id, SUM(clean_count) AS clean_pv,
              SUM(CASE WHEN pv > 0 THEN uv * 1.0 * clean_count / pv ELSE 0 END) AS clean_uv
            FROM rollup_site_daily WHERE site_id IN (${ph}) AND day >= ? AND day <= ? GROUP BY site_id`)
          .bind(...ids, period.start, period.end).all<Traffic>()
        : Promise.resolve({ results: [] as Traffic[] }),
    ]);

    const propsBySite = new Map<string, PropRow[]>();
    for (const p of props.results) propsBySite.set(p.site_id, [...(propsBySite.get(p.site_id) ?? []), p]);
    const sumBy = new Map<string, DailySum>();
    for (const s of sums.results) sumBy.set(`${s.site_id}|${s.source}`, s);
    const trafficBy = new Map(traffic.results.map((t) => [t.site_id, t]));

    for (const id of ids) {
      const ps = propsBySite.get(id) ?? [];
      const t = trafficBy.get(id);
      if (!ps.length && !(adConnected && t)) continue;
      out[id] = buildSite(id, ps, sumBy, t, period, ctx, adConnected);
    }
  }
  return out;
}

function parseDetail(s: string | null): Record<string, unknown> {
  try { return s ? JSON.parse(s) : {}; } catch { return {}; }
}

function buildSite(
  id: string, ps: PropRow[], sumBy: Map<string, DailySum>, t: Traffic | undefined,
  period: PeriodLike, ctx: Ctx, adConnected: boolean,
): ExternalSite {
  const sum = (src: string) => sumBy.get(`${id}|${src}`);
  const adsenseRev = sum('adsense')?.rev ?? 0;
  const adsterraRev = sum('adsterra')?.rev ?? 0;
  const revenue = adConnected ? r2(adsenseRev + adsterraRev) : null;
  const revenuePrev = adConnected ? r2((sum('adsense')?.rev_prev ?? 0) + (sum('adsterra')?.rev_prev ?? 0)) : null;
  const cleanPv = t?.clean_pv ?? 0;
  const cleanUv = Math.round(t?.clean_uv ?? 0);
  const attention: Attention[] = [];

  // AdSense: worst state over the site's AdSense properties + ads.txt check
  const as = ps.filter((p) => p.source === 'adsense');
  const at = ps.filter((p) => p.source === 'ads_txt');
  let adsense: ExternalSite['adsense'] = null;
  if (as.length || at.length) {
    let status: string | null = null;
    let policy: { action: string; topics: string[] } | null = null;
    const POLICY_RANK: Record<string, number> = { AD_SERVING_DISABLED: 5, AD_SERVING_RESTRICTED: 4, AD_SERVED_WITH_CLICK_CONFIRMATION: 3, AD_PERSONALIZATION_RESTRICTED: 2, WARNED: 1 };
    for (const p of as) {
      status = worst(STATE_RANK, status, p.state);
      const pol = parseDetail(p.detail).policy as { action: string; topics: string[] } | null | undefined;
      if (pol && (!policy || (POLICY_RANK[pol.action] ?? 0) > (POLICY_RANK[policy.action] ?? 0))) policy = pol;
    }
    let adsTxt: string | null = null;
    for (const p of at) adsTxt = worst(ADSTXT_RANK, adsTxt, p.ads_txt);
    const checked = [...as, ...at].map((p) => p.checked_at ?? 0);
    adsense = {
      status, ads_txt: adsTxt, checked_at: Math.max(0, ...checked) || null,
      revenue_usd: r2(adsenseRev), policy,
    };
    const domain = as[0]?.label ?? at[0]?.label?.replace(/\/ads\.txt$/, '') ?? null;
    if (policy?.action === 'AD_SERVING_DISABLED') {
      attention.push({ code: 'network_declined', severity: 'critical', params: { network: 'adsense', domain, topic: policy.topics[0] ?? null } });
    } else if (status === 'needs_attention' || (policy && policy.action !== 'AD_PERSONALIZATION_RESTRICTED')) {
      attention.push({ code: 'adsense_needs_attention', severity: 'high', params: { domain, state: status, action: policy?.action ?? null } });
    }
    if (adsTxt === 'missing' || adsTxt === 'mismatch') {
      attention.push({ code: 'ads_txt_problem', severity: 'high', params: { status: adsTxt, domain: at[0]?.label?.replace(/\/ads\.txt$/, '') ?? domain } });
    }
  }

  const st = ps.filter((p) => p.source === 'adsterra');
  const adsterra: ExternalSite['adsterra'] = st.length
    ? {
      status: (sum('adsterra')?.imp ?? 0) > 0 ? 'active' : 'no_impressions',
      checked_at: ctx.statuses.get('adsterra')?.last_ok_at ?? null,
      revenue_usd: r2(adsterraRev),
    }
    : null;

  const gs = ps.filter((p) => p.source === 'gsc' && p.state !== 'duplicate');
  let search: ExternalSite['search'] = null;
  if (gs.length) {
    const g = gs[0];
    const d = parseDetail(g.detail);
    search = {
      indexed_pages: g.indexed_pages, impressions: sum('gsc')?.imp ?? 0, clicks: sum('gsc')?.clk ?? 0,
      checked_at: g.checked_at, home_verdict: (d.home_verdict as string) ?? null, home_coverage: (d.home_coverage as string) ?? null,
    };
  }

  // traffic but (almost) no ad revenue — only when an ad network is connected
  // and the period spans more than the current, still-accruing day
  if (adConnected && period.start !== period.end && cleanUv >= ctx.minUv && (revenue ?? 0) < 0.01) {
    attention.push({ code: 'traffic_no_revenue', severity: 'high', params: { uv: cleanUv, revenue_usd: revenue ?? 0, min_uv: ctx.minUv } });
  }

  // stale: a source this site depends on has not synced successfully for 48 h
  const usedSources = new Set(ps.map((p) => p.source));
  for (const src of usedSources) {
    if (src !== 'ads_txt' && !ctx.connected.has(src)) continue; // disconnected → shown on the integrations page instead
    const s = ctx.statuses.get(src);
    const lastOk = s?.last_ok_at ?? null;
    if (s?.last_run_at && (!lastOk || ctx.now - lastOk > STALE_MS)) {
      attention.push({
        code: 'external_stale', severity: 'normal',
        params: { source: src, hours: lastOk ? Math.floor((ctx.now - lastOk) / 3600e3) : null },
      });
    }
  }

  return {
    revenue_usd: revenue,
    revenue_prev_usd: revenuePrev,
    rpm_usd: revenue != null && cleanPv > 0 ? r2((revenue / cleanPv) * 1000) : null,
    adsense, adsterra, search, attention,
  };
}

// ---------------------------------------------------------------------------
// per-site detail (drawer): GET /api/sites/{id}/external, /v1/sites/{id}/external
// ---------------------------------------------------------------------------

export async function siteExternal(db: D1Database, siteId: string, period: PeriodLike, now: number = Date.now()) {
  const summary = (await loadExternal(db, [siteId], period, now))[siteId] ?? null;
  const ctx = await context(db, now);
  if (!ctx) return { available: false, period: { start: period.start, end: period.end }, external: null, series: [], properties: [], sources: [] };
  const [series, props] = await Promise.all([
    db.prepare(`SELECT day,
        SUM(CASE WHEN source = 'adsense' THEN revenue_usd ELSE 0 END) AS adsense_usd,
        SUM(CASE WHEN source = 'adsterra' THEN revenue_usd ELSE 0 END) AS adsterra_usd,
        SUM(CASE WHEN source = 'adsense' THEN impressions ELSE 0 END) AS adsense_impressions,
        SUM(CASE WHEN source = 'adsterra' THEN impressions ELSE 0 END) AS adsterra_impressions,
        SUM(CASE WHEN source = 'gsc' THEN clicks ELSE 0 END) AS search_clicks,
        SUM(CASE WHEN source = 'gsc' THEN impressions ELSE 0 END) AS search_impressions
      FROM ext_daily WHERE site_id = ? AND day >= ? AND day <= ? GROUP BY day ORDER BY day`)
      .bind(siteId, period.start, period.end).all<Record<string, number | string>>(),
    db.prepare(`SELECT source, property_id, label, mapping, state, ads_txt, indexed_pages, detail, error, checked_at
      FROM ext_properties WHERE site_id = ? ORDER BY source, label`).bind(siteId).all<Record<string, unknown>>(),
  ]);
  return {
    available: true,
    period: { start: period.start, end: period.end },
    external: summary,
    series: series.results.map((r) => ({
      ...r,
      adsense_usd: r2(Number(r.adsense_usd) || 0), adsterra_usd: r2(Number(r.adsterra_usd) || 0),
    })),
    properties: props.results.map((p) => ({ ...p, detail: parseDetail(p.detail as string | null) })),
    sources: [...ctx.statuses.entries()].map(([source, s]) => ({ source, connected: source === 'ads_txt' || ctx.connected.has(source), last_ok_at: s.last_ok_at, last_run_at: s.last_run_at })),
  };
}
