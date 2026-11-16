// Crawler / indexing signals (migration 0024): classification, milestone
// idempotency, endpoint auth, graceful degradation, and "never touches PV/UV".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import api from '../.test-api.mjs';
import consoleWorker from '../.test-console.mjs';
import {
  runHourlyRollup, rollupCrawlerDay, recordEdgeCrawlerDay, backfillCrawlersOnce, existingEventTables,
  classifyCrawler, kindFromCategory, CRAWLER_BACKFILL_FLAG, eventsTableDDL, monthSuffix,
} from '../.test-cron.mjs';

const UA = {
  googlebot: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  googlebotSmartphone: 'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.126 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  googlebotImage: 'Googlebot-Image/1.0',
  adsbot: 'AdsBot-Google (+http://www.google.com/adsbot.html)',
  adsbotMobile: 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_7_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.2 Mobile/15E148 Safari/604.1 (compatible; AdsBot-Google-Mobile; +http://www.google.com/mobile/adsbot.html)',
  mediapartners: 'Mediapartners-Google',
  bingbot: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/116.0.1938.76 Safari/537.36',
  yandex: 'Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)',
  baidu: 'Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)',
  applebot: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.1.1 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)',
  duckduckbot: 'DuckDuckBot/1.1; (+http://duckduckgo.com/duckduckbot.html)',
  sogou: 'Sogou web spider/4.0(+http://www.sogou.com/docs/help/webmasters.htm#07)',
  so360: 'Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/50.0.2661.102 Safari/537.36; 360Spider',
  bytespider: 'Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; Bytespider; spider-feedback@bytedance.com)',
  petal: 'Mozilla/5.0 (compatible;PetalBot;+https://webmaster.petalsearch.com/site/petalbot)',
  gptbot: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot',
  ahrefs: 'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)',
  chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  sogouBrowser: 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/80.0 Mobile Safari/537.36 SogouMobileBrowser/5.30.6',
};

test('built-in engine classification', () => {
  const c = (ua, cat) => { const m = classifyCrawler(ua, cat); return m && `${m.engine}/${m.kind}`; };
  assert.equal(c(UA.googlebot), 'googlebot/search');
  assert.equal(c(UA.googlebotSmartphone), 'googlebot/search');
  assert.equal(c(UA.googlebotImage), 'googlebot/search');
  assert.equal(c(UA.adsbot), 'google_adsbot/ads');
  assert.equal(c(UA.adsbotMobile), 'google_adsbot/ads');
  assert.equal(c(UA.mediapartners), 'google_adsense/ads');
  assert.equal(c(UA.bingbot), 'bingbot/search');
  assert.equal(c(UA.yandex), 'yandex/search');
  assert.equal(c(UA.baidu), 'baidu/search');
  assert.equal(c(UA.applebot), 'applebot/search');
  assert.equal(c(UA.duckduckbot), 'duckduckgo/search');
  assert.equal(c(UA.sogou), 'sogou/search');
  assert.equal(c(UA.so360), 'so360/search');
  assert.equal(c(UA.bytespider), 'bytespider/ai');
  assert.equal(c(UA.petal), 'petal/search');
  assert.equal(c(UA.gptbot), 'openai/ai');
  assert.equal(c(UA.ahrefs), 'ahrefs/seo');
  // browsers are not crawlers — including the Sogou BROWSER
  assert.equal(c(UA.chrome), null);
  assert.equal(c(UA.sogouBrowser), null);
  assert.equal(c(null), null);
});

test('imported directory category wins for kind; ads bots stay ads; unknown crawlers bucket by kind', () => {
  assert.equal(kindFromCategory('search_engine_crawler'), 'search');
  assert.equal(kindFromCategory('search_engine_optimization'), 'seo');
  assert.equal(kindFromCategory('ai_crawler'), 'ai');
  assert.equal(kindFromCategory('ai_search'), 'ai');
  assert.equal(kindFromCategory('advertising__marketing'), 'ads');
  assert.equal(kindFromCategory('ai_agent_declared'), 'ai');
  assert.equal(kindFromCategory('monitoring_analytics'), 'other');
  assert.equal(kindFromCategory('uncategorized'), null);
  assert.equal(kindFromCategory(null), null);
  // directory category overrides the built-in kind …
  assert.equal(classifyCrawler(UA.bytespider, 'search_engine_crawler').kind, 'search');
  // … except for Google's ads crawlers, which must never merge into "search"
  assert.equal(classifyCrawler(UA.mediapartners, 'search_engine_crawler').kind, 'ads');
  // a crawler the built-in list does not know still lands in a kind bucket
  assert.deepEqual(classifyCrawler('SomeNewBot/1.0', 'ai_crawler'), { engine: 'other_ai', label: 'Other AI crawler', kind: 'ai' });
  assert.equal(classifyCrawler('SomeNewBot/1.0', null), null);
});

// ---------------------------------------------------------------------------
// fixture: schema.sql in node:sqlite, with the D1 surface the cron needs (batch)
// ---------------------------------------------------------------------------

const HOUR = 3600e3;
const hmac = (token) => createHmac('sha256', 'test-key').update('apitoken:' + token).digest('base64url');

function fixture({ dropCrawlerTables = false } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync('shared/schema.sql', 'utf8'));
  if (dropCrawlerTables) db.exec('DROP TABLE crawler_milestones; DROP TABLE rollup_crawler_daily; DROP TABLE rollup_crawler_page_daily;');
  const now = Date.now();
  for (const sql of eventsTableDDL(monthSuffix(now))) db.exec(sql);
  // also the previous month, in case "now - a few hours" crosses a month boundary
  for (const sql of eventsTableDDL(monthSuffix(now - 3 * 86400e3))) db.exec(sql);

  db.exec("INSERT INTO users(user_id,created_at) VALUES ('owner',1),('other',1)");
  const created = now - 5 * 86400e3; // launched five days ago
  db.prepare('INSERT INTO sites(site_id,name,owner_id,allowed_domains,timezone,created_at) VALUES (?,?,?,?,?,?)')
    .run('siteA001', 'A', 'owner', '["a.example"]', 'UTC', created);
  db.prepare('INSERT INTO sites(site_id,name,owner_id,allowed_domains,timezone,created_at) VALUES (?,?,?,?,?,?)')
    .run('siteB001', 'B', 'owner', '["b.example"]', 'UTC', created);
  db.prepare('INSERT INTO sites(site_id,name,owner_id,allowed_domains,timezone,created_at) VALUES (?,?,?,?,?,?)')
    .run('siteC001', 'C', 'other', '["c.example"]', 'UTC', created);
  for (const [id, token, owner, site] of [['r', 'pvuv_read', 'owner', null], ['s', 'pvuv_scoped', 'owner', 'siteA001'], ['o', 'pvuv_other', 'other', null]]) {
    db.prepare('INSERT INTO api_tokens(token_id,owner_id,name,token_hash,prefix,site_id,created_at,permission) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, owner, id, hmac(token), id, site, 1, 'read');
  }

  // events: a human, a Googlebot sweep, and one legacy crawler row recorded
  // before ingest stamped an engine (crawler_engine NULL, category only).
  // Spread within the current UTC day so "today" holds all of them.
  const dayStart = Math.floor(now / 86400e3) * 86400e3;
  const at = (k) => dayStart + Math.min(now - dayStart - 1000, 60e3 * (k + 1));
  const table = `events_${monthSuffix(now)}`;
  const ins = db.prepare(`INSERT INTO ${table}(eid,site_id,event,visitor_id,session_id,url,hostname,path,browser,verdict,bot_category,crawler_engine,ts,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  let n = 0;
  const ev = (site, vid, path, verdict, cat, engine, ts, event = 'pageview') =>
    ins.run(`e${n++}`, site, event, vid, `s-${vid}`, `https://a.example${path}`, 'a.example', path, engine ? 'crawler' : 'Chrome', verdict, cat, engine, ts, ts);
  ev('siteA001', 'human1', '/', 'clean', null, null, at(1));
  ev('siteA001', 'human1', '/about', 'clean', null, null, at(2));
  ev('siteA001', 'gb1', '/', 'crawler', 'search_engine_crawler', 'googlebot', at(3));
  ev('siteA001', 'gb1', '/post-1', 'crawler', 'search_engine_crawler', 'googlebot', at(4));
  ev('siteA001', 'gb2', '/post-1', 'crawler', null, 'googlebot', at(5));
  ev('siteA001', 'gb2', '/post-1', 'crawler', null, 'googlebot', at(6), 'page_leave'); // not a pageview → not a hit
  ev('siteA001', 'ads1', '/', 'crawler', null, 'google_adsense', at(7));
  ev('siteA001', 'legacy', '/old', 'crawler', 'search_engine_crawler', null, at(8));
  ev('siteB001', 'human2', '/', 'clean', null, null, at(9));

  const wrap = (sql) => {
    let args = [];
    return {
      sql,
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
  return { db, now, dayStart, env: { DB, HMAC_KEY: 'test-key', BLOCKLIST: {}, SITE_CONFIG: { put: async () => {} } } };
}

const snapshot = (db) => ({
  milestones: db.prepare('SELECT site_id,engine,kind,first_seen_at,last_seen_at,first_source,first_path FROM crawler_milestones ORDER BY site_id,engine').all(),
  daily: db.prepare('SELECT * FROM rollup_crawler_daily ORDER BY site_id,day,engine,source').all(),
  pages: db.prepare('SELECT * FROM rollup_crawler_page_daily ORDER BY site_id,day,engine,path').all(),
});
const pvuv = (db) => ({
  site: db.prepare('SELECT * FROM rollup_site_daily ORDER BY site_id,day').all(),
  page: db.prepare('SELECT * FROM rollup_page_daily ORDER BY site_id,day,hostname,path').all(),
});
const get = (env, path, token) => api.fetch(new Request('https://api.test' + path, { headers: token ? { authorization: `Bearer ${token}` } : {} }), env);
const sessionCookie = (user) => {
  const payload = Buffer.from(JSON.stringify({ u: user, exp: Date.now() + 60000 })).toString('base64url');
  return `_pvc_s=${payload}.${createHmac('sha256', 'test-key').update('session|' + payload).digest('base64url')}`;
};

test('hourly rollup fills beacon milestones + daily rows, idempotently', async () => {
  const { db, env, dayStart } = fixture();
  await runHourlyRollup(env);
  const first = snapshot(db);

  const gb = first.milestones.find((m) => m.site_id === 'siteA001' && m.engine === 'googlebot');
  assert.equal(gb.kind, 'search');
  assert.equal(gb.first_source, 'beacon');
  assert.equal(gb.first_path, '/');
  const ads = first.milestones.find((m) => m.engine === 'google_adsense');
  assert.equal(ads.kind, 'ads');
  // the legacy row (no engine stamped) still counts, as a search crawl of unknown engine
  assert.ok(first.milestones.find((m) => m.engine === 'other_search'));
  // nothing for the site that had no crawler
  assert.equal(first.milestones.filter((m) => m.site_id === 'siteB001').length, 0);

  const day = new Date(dayStart).toISOString().slice(0, 10);
  const gbDay = first.daily.find((r) => r.engine === 'googlebot' && r.source === 'beacon');
  assert.equal(gbDay.day, day);
  assert.equal(gbDay.hits, 3);   // page_leave is not a hit
  assert.equal(gbDay.pages, 2);  // '/', '/post-1'
  assert.deepEqual(first.pages.filter((p) => p.engine === 'googlebot').map((p) => [p.path, p.hits]), [['/', 1], ['/post-1', 2]]);

  // the one-time backfill ran in the same job and finished (fewer sites than a batch)
  assert.equal(db.prepare('SELECT value FROM instance_settings WHERE key = ?').get(CRAWLER_BACKFILL_FLAG)?.value, '1');

  // run again, and run the backfill again from scratch: nothing changes
  await runHourlyRollup(env);
  assert.deepEqual(snapshot(db), first);
  db.prepare('DELETE FROM instance_settings WHERE key = ?').run(CRAWLER_BACKFILL_FLAG);
  await backfillCrawlersOnce(env, await existingEventTables(env.DB));
  assert.deepEqual(snapshot(db), first);
});

test('edge agents add non-JS crawlers; milestones merge with MIN/MAX and stay idempotent', async () => {
  const { db, env, dayStart } = fixture();
  await runHourlyRollup(env);
  const yesterday = new Date(dayStart - 86400e3).toISOString().slice(0, 10);
  const agents = [
    { userAgent: UA.googlebot, requests: 7 },
    { userAgent: UA.googlebotSmartphone, requests: 5 },
    { userAgent: UA.bingbot, requests: 3 },
    { userAgent: UA.chrome, requests: 400 }, // a browser: ignored
    { userAgent: 'SomeNewBot/1.0', requests: 9 }, // unknown, no directory: ignored
  ];
  await recordEdgeCrawlerDay(env.DB, 'siteA001', yesterday, dayStart - 86400e3, agents);
  const once = snapshot(db);
  await recordEdgeCrawlerDay(env.DB, 'siteA001', yesterday, dayStart - 86400e3, agents);
  assert.deepEqual(snapshot(db), once);

  const gb = once.milestones.find((m) => m.engine === 'googlebot');
  assert.equal(gb.first_seen_at, dayStart - 86400e3); // the edge saw it a day earlier
  assert.equal(gb.first_source, 'edge');
  assert.ok(gb.last_seen_at > dayStart);               // the beacon's later hit is kept
  const bing = once.milestones.find((m) => m.engine === 'bingbot');
  assert.equal(bing.first_source, 'edge');
  assert.equal(bing.kind, 'search');
  const edgeRows = once.daily.filter((r) => r.source === 'edge');
  assert.deepEqual(edgeRows.map((r) => [r.engine, r.hits, r.pages]).sort(), [['bingbot', 3, null], ['googlebot', 12, null]]);

  // the hourly job re-running does not undo the edge contribution
  await runHourlyRollup(env);
  assert.deepEqual(snapshot(db), once);

  // a re-pull that no longer lists bingbot replaces that day's edge rows (the
  // milestone, being durable, stays)
  await recordEdgeCrawlerDay(env.DB, 'siteA001', yesterday, dayStart - 86400e3, agents.slice(0, 2));
  const after = snapshot(db);
  assert.equal(after.daily.filter((r) => r.source === 'edge' && r.engine === 'bingbot').length, 0);
  assert.ok(after.milestones.find((m) => m.engine === 'bingbot'));

  // backfill from rollup_edge_agent_daily reproduces the same edge rows
  db.prepare('INSERT INTO rollup_edge_daily(site_id,day,requests,html_requests) VALUES (?,?,?,?)').run('siteA001', yesterday, 500, 420);
  for (const a of agents) db.prepare('INSERT INTO rollup_edge_agent_daily(site_id,day,user_agent,requests) VALUES (?,?,?,?)').run('siteA001', yesterday, a.userAgent, a.requests);
  db.prepare('DELETE FROM instance_settings WHERE key = ?').run(CRAWLER_BACKFILL_FLAG);
  await backfillCrawlersOnce(env, await existingEventTables(env.DB));
  assert.deepEqual(snapshot(db).daily, once.daily);
});

test('GET /v1/sites/{id}/crawlers: auth, site-scoped tokens, shape, sources', async () => {
  const { db, env, dayStart } = fixture();
  await runHourlyRollup(env);

  assert.equal((await get(env, '/v1/sites/siteA001/crawlers')).status, 401);
  assert.equal((await get(env, '/v1/sites/siteA001/crawlers', 'pvuv_nope')).status, 401);
  assert.equal((await get(env, '/v1/sites/siteA001/crawlers', 'pvuv_other')).status, 403); // not their site
  assert.equal((await get(env, '/v1/sites/siteB001/crawlers', 'pvuv_scoped')).status, 403); // scoped to A
  assert.equal((await get(env, '/v1/sites/siteC001/crawlers', 'pvuv_read')).status, 403);

  const r = await get(env, '/v1/sites/siteA001/crawlers?period=7d', 'pvuv_scoped');
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.available, true);
  assert.equal(d.sources.beacon.available, true);
  assert.equal(d.sources.edge.available, false); // no CF token → beacon only, said so
  assert.match(d.sources.edge.note, /Not available/);
  assert.equal(d.top_pages.source, 'beacon');
  assert.equal(d.engines[0].engine, 'googlebot'); // search engines first
  assert.equal(d.engines[0].hits, 3);
  assert.equal(d.engines[0].beacon_hits, 3);
  assert.equal(d.engines[0].pages, 2);
  assert.equal(d.engines[0].days.length, 1);
  const gb = db.prepare("SELECT first_seen_at FROM crawler_milestones WHERE site_id='siteA001' AND engine='googlebot'").get();
  const firstSearch = db.prepare("SELECT MIN(first_seen_at) AS t FROM crawler_milestones WHERE site_id='siteA001' AND kind='search'").get().t;
  assert.equal(d.first_search_crawl_at, firstSearch);
  assert.ok(firstSearch <= gb.first_seen_at);
  assert.deepEqual(d.top_pages.pages.find((p) => p.path === '/post-1'), { path: '/post-1', hits: 2, engines: { googlebot: 2 } });
  assert.deepEqual(d.top_pages.pages.find((p) => p.path === '/'), { path: '/', hits: 2, engines: { googlebot: 1, google_adsense: 1 } });
  assert.ok(!d.engines.some((e) => e.engine === 'google_adsense' && e.kind !== 'ads'));

  // edge source flips on once the pull has reached the site
  db.prepare('INSERT INTO rollup_edge_daily(site_id,day,requests,html_requests) VALUES (?,?,?,?)')
    .run('siteA001', new Date(dayStart - 86400e3).toISOString().slice(0, 10), 10, 8);
  assert.equal((await (await get(env, '/v1/sites/siteA001/crawlers', 'pvuv_read')).json()).sources.edge.available, true);

  // site list carries first_search_crawl_at; a scoped token sees only its site
  const all = await (await get(env, '/v1/sites', 'pvuv_read')).json();
  assert.equal(all.sites.find((s) => s.site_id === 'siteA001').first_search_crawl_at, firstSearch);
  assert.equal(all.sites.find((s) => s.site_id === 'siteB001').first_search_crawl_at, null);
  const scoped = await (await get(env, '/v1/sites', 'pvuv_scoped')).json();
  assert.deepEqual(scoped.sites.map((s) => s.site_id), ['siteA001']);

  // console: same resource behind the session cookie, owner-only
  const cget = (user, id) => consoleWorker.fetch(new Request(`https://console.test/api/sites/${id}/crawlers?period=30d`, { headers: { cookie: sessionCookie(user) } }), env);
  const c = await cget('owner', 'siteA001');
  assert.equal(c.status, 200);
  assert.equal((await c.json()).engines[0].engine, 'googlebot');
  assert.equal((await cget('other', 'siteA001')).status, 403);
});

test('crawler signals never change PV/UV, and degrade gracefully before migration 0024', async () => {
  const withTables = fixture();
  const without = fixture({ dropCrawlerTables: true });

  // overview straight from raw events, before and after the crawler tables fill
  const ov = async (f) => (await get(f.env, '/v1/sites/siteA001/overview?period=today', 'pvuv_read')).json();
  const before = await ov(withTables);
  await runHourlyRollup(withTables.env);
  assert.ok(snapshot(withTables.db).milestones.length > 0);
  assert.deepEqual(await ov(withTables), before);

  // the PV/UV rollups are byte-identical with and without the crawler step
  await runHourlyRollup(without.env); // crawler writes fail inside → caught, rollup unaffected
  assert.deepEqual(pvuv(without.db), pvuv(withTables.db));
  assert.ok(pvuv(withTables.db).site.length > 0);

  // API before 0024: an explicit unavailable answer, and a site list that still works
  const d = await (await get(without.env, '/v1/sites/siteA001/crawlers', 'pvuv_read')).json();
  assert.equal(d.available, false);
  assert.deepEqual(d.engines, []);
  const sites = await (await get(without.env, '/v1/sites', 'pvuv_read')).json();
  assert.ok(sites.sites.every((s) => s.first_search_crawl_at === null));

  // re-running the crawler step for the day leaves PV/UV untouched
  const pre = pvuv(withTables.db);
  const day = new Date(withTables.dayStart).toISOString().slice(0, 10);
  await rollupCrawlerDay(withTables.env.DB, 'siteA001', day, withTables.dayStart, withTables.dayStart + 86400e3, await existingEventTables(withTables.env.DB));
  assert.deepEqual(pvuv(withTables.db), pre);
});
