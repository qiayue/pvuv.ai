// Server-side crawler reporting (migration 0025): ingest-only tokens
// (POST /v1/sites/{id}/tokens), POST /v1/sites/{id}/crawler_hits, and the
// `server` source in GET /v1/sites/{id}/crawlers. Crawler hits must never
// reach events, PV/UV or anything people-related.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import api from '../.test-api.mjs';
import consoleWorker from '../.test-console.mjs';
import { runHourlyRollup, eventsTableDDL, monthSuffix } from '../.test-cron.mjs';

const UA = {
  googlebot: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  bingbot: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/116.0.1938.76 Safari/537.36',
  chatgpt: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot',
  chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
};
const hmac = (token) => createHmac('sha256', 'test-key').update('apitoken:' + token).digest('base64url');

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync('shared/schema.sql', 'utf8'));
  const now = Date.now();
  for (const sql of eventsTableDDL(monthSuffix(now))) db.exec(sql);
  for (const sql of eventsTableDDL(monthSuffix(now - 3 * 86400e3))) db.exec(sql);
  db.exec("INSERT INTO users(user_id,created_at) VALUES ('owner',1),('other',1)");
  const site = db.prepare("INSERT INTO sites(site_id,name,owner_id,allowed_domains,timezone,created_at,status) VALUES (?,?,?,?,?,?,?)");
  site.run('siteA001', 'A', 'owner', '["a.example"]', 'UTC', now - 86400e3, 'active');
  site.run('siteB001', 'B', 'owner', '["b.example"]', 'UTC', now - 86400e3, 'active');
  site.run('siteC001', 'C', 'other', '["c.example"]', 'UTC', now - 86400e3, 'active');
  for (const [id, token, owner, siteId, permission] of [
    ['w', 'pvuv_write', 'owner', null, 'write'],
    ['r', 'pvuv_read', 'owner', null, 'read'],
    ['o', 'pvuv_otherwrite', 'other', null, 'write'],
  ]) {
    db.prepare('INSERT INTO api_tokens(token_id,owner_id,name,token_hash,prefix,site_id,created_at,permission) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, owner, id, hmac(token), id, siteId, 1, permission);
  }
  const wrap = (sql) => {
    let args = [];
    return {
      bind(...x) { args = x; return this; },
      async first() { return db.prepare(sql).get(...args) ?? null; },
      async all() { return { results: db.prepare(sql).all(...args) }; },
      async run() { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
    };
  };
  const DB = {
    prepare: wrap,
    async batch(stmts) {
      db.exec('BEGIN');
      try { const out = []; for (const s of stmts) out.push(await s.run()); db.exec('COMMIT'); return out; }
      catch (err) { db.exec('ROLLBACK'); throw err; }
    },
  };
  return { db, now, env: { DB, HMAC_KEY: 'test-key', BLOCKLIST: {}, SITE_CONFIG: { put: async () => {}, delete: async () => {} } } };
}

const call = (env, method, path, token, body) => api.fetch(new Request('https://api.test' + path, {
  method,
  headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
  body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
}), env);
const mint = async (env, site = 'siteA001', token = 'pvuv_write', body = { name: 'launcher a.example' }) => call(env, 'POST', `/v1/sites/${site}/tokens`, token, body);
const report = (env, token, hits, site = 'siteA001') => call(env, 'POST', `/v1/sites/${site}/crawler_hits`, token, { hits });

const peopleTables = (db) => {
  const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'events_%' OR name LIKE 'rollup_site%' OR name LIKE 'rollup_page%' OR name = 'sessions' OR name LIKE 'visitor%')").all().map((r) => r.name);
  return Object.fromEntries(t.map((n) => [n, db.prepare(`SELECT COUNT(*) AS n FROM ${n}`).get().n]));
};

test('POST /tokens mints a hashed, site-scoped ingest token for the owner\'s write token only', async () => {
  const { db, env } = fixture();
  assert.equal((await mint(env, 'siteA001', 'pvuv_read')).status, 403);
  assert.equal((await mint(env, 'siteA001', 'pvuv_otherwrite')).status, 403);
  assert.equal((await mint(env, 'siteA001', null)).status, 401);

  const r = await mint(env);
  assert.equal(r.status, 200);
  const t = await r.json();
  assert.match(t.token, /^pvuv_/);
  assert.equal(t.site_id, 'siteA001');
  assert.deepEqual(t.scopes, ['ingest']);
  assert.equal(t.name, 'launcher a.example');
  assert.ok(t.token_id && t.created_at);
  const row = db.prepare('SELECT * FROM api_tokens WHERE token_id = ?').get(t.token_id);
  assert.equal(row.permission, 'ingest');
  assert.equal(row.site_id, 'siteA001');
  assert.equal(row.owner_id, 'owner');
  assert.equal(row.token_hash, hmac(t.token)); // stored hashed, never in plaintext
  assert.ok(!JSON.stringify(row).includes(t.token));

  // not idempotent by design: a second call mints a second, distinct token
  const again = await (await mint(env, 'siteA001', 'pvuv_write', {})).json();
  assert.notEqual(again.token, t.token);
  assert.equal(again.name, 'crawler ingest'); // default name; empty body accepted
  const empty = await call(env, 'POST', '/v1/sites/siteA001/tokens', 'pvuv_write', '');
  assert.equal(empty.status, 200);

  // capped per site
  for (let i = 0; i < 17; i++) assert.equal((await mint(env)).status, 200);
  assert.equal((await mint(env)).status, 409);
  assert.equal((await mint(env, 'siteB001')).status, 200); // the cap is per site

  // an ingest token cannot mint more tokens
  assert.equal((await mint(env, 'siteA001', t.token)).status, 403);
});

test('an ingest token can report crawler hits for its own site and nothing else', async () => {
  const { env } = fixture();
  const { token } = await (await mint(env)).json();
  const hit = [{ ua: UA.googlebot, path: '/' }];

  // reads: every report and the site list refuse it
  for (const p of ['/v1/sites', '/v1/sites/summary', '/v1/templates', '/v1/sites/siteA001/overview', '/v1/sites/siteA001/crawlers', '/v1/sites/siteA001/funnels']) {
    assert.equal((await call(env, 'GET', p, token)).status, 403, p);
  }
  // writes other than crawler hits
  assert.equal((await call(env, 'POST', '/v1/sites', token, { name: 'x', domain: 'x.example' })).status, 403);
  assert.equal((await call(env, 'PATCH', '/v1/sites/siteA001', token, { name: 'renamed' })).status, 403);
  assert.equal((await call(env, 'POST', '/v1/sites/siteA001/funnels', token, { name: 'f', steps: [{ type: 'page', value: '/' }, { type: 'page', value: '/b' }] })).status, 403);
  // crawler hits for another site of the same owner, or another owner's site
  assert.equal((await report(env, token, hit, 'siteB001')).status, 403);
  assert.equal((await report(env, token, hit, 'siteC001')).status, 403);
  // its own site: fine
  assert.equal((await report(env, token, hit)).status, 200);
  // the owner's write token may report too; a read token may not; no token → 401
  assert.equal((await report(env, 'pvuv_write', hit)).status, 200);
  assert.equal((await report(env, 'pvuv_read', hit)).status, 403);
  assert.equal((await report(env, 'pvuv_otherwrite', hit)).status, 403);
  assert.equal((await report(env, null, hit)).status, 401);
  assert.equal((await report(env, 'pvuv_nope', hit)).status, 401);
});

test('crawler_hits validates, classifies, caps and stores only into the crawler tables', async () => {
  const { db, env, now } = fixture();
  const { token } = await (await mint(env)).json();
  const before = peopleTables(db);

  const r = await report(env, token, [
    { ua: UA.googlebot, path: '/post-1?utm_source=x#top', ip: '203.0.113.9', status: 200, country: 'US', ts: now - 60e3 },
    { ua: UA.googlebot, path: 'https://a.example/post-2?q=1', status: 404, ts: now + 3600e3 }, // future → now
    { ua: UA.chatgpt, path: '/privacy', status: 200 },
    { ua: UA.chrome, path: '/' },                                   // a person: ignored
    { ua: UA.googlebot, path: 'no-slash' },                         // bad path
    { ua: UA.googlebot, path: '/old', ts: now - 49 * 3600e3 },      // older than 48h
    { ua: UA.bingbot },                                             // no path
    'garbage',
  ]);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { accepted: 3, ignored: 5 });

  const day = new Date(now).toISOString().slice(0, 10);
  const gb = db.prepare("SELECT * FROM rollup_crawler_daily WHERE engine = 'googlebot' AND source = 'server'").get();
  assert.equal(gb.day, day);
  assert.equal(gb.hits, 2);
  assert.equal(gb.error_hits, 1);
  assert.equal(gb.kind, 'search');
  assert.equal(gb.pages, null);
  assert.deepEqual(db.prepare('SELECT engine, path, hits FROM rollup_crawler_server_page_daily ORDER BY engine, path').all().map((x) => ({ ...x })),
    [{ engine: 'googlebot', path: '/post-1', hits: 1 }, { engine: 'googlebot', path: '/post-2', hits: 1 }, { engine: 'openai', path: '/privacy', hits: 1 }]);
  const ms = db.prepare("SELECT * FROM crawler_milestones WHERE engine = 'googlebot'").get();
  assert.equal(ms.first_source, 'server');
  assert.equal(ms.first_path, '/post-1');
  assert.equal(ms.first_seen_at, now - 60e3);

  // additive: a second report accumulates, and the milestone keeps the earliest
  await report(env, token, [{ ua: UA.googlebot, path: '/post-1', status: 200 }]);
  assert.equal(db.prepare("SELECT hits FROM rollup_crawler_daily WHERE engine = 'googlebot' AND source = 'server'").get().hits, 3);
  assert.equal(db.prepare("SELECT hits FROM rollup_crawler_server_page_daily WHERE path = '/post-1'").get().hits, 2);
  assert.equal(db.prepare("SELECT first_path FROM crawler_milestones WHERE engine = 'googlebot'").get().first_path, '/post-1');

  // nothing people-related moved; the hourly rollup leaves server rows alone
  assert.deepEqual(peopleTables(db), before);
  await runHourlyRollup(env);
  assert.equal(db.prepare("SELECT hits FROM rollup_crawler_daily WHERE engine = 'googlebot' AND source = 'server'").get().hits, 3);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rollup_crawler_server_page_daily').get().n, 3);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM rollup_site_daily WHERE pv > 0 OR uv > 0").get().n, 0);

  // limits
  const many = Array.from({ length: 101 }, () => ({ ua: UA.googlebot, path: '/' }));
  assert.equal((await report(env, token, many)).status, 413);
  const big = JSON.stringify({ hits: [{ ua: UA.googlebot, path: '/' + 'x'.repeat(70000) }] });
  assert.equal((await call(env, 'POST', '/v1/sites/siteA001/crawler_hits', token, big)).status, 413);
  assert.equal((await call(env, 'POST', '/v1/sites/siteA001/crawler_hits', token, '{nope')).status, 400);
  assert.equal((await call(env, 'POST', '/v1/sites/siteA001/crawler_hits', token, { hit: [] })).status, 400);
  assert.equal((await call(env, 'GET', '/v1/sites/siteA001/crawler_hits', token)).status, 403); // GET = read path
  // a long path is cut to 512 chars
  await report(env, token, [{ ua: UA.bingbot, path: '/' + 'y'.repeat(600) }]);
  assert.equal(db.prepare("SELECT length(path) AS n FROM rollup_crawler_server_page_daily WHERE engine = 'bingbot'").get().n, 512);
  // last_used_at is refreshed at most hourly
  assert.ok(db.prepare("SELECT last_used_at FROM api_tokens WHERE permission = 'ingest'").get().last_used_at > 0);

  // archived sites stop accepting reports
  db.prepare("UPDATE sites SET status = 'archived' WHERE site_id = 'siteA001'").run();
  assert.equal((await report(env, token, [{ ua: UA.googlebot, path: '/' }])).status, 403);
});

test('new paths per engine-day are capped; the daily count stays exact', async () => {
  const { db, env } = fixture();
  const { token } = await (await mint(env)).json();
  for (let batch = 0; batch < 3; batch++) {
    const hits = Array.from({ length: 70 }, (_, i) => ({ ua: UA.googlebot, path: `/p${batch * 70 + i}` }));
    assert.equal((await report(env, token, hits)).status, 200);
  }
  await report(env, token, [{ ua: UA.googlebot, path: '/p0' }]); // existing path still accumulates
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rollup_crawler_server_page_daily').get().n, 200);
  assert.equal(db.prepare("SELECT hits FROM rollup_crawler_server_page_daily WHERE path = '/p0'").get().hits, 2);
  assert.equal(db.prepare("SELECT hits FROM rollup_crawler_daily WHERE source = 'server'").get().hits, 211);
});

test('GET /crawlers merges the server source by daily max, with bot / search filters', async () => {
  const { db, env, now } = fixture();
  const { token } = await (await mint(env)).json();
  const day = new Date(now).toISOString().slice(0, 10);

  // before any report: server unavailable, said so
  let d = await (await call(env, 'GET', '/v1/sites/siteA001/crawlers?period=7d', 'pvuv_read')).json();
  assert.equal(d.sources.server.available, false);
  assert.equal(d.top_pages.source, 'beacon');

  // beacon saw 2 Googlebot pageviews of '/' today (JS-rendering); the server saw 5 requests
  db.prepare("INSERT INTO rollup_crawler_daily(site_id,day,engine,source,kind,hits,pages,first_ts,last_ts) VALUES ('siteA001',?,'googlebot','beacon','search',2,1,?,?)").run(day, now - 5e3, now - 5e3);
  db.prepare("INSERT INTO rollup_crawler_page_daily(site_id,day,engine,path,hits) VALUES ('siteA001',?,'googlebot','/',2)").run(day);
  db.prepare("INSERT INTO crawler_milestones(site_id,engine,kind,first_seen_at,last_seen_at,first_source,first_path) VALUES ('siteA001','googlebot','search',?,?,'beacon','/')").run(now - 5e3, now - 5e3);
  await report(env, token, [
    ...Array.from({ length: 3 }, () => ({ ua: UA.googlebot, path: '/', status: 200 })),
    ...Array.from({ length: 2 }, () => ({ ua: UA.googlebot, path: '/robots-only', status: 404 })),
    { ua: UA.chatgpt, path: '/faq', status: 200, verified: true },
  ]);

  d = await (await call(env, 'GET', '/v1/sites/siteA001/crawlers?period=7d', 'pvuv_read')).json();
  assert.equal(d.sources.server.available, true);
  assert.match(d.merge, /max\(beacon, edge, server\)/);
  const g = d.engines.find((e) => e.engine === 'googlebot');
  assert.equal(g.beacon_hits, 2);
  assert.equal(g.server_hits, 5);
  assert.equal(g.hits, 5); // max per day, not the sum
  assert.equal(g.server_error_hits, 2);
  assert.equal(g.pages, 2);
  assert.deepEqual(g.days, [{ day, beacon: 2, edge: 0, server: 5 }]);
  assert.equal(g.first_source, 'beacon'); // the beacon saw it earlier
  const o = d.engines.find((e) => e.engine === 'openai');
  assert.equal(o.first_source, 'server');
  assert.equal(o.server_verified_hits, 1);
  assert.equal(d.top_pages.source, 'beacon+server');
  assert.deepEqual(d.top_pages.pages.find((p) => p.path === '/'), { path: '/', hits: 3, engines: { googlebot: 3 } }); // max(2, 3)
  assert.ok(d.top_pages.pages.find((p) => p.path === '/faq')); // a non-JS crawler's page
  assert.equal(d.engines[0].engine, 'googlebot'); // search first

  // bot filter (case-insensitive) and search filter
  const only = await (await call(env, 'GET', '/v1/sites/siteA001/crawlers?period=7d&bot=GoogleBot', 'pvuv_read')).json();
  assert.deepEqual(only.engines.map((e) => e.engine), ['googlebot']);
  assert.ok(only.top_pages.pages.every((p) => Object.keys(p.engines).every((k) => k === 'googlebot')));
  assert.deepEqual(only.filters, { bot: 'googlebot', search: false });
  const ai = await (await call(env, 'GET', '/v1/sites/siteA001/crawlers?period=7d&bot=openai', 'pvuv_read')).json();
  assert.equal(ai.first_search_crawl_at, null);
  const search = await (await call(env, 'GET', '/v1/sites/siteA001/crawlers?period=7d&search=1', 'pvuv_read')).json();
  assert.deepEqual(search.engines.map((e) => e.engine), ['googlebot']);
  assert.ok(!search.top_pages.pages.some((p) => p.path === '/faq'));
  const notSearch = await (await call(env, 'GET', '/v1/sites/siteA001/crawlers?period=7d&search=false', 'pvuv_read')).json();
  assert.equal(notSearch.engines.length, 2);
});

test('console lists ingest tokens with their permission and can revoke them', async () => {
  const { env } = fixture();
  const t = await (await mint(env)).json();
  const payload = Buffer.from(JSON.stringify({ u: 'owner', exp: Date.now() + 60000 })).toString('base64url');
  const cookie = `_pvc_s=${payload}.${createHmac('sha256', 'test-key').update('session|' + payload).digest('base64url')}`;
  const c = (method, path) => consoleWorker.fetch(new Request('https://console.test' + path, { method, headers: { cookie } }), env);
  const list = await (await c('GET', '/api/tokens')).json();
  const row = list.tokens.find((x) => x.token_id === t.token_id);
  assert.equal(row.permission, 'ingest');
  assert.equal(row.site_id, 'siteA001');
  assert.equal((await (await c('DELETE', `/api/tokens?id=${t.token_id}`)).json()).revoked, 1);
  assert.equal((await report(env, t.token, [{ ua: UA.googlebot, path: '/' }])).status, 401);
});

test('migration 0025 applies on top of 0024 and matches the canonical schema', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync('migrations/0024_crawler_milestones.sql', 'utf8'));
  db.exec(readFileSync('migrations/0025_crawler_server_hits.sql', 'utf8'));
  const canonical = new DatabaseSync(':memory:');
  canonical.exec(readFileSync('shared/schema.sql', 'utf8'));
  const cols = (d, t) => d.prepare(`SELECT name FROM pragma_table_info('${t}') ORDER BY cid`).all().map((r) => r.name);
  for (const t of ['rollup_crawler_daily', 'rollup_crawler_server_page_daily', 'crawler_milestones']) {
    assert.deepEqual(cols(db, t), cols(canonical, t), t);
  }
});
