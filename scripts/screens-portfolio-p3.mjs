// Screenshots of the external-integrations screens with MOCKED API data —
// docs/design/screens/p3-*.png. No worker needed: Playwright serves
// workers/console/public from disk and answers /api/* from fixtures below
// (the portfolio fixture mirrors scripts/screens-portfolio-p1.mjs, plus the
// `external` field that loadExternal() fills).
//
//   NODE_PATH=$(npm root -g) node scripts/screens-portfolio-p3.mjs [outDir]
//
// All names and numbers are fictional.
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = new URL('../workers/console/public/', import.meta.url).pathname;
const OUT = process.argv[2] || new URL('../docs/design/screens/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const DAY = 86400000;
const NOW = Date.UTC(2026, 10, 16, 9, 30);
const dayOf = (o) => new Date(NOW + o * DAY).toISOString().slice(0, 10);
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

function series(base, trend, noise = 0.12, zeroBefore = -99) {
  return Array.from({ length: 14 }, (_, i) => {
    const k = i - 13;
    if (k < zeroBefore) return { day: dayOf(k), uv: 0 };
    return { day: dayOf(k), uv: Math.max(0, Math.round(base * (1 + trend * (i - 13) / 13) * (1 + (rnd() - 0.5) * noise))) };
  });
}
const crawl = (g, b, y, bd) => {
  const c = (d) => (d == null ? null : { first_seen_at: NOW - d * DAY, last_seen_at: NOW - Math.min(d, 1) * DAY });
  return { google: c(g), bing: c(b), yandex: c(y), baidu: c(bd) };
};
const health = (s, ivt, from = 0) => s.map((x, i) => (i < from ? 'none' : x.uv === 0 ? (i === 13 ? 'none' : 'bad') : ivt > 20 ? 'bad' : ivt > 10 ? 'warn' : 'ok'));

// [name, domain, tags, stage, days, uv7, delta, trendSlope, organic, ai, ivt, crawlDays[g,b,y,bd], attention, starred]
const DEF = [
  ['Snake Rush', 'snakerush.io', ['mini-games', 'ads'], 'growing', 182, 9120, 18, 0.5, 6210, 412, 4.1, [170, 160, 120, 90], [], true],
  ['Gem Swap', 'gemswap.games', ['mini-games', 'ads'], 'growing', 150, 6833, 7, 0.2, 4120, 233, 5.0, [140, 130, 80, null], [], true],
  ['Word Hunt', 'wordhunt.fun', ['content'], 'declining', 96, 2104, -38, -0.6, 1301, 88, 3.2, [90, 80, 60, null], [{ code: 'declining', severity: 'high', params: { pct: -38, days: 28 } }], false],
  ['Tile Merge', 'tilemerge.app', ['mini-games'], 'organic', 41, 1980, 64, 0.9, 1460, 71, 2.8, [38, 30, null, null], [], false],
  ['Pixel Golf', 'pixelgolf.io', ['mini-games', 'ads'], 'declining', 120, 1544, -12, -0.15, 512, 37, 31.4, [110, 100, 70, 40], [{ code: 'ivt_high', severity: 'critical', params: { ivt_pct: 31.4, adguard_mode: 'off' } }, { code: 'declining', severity: 'high', params: { pct: -34, days: 28 } }], false],
  ['Recipe Box', 'recipebox.kitchen', ['content', 'ads'], 'growing', 210, 5402, 3, 0.05, 3980, 520, 6.2, [200, 190, 150, 100], [], false],
  ['Neon Run', 'neonrun.games', ['mini-games'], 'crawled', 9, 212, null, 1.0, 38, 0, 4.0, [6, null, null, null], [], false],
  ['Cloud Notes', 'cloudnotes.page', ['tools'], 'organic', 64, 880, 22, 0.3, 610, 141, 2.2, [60, 55, null, null], [], false],
  ['Hex Puzzle', 'hexpuzzle.fun', ['mini-games'], 'awaiting_crawl', 4, 96, null, 1.0, 0, 0, 2.1, [null, null, null, null], [{ code: 'crawl_overdue', severity: 'normal', params: { days: 4 } }], false],
  ['Quiz Lab', 'quizlab.cc', ['content'], 'crawled', 27, 340, -4, 0, 0, 0, 3.0, [24, 20, null, null], [{ code: 'organic_overdue', severity: 'normal', params: { days: 24 } }], false],
  ['Color Sort', 'colorsort.app', ['mini-games'], 'awaiting_crawl', 2, 41, null, 1.0, 0, 0, 0, [null, null, null, null], [], false],
  ['Unit Convert', 'unitconvert.tools', ['tools', 'ads'], 'organic', 88, 1210, -6, -0.05, 905, 64, 21.5, [80, 75, 30, null], [{ code: 'ivt_spike', severity: 'high', params: { ivt_pct: 24, prev_pct: 8 } }], false],
  ['Car Drift', 'cardrift.io', ['mini-games'], 'setup', 1, 0, null, 0, 0, 0, null, [null, null, null, null], [{ code: 'no_data_24h', severity: 'high', params: { hours: 24, ever: false } }], false],
  ['Old Blog', 'oldblog.net', ['content'], 'organic', 400, 610, -9, -0.1, 420, 12, 3.9, [390, 380, 300, 200], [{ code: 'no_data_24h', severity: 'critical', params: { hours: 24, ever: true } }], false],
];

function site(d, i, opts = {}) {
  const [name, domain, tags, stage, days, uv, delta, slope, organic, ai, ivt, cd, attention, starred] = d;
  const ser = stage === 'setup' ? series(0, 0) : series(uv / 7, slope, 0.18, days < 14 ? -days : -99);
  return {
    site_id: 'S' + (1000 + i).toString(36) + 'x' + i, name, domains: [domain], status: 'active', created_at: NOW - days * DAY - 3600e3,
    days_live: days, timezone: 'UTC', starred: !!starred, tags, cohort: days < 7 ? 'launch:2026-W47' : 'launch:2026-W30', adguard_mode: ivt > 30 ? 'off' : 'balanced',
    stage, stage_since: NOW - Math.min(days, 20) * DAY,
    uv, uv_prev: delta == null ? 0 : Math.round(uv / (1 + delta / 100)), pv: Math.round(uv * 2.7), pv_prev: delta == null ? 0 : Math.round(uv * 2.6 / (1 + delta / 100)), delta_pct: delta,
    series: ser, organic_uv: organic, ai_uv: ai, ivt_pct: ivt, crawl: crawl(...cd), first_search_crawl_at: cd[0] == null ? null : NOW - cd[0] * DAY,
    last_event_at: stage === 'setup' ? null : NOW - (attention.some((a) => a.code === 'no_data_24h') ? 3 * DAY : 120e3),
    health: stage === 'setup' ? Array(14).fill('none') : health(ser, ivt ?? 0, days < 14 ? 14 - days : 0), attention, external: opts.external ? opts.external(i) : null,
  };
}

function payload(sites) {
  const active = sites.filter((s) => s.status === 'active');
  const sum = (k) => active.reduce((a, s) => a + (s[k] || 0), 0);
  const stages = ['setup', 'awaiting_crawl', 'crawled', 'organic', 'growing', 'declining', 'archived'];
  const stage_counts = Object.fromEntries(stages.map((s) => [s, sites.filter((x) => x.stage === s).length]));
  const uv = sum('uv');
  const sorted = active.map((s) => s.uv).sort((a, b) => b - a);
  return {
    period: { token: '7d', start: dayOf(-6), end: dayOf(0) }, compare: 'previous', generated_at: NOW - 60e3,
    thresholds: { growth_uv_7d: 1000, growth_min_delta_pct: -10, decline_pct: 30, ivt_pct: 20, decline_min_uv: 100, crawl_overdue_days: 3, organic_overdue_days: 14, no_data_hours: 24, ivt_spike_pts: 10, ivt_min_pv: 50 },
    totals: {
      uv, uv_prev: Math.round(uv / 1.12), pv: sum('pv'), pv_prev: Math.round(sum('pv') / 1.09), ivt_pct: uv ? 6.8 : null, ivt_pct_prev: uv ? 5.6 : null,
      organic_uv: sum('organic_uv'), organic_uv_prev: Math.round(sum('organic_uv') / 1.21), ai_uv: sum('ai_uv'), ai_uv_prev: Math.round(sum('ai_uv') / 1.64),
      top10_share: uv ? Math.round(sorted.slice(0, Math.max(1, Math.ceil(active.length / 10))).reduce((a, b) => a + b, 0) / uv * 1000) / 1000 : null,
      series: Array.from({ length: 7 }, (_, i) => {
        const f = uv ? 0.82 + i * 0.03 + (rnd() - 0.5) * 0.04 : 0;
        return { day: dayOf(i - 6), uv: Math.round(uv / 7 * f), pv: Math.round(sum('pv') / 7 * f), ivt_pct: uv ? 5.5 + i * 0.25 : null, organic_uv: Math.round(sum('organic_uv') / 7 * (0.8 + i * 0.04)), ai_uv: Math.round(sum('ai_uv') / 7 * (0.6 + i * 0.08)), launched_per_day: sites.filter((x) => new Date(x.created_at).toISOString().slice(0, 10) === dayOf(i - 6)).length };
      }),
    },
    funnel: {
      total: active.length, has_data: active.filter((s) => s.stage !== 'setup').length, google_crawled: active.filter((s) => s.crawl.google).length,
      organic: active.filter((s) => ['organic', 'growing', 'declining'].includes(s.stage)).length, weekly_1000: active.filter((s) => s.uv >= 1000).length,
    },
    stage_counts, attention_count: active.filter((s) => s.attention.length).length, sites,
  };
}


// ── external data per site (shape of loadExternal / contract §3.3) ─────────
const H = 3600e3;
const EXT = {
  'Snake Rush': { revenue_usd: 412.3, revenue_prev_usd: 371.4, rpm_usd: 11.2, adsense: { status: 'ready', ads_txt: 'ok', checked_at: NOW - 3 * H }, adsterra: null, search: { indexed_pages: 184, impressions: 98000, clicks: 6210, checked_at: NOW - 5 * H }, attention: [] },
  'Gem Swap': { revenue_usd: 288.9, revenue_prev_usd: 277.8, rpm_usd: 10.1, adsense: { status: 'ready', ads_txt: 'mismatch', checked_at: NOW - 3 * H }, adsterra: null, search: { indexed_pages: 122, impressions: 61000, clicks: 4120, checked_at: NOW - 5 * H }, attention: [{ code: 'ads_txt_problem', severity: 'high', params: { status: 'mismatch', domain: 'gemswap.games' } }] },
  'Word Hunt': { revenue_usd: 61.2, revenue_prev_usd: 103.7, rpm_usd: 8.4, adsense: null, adsterra: { status: 'active', checked_at: NOW - 2 * H }, search: { indexed_pages: 61, impressions: 21000, clicks: 1301, checked_at: NOW - 5 * H }, attention: [] },
  'Tile Merge': { revenue_usd: 0, revenue_prev_usd: 0, rpm_usd: 0, adsense: null, adsterra: { status: 'no_impressions', checked_at: NOW - 2 * H }, search: { indexed_pages: 12, impressions: 9000, clicks: 1460, checked_at: NOW - 5 * H }, attention: [{ code: 'traffic_no_revenue', severity: 'high', params: { uv: 1980, revenue_usd: 0, min_uv: 200 } }] },
  'Pixel Golf': { revenue_usd: 9.8, revenue_prev_usd: 32.7, rpm_usd: 2.1, adsense: { status: 'needs_attention', ads_txt: 'missing', checked_at: NOW - 3 * H }, adsterra: null, search: null, attention: [{ code: 'adsense_needs_attention', severity: 'high', params: { domain: 'pixelgolf.io', state: 'needs_attention' } }, { code: 'ads_txt_problem', severity: 'high', params: { status: 'missing', domain: 'pixelgolf.io' } }] },
  'Recipe Box': { revenue_usd: 198.4, revenue_prev_usd: 190.1, rpm_usd: 12.6, adsense: { status: 'ready', ads_txt: 'ok', checked_at: NOW - 3 * H }, adsterra: { status: 'active', checked_at: NOW - 2 * H }, search: { indexed_pages: 233, impressions: 72000, clicks: 3980, checked_at: NOW - 5 * H }, attention: [] },
  'Neon Run': { revenue_usd: 0, revenue_prev_usd: 0, rpm_usd: null, adsense: { status: 'getting_ready', ads_txt: 'ok', checked_at: NOW - 3 * H }, adsterra: null, search: null, attention: [] },
  'Unit Convert': { revenue_usd: 0.4, revenue_prev_usd: 22.5, rpm_usd: 0.1, adsense: { status: 'ready', ads_txt: 'ok', checked_at: NOW - 3 * H }, adsterra: null, search: null, attention: [{ code: 'network_declined', severity: 'critical', params: { network: 'adsense', domain: 'unitconvert.tools', topic: 'VALUABLE_INVENTORY' } }] },
  'Cloud Notes': { revenue_usd: 0, revenue_prev_usd: 4.2, rpm_usd: 0, adsense: null, adsterra: null, search: null, attention: [{ code: 'external_stale', severity: 'normal', params: { source: 'adsterra', hours: 52 } }] },
};
function portfolio() {
  const sites = DEF.map((d, i) => {
    const s = site(d, i);
    const e = EXT[s.name] || null;
    return e ? { ...s, external: e, attention: [...s.attention, ...e.attention] } : s;
  });
  return payload(sites);
}

// ── integrations page fixture (/api/integrations) ─────────────────────────
const P = (source, property_id, label, site, mapping, state, extra = {}) => ({ source, property_id, label, domain: label, site_id: site, mapping, state, ads_txt: null, indexed_pages: null, detail: null, error: null, checked_at: NOW - 3 * H, updated_at: NOW, ...extra });
function integrations(sites) {
  const id = (name) => sites.find((s) => s.name === name)?.site_id ?? null;
  return {
    google: { configured: true, connected: true, account: 'owner@example.com', scopes: ['openid', 'email', 'https://www.googleapis.com/auth/adsense.readonly', 'https://www.googleapis.com/auth/webmasters.readonly'], connected_at: NOW - 9 * 86400e3, updated_at: NOW - 9 * 86400e3 },
    adsterra: { connected: true, token_hint: 'a1b2…9z', connected_at: NOW - 5 * 86400e3 },
    sources: [
      { source: 'adsense', connected: true, last_run_at: NOW - 40 * 60e3, last_ok_at: NOW - 40 * 60e3, last_error: null, error_count: 0, backoff_until: null, stats: {}, properties: 5, mapped: 4 },
      { source: 'gsc', connected: true, last_run_at: NOW - 40 * 60e3, last_ok_at: NOW - 40 * 60e3, last_error: null, error_count: 0, backoff_until: null, stats: {}, properties: 5, mapped: 5 },
      { source: 'adsterra', connected: true, last_run_at: NOW - 40 * 60e3, last_ok_at: NOW - 26 * H, last_error: 'adsterra stats: Too many concurrent requests', error_count: 1, backoff_until: NOW + 20 * 60e3, stats: {}, properties: 4, mapped: 3 },
      { source: 'ads_txt', connected: true, last_run_at: NOW - 6 * H, last_ok_at: NOW - 6 * H, last_error: null, error_count: 0, backoff_until: null, stats: { targets: 5, ok: 3, missing: 1, mismatch: 1 }, properties: 5, mapped: 5 },
    ],
    properties: [
      P('adsense', 'snakerush.io', 'snakerush.io', id('Snake Rush'), 'auto', 'ready'),
      P('adsense', 'gemswap.games', 'gemswap.games', id('Gem Swap'), 'auto', 'ready'),
      P('adsense', 'pixelgolf.io', 'pixelgolf.io', id('Pixel Golf'), 'auto', 'needs_attention', { detail: { policy: { action: 'AD_SERVING_RESTRICTED', topics: ['VALUABLE_INVENTORY'] } } }),
      P('adsense', 'neonrun.games', 'neonrun.games', id('Neon Run'), 'auto', 'getting_ready'),
      P('adsense', 'old-arcade.example', 'old-arcade.example', null, 'auto', 'ready'),
      P('gsc', 'sc-domain:snakerush.io', 'sc-domain:snakerush.io', id('Snake Rush'), 'auto', 'active', { indexed_pages: 184, detail: { home_coverage: 'Submitted and indexed' } }),
      P('gsc', 'https://www.snakerush.io/', 'https://www.snakerush.io/', id('Snake Rush'), 'auto', 'duplicate'),
      P('gsc', 'sc-domain:wordhunt.fun', 'sc-domain:wordhunt.fun', id('Word Hunt'), 'manual', 'active', { indexed_pages: 61, detail: { home_coverage: 'Submitted and indexed' } }),
      P('gsc', 'https://tilemerge.app/', 'https://tilemerge.app/', id('Tile Merge'), 'auto', 'active', { indexed_pages: 12, detail: { home_coverage: 'Crawled - currently not indexed' } }),
      P('adsterra', '4417', 'wordhunt.fun', id('Word Hunt'), 'auto', 'listed'),
      P('adsterra', '4418', 'tilemerge.app', id('Tile Merge'), 'auto', 'listed'),
      P('adsterra', '4420', 'staging.tilemerge.app', null, 'ignored', 'listed'),
      P('ads_txt', 'pixelgolf.io', 'pixelgolf.io/ads.txt', id('Pixel Golf'), 'auto', 'missing', { ads_txt: 'missing', detail: { expected: ['pub-1234567890123456'], http: 404 } }),
      P('ads_txt', 'gemswap.games', 'gemswap.games/ads.txt', id('Gem Swap'), 'auto', 'mismatch', { ads_txt: 'mismatch', detail: { expected: ['pub-1234567890123456'] } }),
      P('ads_txt', 'snakerush.io', 'snakerush.io/ads.txt', id('Snake Rush'), 'auto', 'ok', { ads_txt: 'ok' }),
    ],
    sites: sites.map((s) => ({ site_id: s.site_id, name: s.name, domains: s.domains })),
    settings: { no_revenue_min_uv: 200 },
  };
}

async function shoot(browser, name, { url, width = 1600, height = 1000, lang = 'en', full = true, wait }) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => console.error(`[${name}] pageerror`, e.message));
  await page.addInitScript((l) => { try { localStorage.setItem('pvuv.lang', l); sessionStorage.clear(); } catch { /* */ } Date.now = ((n) => () => n)(Date.UTC(2026, 10, 16, 9, 31)); }, lang);
  const data = portfolio();
  await page.route('**/*', async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === '/api/portfolio') return route.fulfill({ json: data });
    if (p === '/api/integrations') return route.fulfill({ json: integrations(data.sites) });
    if (p === '/api/home') return route.fulfill({ json: { name: 'pvuv.ai' } });
    if (p === '/api/me') return route.fulfill({ json: { user: 'admin', timezone: 'UTC', ingest_host: 'in.example.com' } });
    if (p === '/api/ranking') return route.fulfill({ json: { sites: [] } });
    if (p === '/api/sites') return route.fulfill({ json: { sites: data.sites.map((x) => ({ ...x, allowed_domains: JSON.stringify(x.domains) })) } });
    if (p.startsWith('/api/')) return route.fulfill({ json: {} });
    const file = join(ROOT, p === '/' ? 'index.html' : p);
    if (!existsSync(file)) return route.fulfill({ status: 404, body: 'not found' });
    const type = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' }[extname(file)] || 'application/octet-stream';
    return route.fulfill({ body: readFileSync(file), contentType: type });
  });
  await page.goto('http://console.test' + url);
  await page.waitForSelector(wait, { state: 'attached', timeout: 10000 });
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(OUT, `p3-${name}.png`), fullPage: full });
  await page.close();
  console.log('wrote', `p3-${name}.png`);
}

const browser = await chromium.launch();
try {
  const integ = '#props tbody tr';
  await shoot(browser, 'integrations', { url: '/integrations.html', wait: integ });
  await shoot(browser, 'integrations.zh', { url: '/integrations.html', lang: 'zh', wait: integ });
  await shoot(browser, 'integrations-mapping', { url: '/integrations.html#mapping', wait: integ });
  await shoot(browser, 'integrations-mapping.zh', { url: '/integrations.html#mapping', lang: 'zh', wait: integ });
  await shoot(browser, 'integrations-narrow', { url: '/integrations.html', width: 820, height: 1100, wait: integ });
  await shoot(browser, 'overview-external', { url: '/sites.html?tab=sites&preset=revenue', wait: 'main.pf .tbl' });
  await shoot(browser, 'overview-external.zh', { url: '/sites.html?tab=sites&preset=revenue', lang: 'zh', wait: 'main.pf .tbl' });
} finally {
  await browser.close();
}
