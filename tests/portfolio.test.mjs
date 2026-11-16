// Portfolio overview: GET /api/portfolio (console) + GET /v1/portfolio (api).
// Contract: docs/design/portfolio-ui.md §2–§3.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import api from '../.test-api.mjs';
import consoleWorker from '../.test-console.mjs';
import { computeStage, computeAttention, DEFAULT_THRESHOLDS as TH, cohortTag, PORTFOLIO_CHUNK } from '../.test-portfolio.mjs';

const DAY = 86_400_000;
const NOW = Date.now();
const dayOf = (offset) => new Date(NOW + offset * DAY).toISOString().slice(0, 10); // UTC sites

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync('shared/schema.sql', 'utf8'));
  db.exec("INSERT INTO users(user_id,created_at) VALUES ('owner',1),('other',1)");
  const hmac = (token) => createHmac('sha256', 'test-key').update('apitoken:' + token).digest('base64url');
  for (const [id, token, permission, owner, site] of [
    ['r', 'pvuv_read', 'read', 'owner', null], ['o', 'pvuv_other', 'read', 'other', null], ['s', 'pvuv_scoped', 'read', 'owner', 'growA'],
  ]) {
    db.prepare('INSERT INTO api_tokens(token_id,owner_id,name,token_hash,prefix,site_id,created_at,permission) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, owner, id, hmac(token), id, site, 1, permission);
  }
  const stats = { statements: 0, batches: 0 };
  const stmt = (sql) => {
    let args = [];
    return {
      sql, bind(...x) { args = x; return this; },
      async first() { stats.statements++; return db.prepare(sql).get(...args) ?? null; },
      async all() { stats.statements++; return { results: db.prepare(sql).all(...args) }; },
      async run() { stats.statements++; const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
      _all() { return { results: db.prepare(sql).all(...args) }; },
    };
  };
  const DB = {
    prepare: stmt,
    async batch(list) { stats.batches++; stats.statements += list.length; return list.map((s) => s._all()); },
  };
  const env = { DB, HMAC_KEY: 'test-key', SITE_CONFIG: { put: async () => {}, delete: async () => {} }, ADMIN_EMAILS: '' };
  return { db, env, stats };
}

function addSite(db, id, { owner = 'owner', created = -200, status = 'active', adguard = 'off', name = id } = {}) {
  db.prepare("INSERT INTO sites(site_id,name,owner_id,allowed_domains,adguard_mode,created_at,status,timezone) VALUES(?,?,?,?,?,?,?,'UTC')")
    .run(id, name, owner, JSON.stringify([id.toLowerCase() + '.example']), adguard, NOW + created * DAY, status);
}
function addDays(db, id, from, to, { uv = 100, pv = 300, clean = 280, suspect = 10, bot = 10 } = {}) {
  const ins = db.prepare('INSERT INTO rollup_site_daily(site_id,day,pv,uv,clean_count,suspect_count,bot_count) VALUES(?,?,?,?,?,?,?)');
  for (let d = from; d <= to; d++) {
    const v = typeof uv === 'function' ? uv(d) : uv;
    ins.run(id, dayOf(d), pv, v, clean, suspect, bot);
  }
}
function addSource(db, id, day, source, uvClean) {
  db.prepare("INSERT INTO rollup_source_daily(site_id,day,source,medium,campaign,uv_clean) VALUES(?,?,?,'','',?)").run(id, dayOf(day), source, uvClean);
}
function addCrawl(db, id, engine, firstDaysAgo) {
  db.prepare("INSERT INTO crawler_milestones(site_id,engine,kind,first_seen_at,last_seen_at) VALUES(?,?,'search',?,?)")
    .run(id, engine, NOW - firstDaysAgo * DAY, NOW - DAY);
}
function addSession(db, id, agoMs) {
  db.prepare("INSERT INTO sessions(session_id,site_id,visitor_id,started_at,last_active_at) VALUES(?,?,?,?,?)").run(id + agoMs, id, 'v', NOW - agoMs, NOW - agoMs);
}
function cookie(user = 'owner') {
  const payload = Buffer.from(JSON.stringify({ u: user, exp: Date.now() + 60000 })).toString('base64url');
  const sig = createHmac('sha256', 'test-key').update('session|' + payload).digest('base64url');
  return `_pvc_s=${payload}.${sig}`;
}
const getConsole = (env, path, user = 'owner') =>
  consoleWorker.fetch(new Request('https://console.test' + path, { headers: user ? { cookie: cookie(user) } : {} }), env);
const getApi = (env, path, token) =>
  api.fetch(new Request('https://api.test' + path, { headers: token ? { authorization: `Bearer ${token}` } : {} }), env);

/** A small portfolio covering every lifecycle stage. */
function seeded() {
  const f = fixture();
  const { db } = f;
  addSite(db, 'setupA', { created: -3 });                                   // no data, created 3 days ago
  addSite(db, 'waitB', { created: -10 }); addDays(db, 'waitB', -8, 0, { uv: 20, pv: 40, clean: 40, suspect: 0, bot: 0 });
  addSession(db, 'waitB', 3600e3);
  addSite(db, 'crawlC'); addDays(db, 'crawlC', -60, 0, { uv: 30, pv: 60, clean: 60, suspect: 0, bot: 0 });
  addCrawl(db, 'crawlC', 'googlebot', 40); addSession(db, 'crawlC', 60e3);
  addSite(db, 'orgD'); addDays(db, 'orgD', -60, 0, { uv: 50, pv: 100, clean: 100, suspect: 0, bot: 0 });
  addCrawl(db, 'orgD', 'googlebot', 50); addCrawl(db, 'orgD', 'bingbot', 20); addSession(db, 'orgD', 60e3);
  addSource(db, 'orgD', -30, 'google.com', 5); addSource(db, 'orgD', -2, 'google.com', 12); addSource(db, 'orgD', -1, 'chatgpt.com', 3);
  addSource(db, 'orgD', -1, 'facebook.com', 40); // social, never counted as organic
  addSite(db, 'growA'); addDays(db, 'growA', -60, 0, { uv: 400, pv: 800, clean: 790, suspect: 5, bot: 5 });
  addCrawl(db, 'growA', 'googlebot', 59); addSource(db, 'growA', -55, 'bing.com', 9); addSession(db, 'growA', 60e3);
  db.exec("INSERT INTO site_labels(site_id,starred,tags) VALUES ('growA',1,'[\"games\",\"ads\"]')");
  addSite(db, 'declE');
  addDays(db, 'declE', -60, 0, { uv: (d) => (d < -28 ? 200 : 40), pv: 100, clean: 100, suspect: 0, bot: 0 });
  addCrawl(db, 'declE', 'googlebot', 59); addSource(db, 'declE', -50, 'google.com', 9); addSession(db, 'declE', 60e3);
  addSite(db, 'ivtF', { adguard: 'off' }); addDays(db, 'ivtF', -20, 0, { uv: 60, pv: 200, clean: 120, suspect: 40, bot: 40 });
  addCrawl(db, 'ivtF', 'googlebot', 10); addSession(db, 'ivtF', 60e3);
  addSite(db, 'deadG'); addDays(db, 'deadG', -30, -5, { uv: 30, pv: 60, clean: 60, suspect: 0, bot: 0 });
  addCrawl(db, 'deadG', 'googlebot', 25); addSession(db, 'deadG', 5 * DAY);
  addSite(db, 'archH', { status: 'archived' });
  addSite(db, 'otherX', { owner: 'other' }); addDays(db, 'otherX', -10, 0);
  return f;
}

test('GET /api/portfolio returns the contract shape', async () => {
  const { env } = seeded();
  const r = await getConsole(env, '/api/portfolio?period=7d&compare=previous');
  assert.equal(r.status, 200);
  const p = await r.json();
  assert.deepEqual(Object.keys(p.period), ['token', 'start', 'end']);
  assert.equal(p.period.token, '7d');
  assert.equal(typeof p.generated_at, 'number');
  for (const k of ['uv', 'uv_prev', 'pv', 'pv_prev', 'ivt_pct', 'ivt_pct_prev', 'organic_uv', 'organic_uv_prev', 'ai_uv', 'ai_uv_prev', 'top10_share', 'series']) {
    assert.ok(k in p.totals, 'totals.' + k);
  }
  assert.ok(p.totals.series.length >= 7 && p.totals.series.every((x) => typeof x.day === 'string' && typeof x.uv === 'number'));
  assert.deepEqual(Object.keys(p.funnel).sort(), ['google_crawled', 'has_data', 'organic', 'total', 'weekly_1000']);
  assert.deepEqual(Object.keys(p.stage_counts).sort(), ['archived', 'awaiting_crawl', 'crawled', 'declining', 'growing', 'organic', 'setup']);
  assert.equal(typeof p.attention_count, 'number');
  assert.equal(p.sites.length, 9, 'own sites only, archived included, other owner excluded');
  for (const s of p.sites) {
    for (const k of ['site_id', 'name', 'domains', 'status', 'created_at', 'days_live', 'starred', 'tags', 'adguard_mode', 'stage', 'stage_since',
      'uv', 'uv_prev', 'pv', 'pv_prev', 'delta_pct', 'series', 'organic_uv', 'ai_uv', 'ivt_pct', 'crawl', 'health', 'attention', 'external']) {
      assert.ok(k in s, `${s.site_id}.${k}`);
    }
    assert.equal(s.series.length, 14);
    assert.ok(s.series[0].day < s.series[13].day, 'oldest first');
    assert.equal(s.health.length, 14);
    assert.ok(s.health.every((h) => ['ok', 'warn', 'bad', 'none'].includes(h)));
    assert.deepEqual(Object.keys(s.crawl).sort(), ['baidu', 'bing', 'google', 'yandex']);
    assert.equal(s.external, null, 'stub loadExternal → no external data');
    assert.match(s.cohort, /^launch:\d{4}-W\d{2}$/);
  }
  const by = Object.fromEntries(p.sites.map((s) => [s.site_id, s]));
  assert.deepEqual(
    Object.fromEntries(Object.entries(by).map(([k, s]) => [k, s.stage])),
    { setupA: 'setup', waitB: 'awaiting_crawl', crawlC: 'crawled', orgD: 'organic', growA: 'growing', declE: 'declining', ivtF: 'crawled', deadG: 'crawled', archH: 'archived' },
  );
  assert.equal(p.stage_counts.archived, 1);
  assert.equal(p.funnel.total, 8);
  assert.equal(p.funnel.has_data, 7);
  assert.equal(p.funnel.google_crawled, 6);
  assert.equal(p.funnel.organic, 3);
  assert.equal(p.funnel.weekly_1000, 1);
  assert.equal(by.growA.starred, true);
  assert.deepEqual(by.growA.tags, ['games', 'ads']);
  assert.ok(by.orgD.crawl.google && by.orgD.crawl.bing && !by.orgD.crawl.yandex);
  assert.equal(by.orgD.organic_uv, 12, 'organic search in the 7-day window only; social excluded');
  assert.equal(by.orgD.ai_uv, 3);
  assert.equal(by.ivtF.ivt_pct, 40);
  assert.equal(by.growA.uv, 7 * 400);
  assert.ok(Math.abs(by.growA.delta_pct) < 20);
  assert.equal(by.setupA.health.every((h) => h === 'none'), true);
  assert.equal(by.deadG.health.at(-2), 'bad', 'a day without data after the site went live');
  assert.equal(by.ivtF.health.at(-2), 'bad', 'IVT above the threshold');
});

test('attention: codes, severities and the count', async () => {
  const { env } = seeded();
  const p = await (await getConsole(env, '/api/portfolio')).json();
  const codes = Object.fromEntries(p.sites.map((s) => [s.site_id, s.attention.map((a) => `${a.code}:${a.severity}`)]));
  assert.deepEqual(codes.setupA, ['no_data_24h:high']);
  assert.deepEqual(codes.waitB, ['crawl_overdue:normal']);
  assert.deepEqual(codes.crawlC, ['organic_overdue:normal']);
  assert.deepEqual(codes.orgD, []);
  assert.deepEqual(codes.growA, []);
  assert.deepEqual(codes.declE, ['declining:high']);
  assert.deepEqual(codes.ivtF, ['ivt_high:critical']);
  assert.deepEqual(codes.deadG, ['no_data_24h:critical', 'organic_overdue:normal']);
  assert.deepEqual(codes.archH, []);
  assert.equal(p.attention_count, 6);
  const ivt = p.sites.find((s) => s.site_id === 'ivtF').attention[0];
  assert.deepEqual(ivt.params, { ivt_pct: 40, adguard_mode: 'off' });
});

test('stage rules (pure)', () => {
  const base = {
    status: 'active', has_data: true, first_data_at: 1, first_search_crawl_at: 2, first_organic_at: 3,
    clean_uv_7d: 0, clean_uv_prev_7d: 0, clean_uv_28d: 0, clean_uv_prev_28d: 0,
  };
  assert.equal(computeStage({ ...base, status: 'archived' }, TH).stage, 'archived');
  assert.equal(computeStage({ ...base, has_data: false }, TH).stage, 'setup');
  assert.equal(computeStage({ ...base, first_search_crawl_at: null, first_organic_at: null }, TH).stage, 'awaiting_crawl');
  assert.equal(computeStage({ ...base, first_organic_at: null }, TH).stage, 'crawled');
  assert.equal(computeStage(base, TH).stage, 'organic');
  // growth: ≥ 1000 clean visitors in 7 days and Δ ≥ −10 %
  assert.equal(computeStage({ ...base, clean_uv_7d: 1000, clean_uv_prev_7d: 1100 }, TH).stage, 'growing');
  assert.equal(computeStage({ ...base, clean_uv_7d: 1000, clean_uv_prev_7d: 1200 }, TH).stage, 'organic', 'Δ −16.7 %');
  assert.equal(computeStage({ ...base, clean_uv_7d: 999, clean_uv_prev_7d: 500 }, TH).stage, 'organic');
  // declining: 28-day clean visitors down > 30 %, beats growing
  const decl = { ...base, clean_uv_7d: 5000, clean_uv_prev_7d: 5000, clean_uv_28d: 600, clean_uv_prev_28d: 1000 };
  assert.equal(computeStage(decl, TH).stage, 'declining');
  assert.equal(computeStage({ ...decl, clean_uv_28d: 700 }, TH).stage, 'growing', 'exactly −30 % is not declining');
  assert.equal(computeStage({ ...decl, first_search_crawl_at: null, first_organic_at: null }, TH).stage, 'declining');
  // configurable
  assert.equal(computeStage({ ...base, clean_uv_7d: 200 }, { ...TH, growth_min_uv: 100 }).stage, 'growing');
});

test('attention rules (pure)', () => {
  const base = {
    status: 'active', has_data: true, first_data_at: NOW - 30 * DAY, first_search_crawl_at: NOW - 20 * DAY, first_organic_at: NOW - 5 * DAY,
    clean_uv_7d: 0, clean_uv_prev_7d: 0, clean_uv_28d: 0, clean_uv_prev_28d: 0,
    created_at: NOW - 40 * DAY, last_event_at: NOW - 60e3, adguard_mode: 'balanced', stage: 'organic',
    uv_28d: 0, uv_prev_28d: 0, ivt_pct: 5, ivt_pct_prev: 5, pv: 1000, last_day_ivt_pct: 5, last_day_pv: 100,
  };
  const codes = (x, th = TH) => computeAttention({ ...base, ...x }, th, NOW).map((a) => a.code);
  assert.deepEqual(codes({}), []);
  assert.deepEqual(codes({ last_event_at: NOW - 25 * 3600e3 }), ['no_data_24h']);
  assert.deepEqual(codes({ has_data: false, last_event_at: null, created_at: NOW - 3600e3, first_search_crawl_at: null, first_organic_at: null }), [],
    'a site created an hour ago is not late yet');
  assert.deepEqual(codes({ first_search_crawl_at: null, first_organic_at: null, first_data_at: NOW - 3 * DAY }), [], '3 days is not overdue');
  assert.deepEqual(codes({ first_search_crawl_at: null, first_organic_at: null, first_data_at: NOW - 4 * DAY }), ['crawl_overdue']);
  assert.deepEqual(codes({ first_organic_at: null, first_search_crawl_at: NOW - 14 * DAY }), []);
  assert.deepEqual(codes({ first_organic_at: null, first_search_crawl_at: NOW - 15 * DAY }), ['organic_overdue']);
  assert.deepEqual(codes({ stage: 'declining', clean_uv_28d: 10, clean_uv_prev_28d: 100 }), ['declining']);
  const hi = computeAttention({ ...base, ivt_pct: 25 }, TH, NOW);
  assert.deepEqual(hi.map((a) => `${a.code}:${a.severity}`), ['ivt_high:high']);
  assert.equal(computeAttention({ ...base, ivt_pct: 25, adguard_mode: 'off' }, TH, NOW)[0].severity, 'critical');
  assert.deepEqual(codes({ ivt_pct: 25, pv: 10 }), [], 'too few pageviews');
  assert.deepEqual(codes({ last_day_ivt_pct: 16, ivt_pct_prev: 5 }), ['ivt_spike']);
  assert.deepEqual(codes({ last_day_ivt_pct: 14, ivt_pct_prev: 5 }), [], 'below spike points');
  assert.deepEqual(codes({ status: 'archived', last_event_at: null }), []);
});

test('auth and scoping', async () => {
  const { env } = seeded();
  assert.equal((await getConsole(env, '/api/portfolio', null)).status, 401);
  const other = await (await getConsole(env, '/api/portfolio', 'other')).json();
  assert.deepEqual(other.sites.map((s) => s.site_id), ['otherX']);
  assert.equal((await getApi(env, '/v1/portfolio', null)).status, 401);
  assert.equal((await getApi(env, '/v1/portfolio', 'pvuv_scoped')).status, 403, 'site-scoped token');
  const v1 = await getApi(env, '/v1/portfolio?period=30d', 'pvuv_read');
  assert.equal(v1.status, 200);
  const body = await v1.json();
  assert.equal(body.period.token, '30d');
  assert.equal(body.sites.length, 9);
  assert.ok(!body.sites.some((s) => s.site_id === 'otherX'));
  const o = await (await getApi(env, '/v1/portfolio', 'pvuv_other')).json();
  assert.deepEqual(o.sites.map((s) => s.site_id), ['otherX']);
  assert.equal((await getConsole(env, '/api/portfolio?period=24h')).status, 400);
  assert.equal((await getConsole(env, '/api/portfolio?compare=bogus')).status, 400);
});

test('thresholds come from instance settings', async () => {
  const { env, db } = seeded();
  db.prepare("INSERT INTO instance_settings(key,value,updated_at) VALUES('portfolio_thresholds',?,1)").run(JSON.stringify({ ivt_high_pct: 50, growth_min_uv: 100 }));
  const p = await (await getConsole(env, '/api/portfolio')).json();
  assert.equal(p.thresholds.ivt_high_pct, 50);
  const by = Object.fromEntries(p.sites.map((s) => [s.site_id, s]));
  assert.deepEqual(by.ivtF.attention, []);
  assert.equal(by.orgD.stage, 'growing', '50 clean visitors a day ≥ 100 a week');
});

test('500 sites: statement count bounded by chunks, fast', async () => {
  const { env, db, stats } = fixture();
  const insSite = db.prepare("INSERT INTO sites(site_id,name,owner_id,allowed_domains,created_at,timezone) VALUES(?,?,'owner','[\"x.example\"]',?,'UTC')");
  const insDay = db.prepare('INSERT INTO rollup_site_daily(site_id,day,pv,uv,clean_count) VALUES(?,?,?,?,?)');
  const insSrc = db.prepare("INSERT INTO rollup_source_daily(site_id,day,source,medium,campaign,uv_clean) VALUES(?,?,?,'','',?)");
  db.exec('BEGIN');
  for (let i = 0; i < 500; i++) {
    const id = 'S' + String(i).padStart(4, '0');
    insSite.run(id, id, NOW - 90 * DAY);
    for (let d = -60; d <= 0; d++) {
      insDay.run(id, dayOf(d), 100 + i, 40 + (i % 50), 90);
      if (d % 3 === 0) { insSrc.run(id, dayOf(d), 'google.com', 5); insSrc.run(id, dayOf(d), 'news.site' + (i % 7) + '.example', 3); }
    }
    if (i % 2) addCrawl(db, id, 'googlebot', 30);
  }
  db.exec('COMMIT');
  const t0 = performance.now();
  const r = await getConsole(env, '/api/portfolio');
  const ms = performance.now() - t0;
  assert.equal(r.status, 200);
  const p = await r.json();
  assert.equal(p.sites.length, 500);
  const chunks = Math.ceil(500 / PORTFOLIO_CHUNK);
  // thresholds + site list (+ slack), then one batch per chunk (≤ 6 statements)
  // and one more batch for first-organic (one statement per chunk)
  assert.ok(stats.statements <= 3 + chunks * 7, `statements: ${stats.statements}`);
  assert.ok(stats.batches <= chunks + 1, `round trips: ${stats.batches}`);
  assert.ok(ms < 5000, `took ${ms.toFixed(0)} ms`);
});

test('cohortTag is the ISO week of creation in the site timezone', () => {
  assert.equal(cohortTag(Date.UTC(2026, 10, 16, 12), 'UTC'), 'launch:2026-W47');
  assert.equal(cohortTag(Date.UTC(2027, 0, 1, 12), 'UTC'), 'launch:2026-W53');
  assert.equal(cohortTag(Date.UTC(2025, 11, 29, 12), 'UTC'), 'launch:2026-W01');
  // Sunday 23:30 UTC is already Monday in Tokyo → next week
  assert.equal(cohortTag(Date.UTC(2026, 10, 15, 23, 30), 'UTC'), 'launch:2026-W46');
  assert.equal(cohortTag(Date.UTC(2026, 10, 15, 23, 30), 'Asia/Tokyo'), 'launch:2026-W47');
});

test('migration 0026 matches the canonical schema and is idempotent', () => {
  const a = new DatabaseSync(':memory:');
  a.exec(readFileSync('migrations/0026_site_labels.sql', 'utf8'));
  a.exec(readFileSync('migrations/0026_site_labels.sql', 'utf8'));
  const b = new DatabaseSync(':memory:');
  b.exec(readFileSync('shared/schema.sql', 'utf8'));
  const cols = (db) => db.prepare('PRAGMA table_info(site_labels)').all().map((c) => [c.name, c.type, c.dflt_value, c.pk]);
  assert.deepEqual(cols(a), cols(b));
});
