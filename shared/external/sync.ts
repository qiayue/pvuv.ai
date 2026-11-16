/**
 * External data sync (cron worker; also "sync now" in the console).
 *
 * Modes:
 *   daily  — full pass: list properties (AdSense sites, Search Console
 *            properties, Adsterra domains), re-map them to sites, pull revenue
 *            for the last 7 days (28 on the first run), policy issues, Search
 *            Console + ads.txt for every property not refreshed in ~20 h.
 *   hourly — light pass: revenue for yesterday + today, and continue the
 *            Search Console / ads.txt rotation within a small call budget
 *            (spreads 500 sites over several runs instead of one huge burst).
 *   manual — like daily for the requested sources, ignoring quota backoff.
 *
 * Failure policy: never throws. Each source is isolated (its own try/catch,
 * its own status row); within a source each property is isolated (its error
 * is stored on the property and the loop continues). Quota errors back off
 * exponentially per source. Everything is an idempotent upsert, so re-running
 * any pass is harmless.
 */

import {
  type FetchFn, ExtError, refreshGoogleToken, adsenseAccounts, adsenseSites, adsenseReport, adsensePolicyIssues,
  adsenseAlerts, gscSites, gscQuery, inspectUrl, type AdsenseSite, type AdsensePolicyIssue,
} from './google';
import { adsterraDomains, adsterraStats } from './adsterra';
import { buildDomainIndex, matchSite, normalizeHost, gscPropertyHost, gscPreference, parseDomains, type DomainIndex } from './domains';
import {
  type ExtEnv, type Source, type GoogleCredential, type AdsterraCredential, googleClient, loadCredential, getStatus,
  recordRun, propertyUpsertStmt, dailyUpsertStmt, properties, runBatched, type PropertyUpsert, type DailyUpsert,
} from './store';

export type SyncMode = 'daily' | 'hourly' | 'manual';

export interface SyncOptions {
  mode: SyncMode;
  now?: number;
  fetchFn?: FetchFn;
  sources?: Source[];
  /** max outbound calls per run for the rotating per-property work */
  budget?: number;
}

export interface SourceResult { ran: boolean; ok?: boolean; error?: string; skipped?: string; stats?: Record<string, unknown> }

const DAY = 86400e3;
/** a property refreshed more recently than this is skipped by the rotation */
const STALE_MS = 20 * 3600e3;

export function ymd(ts: number): string { return new Date(ts).toISOString().slice(0, 10); }

interface SiteInfo { site_id: string; domains: string[]; adclient: string | null }

async function activeSites(db: D1Database): Promise<SiteInfo[]> {
  const r = await db.prepare(
    "SELECT site_id, allowed_domains, adclient FROM sites WHERE status = 'active' AND name != '__pvuv_selftest'",
  ).all<{ site_id: string; allowed_domains: string; adclient: string | null }>();
  return r.results.map((s) => ({ site_id: s.site_id, domains: parseDomains(s.allowed_domains), adclient: s.adclient }));
}

async function hasDaily(db: D1Database, source: Source): Promise<boolean> {
  return !!(await db.prepare('SELECT 1 AS x FROM ext_daily WHERE source = ? LIMIT 1').bind(source).first());
}

async function mappingOf(db: D1Database, source: Source): Promise<Map<string, string | null>> {
  const m = new Map<string, string | null>();
  for (const p of await properties(db, source)) m.set(p.property_id, p.site_id);
  return m;
}

function errText(e: unknown): string { return e instanceof Error ? e.message : String(e); }

export async function runExternalSync(env: ExtEnv, opts: SyncOptions): Promise<Record<Source, SourceResult>> {
  const now = opts.now ?? Date.now();
  const fetchFn = opts.fetchFn ?? ((...a: Parameters<FetchFn>) => fetch(...a));
  const wanted = new Set<Source>(opts.sources ?? ['adsense', 'gsc', 'adsterra', 'ads_txt']);
  const out = {} as Record<Source, SourceResult>;
  let budget = opts.budget ?? (opts.mode === 'hourly' ? 120 : 400);
  const spend = (n: number) => { if (budget < n) return false; budget -= n; return true; };

  let sites: SiteInfo[];
  try {
    sites = await activeSites(env.DB);
    await env.DB.prepare('SELECT 1 FROM ext_sync_status LIMIT 1').first();
  } catch (e) {
    // tables missing (migration 0028 not applied) → feature off, quietly
    for (const s of wanted) out[s] = { ran: false, skipped: 'not installed' };
    return out;
  }
  const index = buildDomainIndex(sites);

  const inBackoff = async (s: Source) => {
    if (opts.mode === 'manual') return false;
    const st = await getStatus(env.DB, s);
    return !!(st?.backoff_until && st.backoff_until > now);
  };

  const guard = async (s: Source, fn: () => Promise<Record<string, unknown> | null>) => {
    if (!wanted.has(s)) return;
    if (await inBackoff(s)) { out[s] = { ran: false, skipped: 'backoff' }; return; }
    try {
      const stats = await fn();
      if (stats === null) { out[s] = { ran: false, skipped: 'not connected' }; return; }
      await recordRun(env.DB, s, now, { ok: true, stats });
      out[s] = { ran: true, ok: true, stats };
    } catch (e) {
      const msg = errText(e);
      await recordRun(env.DB, s, now, { ok: false, error: msg, quota: e instanceof ExtError && e.kind === 'quota' });
      out[s] = { ran: true, ok: false, error: msg };
    }
  };

  // --- Google: one access token for AdSense + Search Console, fetched lazily
  // (a source in backoff must not cost a token refresh)
  let google: Promise<string | null> | null = null;
  const googleToken = () => google ??= (async () => {
    const cred = await loadCredential<GoogleCredential>(env, 'google');
    if (!cred) return null;
    const client = googleClient(env);
    if (!client) throw new Error('Google OAuth client id/secret are not configured on this worker');
    return refreshGoogleToken(fetchFn, client, cred.refresh_token);
  })();
  const withGoogle = (fn: (token: string) => Promise<Record<string, unknown>>) => async () => {
    const token = await googleToken();
    return token ? fn(token) : null;
  };

  await guard('adsense', withGoogle((t) => syncAdsense(env, t, fetchFn, opts.mode, now, index)));
  await guard('adsterra', async () => {
    const cred = await loadCredential<AdsterraCredential>(env, 'adsterra');
    if (!cred) return null;
    return syncAdsterra(env, cred.token, fetchFn, opts.mode, now, index);
  });
  await guard('gsc', withGoogle((t) => syncGsc(env, t, fetchFn, opts.mode, now, index, spend)));
  await guard('ads_txt', () => syncAdsTxt(env, fetchFn, now, sites, spend));
  return out;
}

// ---------------------------------------------------------------------------
// AdSense
// ---------------------------------------------------------------------------

/** Worst-first ranking of policy actions (higher = worse). */
const POLICY_RANK: Record<string, number> = {
  AD_SERVING_DISABLED: 5, AD_SERVING_RESTRICTED: 4, AD_SERVED_WITH_CLICK_CONFIRMATION: 3,
  AD_PERSONALIZATION_RESTRICTED: 2, WARNED: 1,
};

async function syncAdsense(
  env: ExtEnv, token: string, fetchFn: FetchFn, mode: SyncMode, now: number, index: DomainIndex,
): Promise<Record<string, unknown>> {
  const db = env.DB;
  const accounts = await adsenseAccounts(fetchFn, token);
  const pubIds = accounts.map((a) => a.name.replace(/^accounts\//, ''));
  const full = mode !== 'hourly';
  const props: PropertyUpsert[] = [];
  let alerts: Array<{ severity?: string; type?: string; message?: string }> = [];

  if (full) {
    for (const acc of accounts) {
      const sites: AdsenseSite[] = await adsenseSites(fetchFn, token, acc.name);
      let issues: AdsensePolicyIssue[] = [];
      try { issues = await adsensePolicyIssues(fetchFn, token, acc.name); } catch (e) {
        if (e instanceof ExtError && e.kind === 'quota') throw e; // other failures: policy data is optional
      }
      try {
        alerts = alerts.concat((await adsenseAlerts(fetchFn, token, acc.name))
          .map((a) => ({ severity: a.severity, type: a.type, message: String(a.message ?? '').replace(/<[^>]*>/g, '').slice(0, 300) })));
      } catch (e) { if (e instanceof ExtError && e.kind === 'quota') throw e; }
      const policyBySite = new Map<string, { action: string; topics: string[]; entity: string | null }>();
      for (const i of issues) {
        const host = normalizeHost(i.site || i.uri || '');
        if (!host || !i.action) continue;
        const prev = policyBySite.get(host);
        if (!prev || (POLICY_RANK[i.action] ?? 0) > (POLICY_RANK[prev.action] ?? 0)) {
          policyBySite.set(host, { action: i.action, topics: (i.policyTopics ?? []).map((t) => t.topic ?? '').filter(Boolean).slice(0, 5), entity: i.entityType ?? null });
        }
      }
      for (const s of sites) {
        const host = normalizeHost(s.domain);
        if (!host) continue;
        props.push({
          source: 'adsense', property_id: host, label: s.domain, domain: host,
          site_id: matchSite(index, host), state: (s.state ?? 'STATE_UNSPECIFIED').toLowerCase(),
          detail: { account: acc.name, auto_ads: !!s.autoAdsEnabled, policy: policyBySite.get(host) ?? null },
        });
      }
    }
  }

  // revenue: last 2 days hourly, 7 daily, 28 on the very first run
  const days = !full ? 2 : (await hasDaily(db, 'adsense')) ? 7 : 28;
  const start = ymd(now - (days - 1) * DAY);
  const end = ymd(now);
  const rows = new Map<string, DailyUpsert>();
  const seenHosts = new Map<string, string>();
  for (const acc of accounts) {
    const usd = await adsenseReport(fetchFn, token, acc.name, start, end, 'USD');
    let orig: Awaited<ReturnType<typeof adsenseReport>> | null = null;
    try { orig = await adsenseReport(fetchFn, token, acc.name, start, end); } catch (e) {
      if (e instanceof ExtError && e.kind === 'quota') throw e;
    }
    const origBy = new Map<string, number>();
    for (const r of orig?.rows ?? []) {
      const k = `${r.day}|${normalizeHost(r.domain)}`;
      origBy.set(k, (origBy.get(k) ?? 0) + r.earnings);
    }
    for (const r of usd.rows) {
      const host = normalizeHost(r.domain);
      if (!host) continue;
      seenHosts.set(host, r.domain);
      const key = `${r.day}|${host}`;
      const prev = rows.get(key);
      const row: DailyUpsert = prev ?? {
        source: 'adsense', property_id: host, day: r.day, site_id: null, impressions: 0, clicks: 0, pageviews: 0,
        revenue: 0, currency: orig?.currency ?? 'USD', revenue_usd: 0,
      };
      row.impressions += r.impressions; row.clicks += r.clicks; row.pageviews = (row.pageviews ?? 0) + r.pageviews;
      row.revenue_usd = (row.revenue_usd ?? 0) + r.earnings;
      // original currency: the account-currency report's figure for the same day/host
      row.revenue = orig ? (origBy.get(key) ?? 0) : row.revenue_usd;
      if (!orig) row.currency = 'USD';
      rows.set(key, row);
    }
  }
  // a domain that earns but is not in the sites list (e.g. a subdomain) is still a property
  const known = new Set(props.map((p) => p.property_id));
  const existing = await mappingOf(db, 'adsense');
  for (const [host, label] of seenHosts) {
    if (!known.has(host) && !existing.has(host)) {
      props.push({ source: 'adsense', property_id: host, label, domain: host, site_id: matchSite(index, host), state: null });
    }
  }
  await runBatched(db, props.map((p) => propertyUpsertStmt(db, p, now)));
  const mapping = await mappingOf(db, 'adsense');
  const stmts = [...rows.values()].map((r) => dailyUpsertStmt(db, { ...r, site_id: mapping.get(r.property_id) ?? null }, now));
  await runBatched(db, stmts);
  return { accounts: pubIds, properties: full ? props.length : undefined, days_written: rows.size, range: [start, end], alerts: full ? alerts : undefined };
}

// ---------------------------------------------------------------------------
// Adsterra
// ---------------------------------------------------------------------------

async function syncAdsterra(
  env: ExtEnv, token: string, fetchFn: FetchFn, mode: SyncMode, now: number, index: DomainIndex,
): Promise<Record<string, unknown>> {
  const db = env.DB;
  const full = mode !== 'hourly';
  let mapping = await mappingOf(db, 'adsterra');
  if (full || mapping.size === 0) {
    const domains = await adsterraDomains(fetchFn, token);
    await runBatched(db, domains.map((d) => {
      const host = normalizeHost(d.title);
      return propertyUpsertStmt(db, {
        source: 'adsterra', property_id: String(d.id), label: d.title, domain: host,
        site_id: matchSite(index, host), state: 'listed',
      }, now);
    }));
    mapping = await mappingOf(db, 'adsterra');
  }
  const days = !full ? 2 : (await hasDaily(db, 'adsterra')) ? 7 : 28;
  const start = ymd(now - (days - 1) * DAY);
  const end = ymd(now);
  const stats = await adsterraStats(fetchFn, token, start, end);
  const rows = new Map<string, DailyUpsert>();
  for (const r of stats) {
    const key = `${r.day}|${r.domain_id}`;
    const row = rows.get(key) ?? {
      source: 'adsterra' as const, property_id: r.domain_id, day: r.day, site_id: mapping.get(r.domain_id) ?? null,
      impressions: 0, clicks: 0, revenue: 0, currency: 'USD', revenue_usd: 0,
    };
    row.impressions += r.impressions; row.clicks += r.clicks;
    row.revenue = (row.revenue ?? 0) + r.revenue; row.revenue_usd = (row.revenue_usd ?? 0) + r.revenue;
    rows.set(key, row);
  }
  await runBatched(db, [...rows.values()].map((r) => dailyUpsertStmt(db, r, now)));
  return { properties: mapping.size, days_written: rows.size, range: [start, end] };
}

// ---------------------------------------------------------------------------
// Search Console
// ---------------------------------------------------------------------------

async function syncGsc(
  env: ExtEnv, token: string, fetchFn: FetchFn, mode: SyncMode, now: number, index: DomainIndex,
  spend: (n: number) => boolean,
): Promise<Record<string, unknown>> {
  const db = env.DB;
  let props = await properties(db, 'gsc');
  if (mode !== 'hourly' || props.length === 0) {
    const sites = await gscSites(fetchFn, token);
    await runBatched(db, sites.map((s) => {
      const { host, domainProperty } = gscPropertyHost(s.siteUrl);
      return propertyUpsertStmt(db, {
        source: 'gsc', property_id: s.siteUrl, label: s.siteUrl, domain: host,
        site_id: matchSite(index, host, domainProperty), state: null, touch: false,
      }, now);
    }));
    props = await properties(db, 'gsc');
  }

  // one property per site (their data overlaps): the preferred one is synced,
  // the others are marked duplicate and their rows detached from the site
  const bySite = new Map<string, typeof props>();
  for (const p of props) if (p.site_id) bySite.set(p.site_id, [...(bySite.get(p.site_id) ?? []), p]);
  const primary = new Set<string>();
  const dupStmts: D1PreparedStatement[] = [];
  for (const list of bySite.values()) {
    list.sort((a, b) => gscPreference(a.property_id) - gscPreference(b.property_id));
    primary.add(list[0].property_id);
    for (const d of list.slice(1)) {
      if (d.state !== 'duplicate') {
        dupStmts.push(db.prepare("UPDATE ext_properties SET state = 'duplicate' WHERE source = 'gsc' AND property_id = ?").bind(d.property_id));
        dupStmts.push(db.prepare("UPDATE ext_daily SET site_id = NULL WHERE source = 'gsc' AND property_id = ?").bind(d.property_id));
      }
    }
  }
  for (const p of props) {
    if (primary.has(p.property_id) && p.state === 'duplicate') {
      dupStmts.push(db.prepare("UPDATE ext_properties SET state = 'active' WHERE source = 'gsc' AND property_id = ?").bind(p.property_id));
      dupStmts.push(db.prepare("UPDATE ext_daily SET site_id = ? WHERE source = 'gsc' AND property_id = ?").bind(p.site_id, p.property_id));
    }
  }
  await runBatched(db, dupStmts);

  // rotation: stalest primary properties first, 3 calls each, within budget
  const firstRun = !(await hasDaily(db, 'gsc'));
  const due = props
    .filter((p) => primary.has(p.property_id) && (mode === 'manual' || !p.checked_at || now - p.checked_at > STALE_MS))
    .sort((a, b) => (a.checked_at ?? 0) - (b.checked_at ?? 0));
  const siteDomain = new Map<string, string>();
  let done = 0, failed = 0;
  for (const p of due) {
    if (!spend(3)) break;
    const days = firstRun || !p.checked_at ? 28 : 7;
    const start = ymd(now - (days - 1) * DAY);
    const end = ymd(now);
    try {
      const daily = await gscQuery(fetchFn, token, p.property_id, { startDate: start, endDate: end, dimensions: ['date'], rowLimit: 1000 });
      const pages = await gscQuery(fetchFn, token, p.property_id, {
        startDate: ymd(now - 27 * DAY), endDate: end, dimensions: ['page'], rowLimit: 25000,
      });
      // Homepage index status. URL-prefix properties: the prefix itself; Domain
      // properties: https://<host>/ (or the mapped site's first domain).
      let home = p.property_id;
      if (/^sc-domain:/i.test(home)) {
        if (!siteDomain.size) for (const e of index.all) if (!siteDomain.has(e.site_id)) siteDomain.set(e.site_id, e.host);
        home = `https://${(p.site_id && siteDomain.get(p.site_id)) || normalizeHost(home)}/`;
      }
      let idx: Awaited<ReturnType<typeof inspectUrl>> | null = null;
      try { idx = await inspectUrl(fetchFn, token, p.property_id, home); } catch (e) {
        if (e instanceof ExtError && e.kind === 'quota') throw e;
      }
      const stmts = daily.map((r) => dailyUpsertStmt(db, {
        source: 'gsc', property_id: p.property_id, day: String(r.keys?.[0] ?? ''), site_id: p.site_id,
        impressions: Math.round(r.impressions ?? 0), clicks: Math.round(r.clicks ?? 0), position: r.position ?? null,
      }, now)).filter((_, i) => /^\d{4}-\d{2}-\d{2}$/.test(String(daily[i].keys?.[0] ?? '')));
      stmts.push(db.prepare(`
        UPDATE ext_properties SET state = 'active', indexed_pages = ?, detail = ?, error = NULL, checked_at = ?, updated_at = ?
        WHERE source = 'gsc' AND property_id = ?
      `).bind(pages.length, JSON.stringify({
        home_url: home, home_verdict: idx?.verdict ?? null, home_coverage: idx?.coverageState ?? null,
        home_last_crawl: idx?.lastCrawlTime ?? null, pages_capped: pages.length >= 25000,
      }), now, now, p.property_id));
      await runBatched(db, stmts);
      done++;
    } catch (e) {
      if (e instanceof ExtError && e.kind === 'quota') throw e;
      failed++;
      await db.prepare("UPDATE ext_properties SET error = ?, updated_at = ? WHERE source = 'gsc' AND property_id = ?")
        .bind(errText(e).slice(0, 300), now, p.property_id).run();
    }
  }
  return { properties: props.length, refreshed: done, failed, pending: due.length - done - failed };
}

// ---------------------------------------------------------------------------
// ads.txt (no credentials: fetched from the site itself)
// ---------------------------------------------------------------------------

/** Evaluate an ads.txt body for the expected publisher ids (pub-…). */
export function checkAdsTxt(body: string, pubIds: string[]): 'ok' | 'missing' | 'mismatch' {
  const want = new Set(pubIds.map((p) => p.toLowerCase()));
  let google = 0;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line || /^[a-z_-]+\s*=/i.test(line)) continue; // variables (contact=, subdomain=)
    const f = line.split(',').map((x) => x.trim().toLowerCase());
    if (f.length < 3 || f[0] !== 'google.com') continue;
    google++;
    if (want.has(f[1]) && f[2] === 'direct') return 'ok';
  }
  return google ? 'mismatch' : 'missing';
}

async function syncAdsTxt(
  env: ExtEnv, fetchFn: FetchFn, now: number, sites: SiteInfo[], spend: (n: number) => boolean,
): Promise<Record<string, unknown> | null> {
  const db = env.DB;
  // expected publisher ids per site: the site's own ad client and/or the
  // AdSense account its AdSense property belongs to
  const adsense = await properties(db, 'adsense');
  const accountBySite = new Map<string, Set<string>>();
  for (const p of adsense) {
    if (!p.site_id) continue;
    let acc = '';
    try { acc = String(JSON.parse(p.detail ?? '{}').account ?? ''); } catch { /* none */ }
    if (acc) accountBySite.set(p.site_id, (accountBySite.get(p.site_id) ?? new Set()).add(acc.replace(/^accounts\//, '')));
  }
  const existing = new Map((await properties(db, 'ads_txt')).map((p) => [p.property_id, p]));
  const targets: Array<{ site: SiteInfo; host: string; pubs: string[] }> = [];
  for (const s of sites) {
    const pubs = new Set(accountBySite.get(s.site_id) ?? []);
    const m = (s.adclient ?? '').match(/pub-\d+/i);
    if (m) pubs.add(m[0].toLowerCase());
    const host = s.domains.map(normalizeHost).find(Boolean);
    if (!pubs.size || !host) continue;
    targets.push({ site: s, host, pubs: [...pubs] });
  }
  if (!targets.length && !existing.size) return null; // nothing monetized to check
  const due = targets
    .filter((t) => { const p = existing.get(t.host); return !p?.checked_at || now - p.checked_at > STALE_MS || p.site_id !== t.site.site_id; })
    .sort((a, b) => (existing.get(a.host)?.checked_at ?? 0) - (existing.get(b.host)?.checked_at ?? 0));
  const counts: Record<string, number> = {};
  for (const t of due) {
    if (!spend(1)) break;
    let status: 'ok' | 'missing' | 'mismatch' | 'error';
    let detail: Record<string, unknown> = { expected: t.pubs };
    try {
      const r = await fetchFn(`https://${t.host}/ads.txt`, { redirect: 'follow', signal: AbortSignal.timeout(8000), headers: { 'user-agent': 'pvuv.ai-adstxt-check' } });
      const ct = r.headers.get('content-type') ?? '';
      if (!r.ok) { status = 'missing'; detail.http = r.status; }
      else if (/text\/html/i.test(ct)) { status = 'missing'; detail.http = r.status; detail.reason = 'html'; }
      else status = checkAdsTxt((await r.text()).slice(0, 200_000), t.pubs);
    } catch (e) {
      status = 'error'; detail = { ...detail, error: errText(e).slice(0, 200) };
    }
    counts[status] = (counts[status] ?? 0) + 1;
    await propertyUpsertStmt(db, {
      source: 'ads_txt', property_id: t.host, label: `${t.host}/ads.txt`, domain: t.host, site_id: t.site.site_id,
      state: status, ads_txt: status, detail,
    }, now).run();
  }
  return { targets: targets.length, checked: Object.values(counts).reduce((a, b) => a + b, 0), ...counts };
}
