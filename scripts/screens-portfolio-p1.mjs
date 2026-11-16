// Screenshots of the portfolio overview (sites.html) with MOCKED API data —
// docs/design/screens/p1-*.png. No worker needed: Playwright serves
// workers/console/public from disk and answers /api/* from fixtures below.
//
//   NODE_PATH=$(npm root -g) node scripts/screens-portfolio-p1.mjs [outDir]
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

const archived = { ...site(['Spring Promo', 'springpromo.shop', ['shop'], 'archived', 300, 0, null, 0, 0, 0, null, [280, null, null, null], [], false], 99), status: 'archived', stage: 'archived' };
const SCENARIOS = {
  default: () => payload([...DEF.map((d, i) => site(d, i)), archived]),
  empty: () => payload([]),
  newuser: () => payload(['Arcade One', 'Trivia Two', 'Puzzle Three', 'Blog Four'].map((n, i) =>
    site([n, n.toLowerCase().replace(' ', '') + '.example', ['batch-1'], 'setup', 0, 0, null, 0, 0, 0, null, [null, null, null, null], [], false], i))),
};

async function shoot(browser, name, scenario, { url = '/sites.html', after, height = 1000, lang = 'en', full = false } = {}) {
  const page = await browser.newPage({ viewport: { width: 1600, height }, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => console.error(`[${name}] pageerror`, e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/404|Failed to load resource/.test(m.text())) console.error(`[${name}] console`, m.text()); });
  await page.addInitScript((l) => { try { localStorage.setItem('pvuv.lang', l); } catch { /* */ } Date.now = ((n) => () => n)(Date.UTC(2026, 10, 16, 9, 31)); }, lang);
  const data = SCENARIOS[scenario]();
  await page.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    const p = u.pathname;
    if (p === '/api/portfolio') return route.fulfill({ json: data });
    if (p === '/api/home') return route.fulfill({ json: { name: 'pvuv.ai' } });
    if (p === '/api/me') return route.fulfill({ json: { user: 'admin', timezone: 'UTC', ingest_host: 'in.example.com' } });
    if (p === '/api/templates') return route.fulfill({ json: { templates: [{ template_id: 't1', name: 'Game site', timezone: 'UTC', adguard_mode: 'balanced', adclient: null, engaged_seconds: 10, funnels: [] }] } });
    if (p === '/api/ranking') return route.fulfill({ json: { sites: [] } });
    if (p === '/api/sites') return route.fulfill({ json: { sites: data.sites.map((x) => ({ ...x, allowed_domains: JSON.stringify(x.domains) })) } });
    if (p.startsWith('/api/')) return route.fulfill({ json: {} });
    const file = join(ROOT, p === '/' ? 'index.html' : p);
    if (!existsSync(file)) return route.fulfill({ status: 404, body: 'not found' });
    const type = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' }[extname(file)] || 'application/octet-stream';
    return route.fulfill({ body: readFileSync(file), contentType: type });
  });
  await page.goto('http://console.test' + url);
  await page.waitForSelector(url.startsWith('/site.html') ? 'aside.shell nav' : 'main.pf .kpis, main.pf .tbl, .empty-state', { timeout: 10000 });
  if (after) await after(page);
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(OUT, `p1-${name}.png`), fullPage: full });
  await page.close();
  console.log('wrote', `p1-${name}.png`);
}

const browser = await chromium.launch();
try {
  await shoot(browser, 'overview', 'default', { full: true });
  await shoot(browser, 'needs-attention', 'default', { url: '/sites.html?tab=sites&view=attention', full: true });
  await shoot(browser, 'lifecycle', 'default', { url: '/sites.html?tab=lifecycle', full: true });
  await shoot(browser, 'empty', 'empty', { height: 760 });
  await shoot(browser, 'new-user', 'newuser', { full: true });
  await shoot(browser, 'overview-zh', 'default', { lang: 'zh', full: true });
  await shoot(browser, 'cmdk', 'default', { height: 860, after: async (p) => { await p.keyboard.press('/'); await p.keyboard.type('gem'); } });
  await shoot(browser, 'shell-site', 'default', { url: '/site.html?id=' + SCENARIOS.default().sites[0].site_id, height: 760 });
  await shoot(browser, 'add-site', 'default', { height: 860, after: async (p) => { await p.click('aside >> text=New site'); } });
} finally {
  await browser.close();
}
