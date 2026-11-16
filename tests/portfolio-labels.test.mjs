// Portfolio write side (docs/design/portfolio-ui.md §3.2): bulk actions, per-site
// labels and the thresholds settings endpoint, on both the console (session
// cookie) and the api worker (write tokens).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import api from '../.test-api.mjs';
import consoleWorker from '../.test-console.mjs';

// site_labels comes from migration 0026 (portfolio overview stream); the
// fixture creates the same table so these tests stand on their own.
const SITE_LABELS = "CREATE TABLE IF NOT EXISTS site_labels (site_id TEXT PRIMARY KEY, starred INTEGER DEFAULT 0, tags TEXT DEFAULT '[]', notes TEXT, updated_at INTEGER)";

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync('shared/schema.sql', 'utf8'));
  db.exec(SITE_LABELS);
  db.exec("INSERT INTO users(user_id,created_at) VALUES ('owner',1),('other',1)");
  const ins = db.prepare("INSERT INTO sites(site_id,name,owner_id,allowed_domains,adguard_mode,created_at,status) VALUES(?,?,?,?,?,?,?)");
  ins.run('siteA001', 'A', 'owner', '["a.example"]', 'off', 1, 'active');
  ins.run('siteB002', 'B', 'owner', '["b.example"]', 'off', 2, 'active');
  ins.run('siteC003', 'C', 'owner', '["c.example"]', 'off', 3, 'archived');
  ins.run('siteX009', 'X', 'other', '["x.example"]', 'off', 4, 'active');
  const hmac = token => createHmac('sha256', 'test-key').update('apitoken:' + token).digest('base64url');
  for (const [id, token, permission, owner, site] of [['w','pvuv_write','write','owner',null],['r','pvuv_read','read','owner',null],['s','pvuv_sitew','write','owner','siteA001']]) {
    db.prepare('INSERT INTO api_tokens(token_id,owner_id,name,token_hash,prefix,site_id,created_at,permission) VALUES(?,?,?,?,?,?,?,?)').run(id,owner,id,hmac(token),id,site,1,permission);
  }
  const stmt = (sql, args = []) => ({
    bind(...x) { return stmt(sql, x); },
    async first() { return db.prepare(sql).get(...args) ?? null; },
    async all() { return { results: db.prepare(sql).all(...args) }; },
    async run() { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
  });
  const DB = { prepare: sql => stmt(sql), async batch(list) { const out = []; for (const s of list) out.push(await s.run()); return out; } };
  const deleted = [];
  const SITE_CONFIG = { put: async () => {}, delete: async k => { deleted.push(k); } };
  return { db, deleted, env: { DB, HMAC_KEY: 'test-key', SITE_CONFIG } };
}

function cookie(user = 'owner') {
  const payload = Buffer.from(JSON.stringify({ u: user, exp: Date.now() + 60000 })).toString('base64url');
  const sig = createHmac('sha256', 'test-key').update('session|' + payload).digest('base64url');
  return `_pvc_s=${payload}.${sig}`;
}
const consoleReq = (env, method, path, body, user = 'owner') => consoleWorker.fetch(new Request('https://console.test' + path, {
  method, headers: { cookie: cookie(user), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
}), env);
const apiReq = (env, token, method, path, body) => api.fetch(new Request('https://api.test' + path, {
  method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
}), env);
const labels = (db, id) => db.prepare('SELECT starred, tags, notes FROM site_labels WHERE site_id = ?').get(id);

test('console bulk star/tag/untag updates only the owner\'s sites', async () => {
  const { env, db } = fixture();
  let r = await consoleReq(env, 'POST', '/api/sites/bulk', { site_ids: ['siteA001', 'siteB002'], action: 'star' });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).updated, 2);
  assert.equal(labels(db, 'siteA001').starred, 1);
  r = await consoleReq(env, 'POST', '/api/sites/bulk', { site_ids: ['siteA001', 'siteB002'], action: 'tag', value: '  小游戏 ' });
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(labels(db, 'siteB002').tags), ['小游戏']);
  assert.equal(labels(db, 'siteB002').starred, 1, 'tagging keeps the star');
  // the same tag in another case is not added twice
  r = await (await consoleReq(env, 'POST', '/api/sites/bulk', { site_ids: ['siteA001'], action: 'tag', value: '小游戏' })).json();
  assert.equal(r.updated, 0);
  await consoleReq(env, 'POST', '/api/sites/bulk', { site_ids: ['siteA001'], action: 'untag', value: '小游戏' });
  assert.deepEqual(JSON.parse(labels(db, 'siteA001').tags), []);
  await consoleReq(env, 'POST', '/api/sites/bulk', { site_ids: ['siteA001'], action: 'unstar' });
  assert.equal(labels(db, 'siteA001').starred, 0);
});

test('bulk is all-or-nothing on ownership and validates input', async () => {
  const { env, db } = fixture();
  const r = await consoleReq(env, 'POST', '/api/sites/bulk', { site_ids: ['siteA001', 'siteX009'], action: 'star' });
  assert.equal(r.status, 403);
  assert.equal(labels(db, 'siteA001'), undefined, 'nothing applied');
  assert.equal((await consoleReq(env, 'POST', '/api/sites/bulk', { site_ids: ['siteA001'], action: 'explode' })).status, 400);
  assert.equal((await consoleReq(env, 'POST', '/api/sites/bulk', { site_ids: [], action: 'star' })).status, 400);
  assert.equal((await consoleReq(env, 'POST', '/api/sites/bulk', { site_ids: ['../x'], action: 'star' })).status, 400);
  assert.equal((await consoleReq(env, 'POST', '/api/sites/bulk', { site_ids: ['siteA001'], action: 'tag', value: '' })).status, 400);
  assert.equal((await consoleReq(env, 'POST', '/api/sites/bulk', { site_ids: ['siteA001'], action: 'tag', value: 'launch:2026-W01' })).status, 400);
  assert.equal((await consoleReq(env, 'POST', '/api/sites/bulk', { site_ids: ['siteA001'], action: 'adguard', value: 'nuclear' })).status, 400);
  assert.equal((await consoleReq(env, 'POST', '/api/sites/bulk', { site_ids: Array.from({ length: 501 }, (_, i) => 'site' + i), action: 'star' })).status, 400);
  // no session → 401
  const anon = await consoleWorker.fetch(new Request('https://console.test/api/sites/bulk', { method: 'POST', body: '{}' }), env);
  assert.equal(anon.status, 401);
});

test('bulk tag stops at 20 tags per site and long tags are clipped to 32 chars', async () => {
  const { env, db } = fixture();
  db.prepare('INSERT INTO site_labels(site_id,starred,tags) VALUES(?,?,?)').run('siteA001', 0, JSON.stringify(Array.from({ length: 20 }, (_, i) => 't' + i)));
  const r = await (await consoleReq(env, 'POST', '/api/sites/bulk', { site_ids: ['siteA001', 'siteB002'], action: 'tag', value: 'x'.repeat(40) })).json();
  assert.equal(r.updated, 1);
  assert.deepEqual(r.skipped, [{ site_id: 'siteA001', reason: 'tag_limit' }]);
  assert.equal(JSON.parse(labels(db, 'siteB002').tags)[0].length, 32);
});

test('archive / restore / adguard update sites and invalidate the KV site config', async () => {
  const { env, db, deleted } = fixture();
  let r = await (await consoleReq(env, 'POST', '/api/sites/bulk', { site_ids: ['siteA001', 'siteC003'], action: 'archive' })).json();
  assert.equal(r.updated, 1, 'already archived site is a no-op');
  assert.equal(db.prepare('SELECT status FROM sites WHERE site_id=?').get('siteA001').status, 'archived');
  assert.deepEqual(deleted, ['site:siteA001']);
  deleted.length = 0;
  r = await (await consoleReq(env, 'POST', '/api/sites/bulk', { site_ids: ['siteA001'], action: 'restore' })).json();
  assert.equal(r.updated, 1);
  assert.equal(db.prepare('SELECT status FROM sites WHERE site_id=?').get('siteA001').status, 'active');
  assert.deepEqual(deleted, ['site:siteA001']);
  deleted.length = 0;
  r = await (await consoleReq(env, 'POST', '/api/sites/bulk', { site_ids: ['siteA001', 'siteB002'], action: 'adguard', value: 'balanced' })).json();
  assert.equal(r.updated, 2);
  assert.equal(db.prepare('SELECT adguard_mode FROM sites WHERE site_id=?').get('siteB002').adguard_mode, 'balanced');
  assert.deepEqual(deleted.sort(), ['site:siteA001', 'site:siteB002']);
});

test('restore skips a site whose domain now belongs to another active site', async () => {
  const { env, db } = fixture();
  db.prepare("UPDATE sites SET allowed_domains='[\"a.example\"]' WHERE site_id='siteC003'").run();
  const r = await (await consoleReq(env, 'POST', '/api/sites/bulk', { site_ids: ['siteC003'], action: 'restore' })).json();
  assert.equal(r.updated, 0);
  assert.deepEqual(r.skipped, [{ site_id: 'siteC003', reason: 'domain_conflict', conflict_site_id: 'siteA001' }]);
  assert.equal(db.prepare('SELECT status FROM sites WHERE site_id=?').get('siteC003').status, 'archived');
});

test('PUT labels replaces tags, sets notes, keeps unspecified fields; owner only', async () => {
  const { env, db } = fixture();
  let r = await consoleReq(env, 'PUT', '/api/sites/siteA001/labels', { starred: true, tags: ['AdSense', 'adsense', ' 小游戏 '], notes: 'launch batch' });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.deepEqual(body.tags, ['AdSense', '小游戏']);
  assert.equal(body.starred, true);
  r = await consoleReq(env, 'PUT', '/api/sites/siteA001/labels', { tags: [] });
  assert.equal(r.status, 200);
  assert.deepEqual({ ...labels(db, 'siteA001') }, { starred: 1, tags: '[]', notes: 'launch batch' });
  assert.equal((await consoleReq(env, 'PUT', '/api/sites/siteX009/labels', { starred: true })).status, 403);
  assert.equal((await consoleReq(env, 'PUT', '/api/sites/siteA001/labels', { starred: 'yes' })).status, 400);
  assert.equal((await consoleReq(env, 'PUT', '/api/sites/siteA001/labels', { tags: Array.from({ length: 21 }, (_, i) => 't' + i) })).status, 400);
  assert.equal((await consoleReq(env, 'PUT', '/api/sites/siteA001/labels', { notes: 'x'.repeat(2001) })).status, 400);
});

test('api worker: write tokens may bulk/label, read and site-scoped tokens may not', async () => {
  const { env, db, deleted } = fixture();
  assert.equal((await apiReq(env, 'pvuv_read', 'POST', '/v1/sites/bulk', { site_ids: ['siteA001'], action: 'star' })).status, 403);
  assert.equal((await apiReq(env, 'pvuv_sitew', 'POST', '/v1/sites/bulk', { site_ids: ['siteA001'], action: 'star' })).status, 403);
  assert.equal((await apiReq(env, 'nope', 'POST', '/v1/sites/bulk', { site_ids: ['siteA001'], action: 'star' })).status, 401);
  let r = await apiReq(env, 'pvuv_write', 'POST', '/v1/sites/bulk', { site_ids: ['siteA001', 'siteB002'], action: 'archive' });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).updated, 2);
  assert.equal(deleted.length, 2);
  assert.equal((await apiReq(env, 'pvuv_write', 'POST', '/v1/sites/bulk', { site_ids: ['siteX009'], action: 'archive' })).status, 403);
  r = await apiReq(env, 'pvuv_write', 'PUT', '/v1/sites/siteB002/labels', { tags: ['ops'] });
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(labels(db, 'siteB002').tags), ['ops']);
  assert.equal((await apiReq(env, 'pvuv_read', 'PUT', '/v1/sites/siteB002/labels', { tags: ['ops'] })).status, 403);
  assert.equal((await apiReq(env, 'pvuv_write', 'PUT', '/v1/sites/siteX009/labels', { tags: ['ops'] })).status, 403);
  assert.equal((await apiReq(env, 'pvuv_write', 'GET', '/v1/sites/bulk')).status !== 200, true);
});

test('portfolio thresholds: defaults, partial update, validation', async () => {
  const { env } = fixture();
  let r = await (await consoleReq(env, 'GET', '/api/settings/portfolio')).json();
  assert.deepEqual({ ...r, defaults: undefined }, { growth_uv_7d: 1000, growth_min_delta_pct: -10, decline_pct: 30, ivt_pct: 20, defaults: undefined });
  r = await consoleReq(env, 'PUT', '/api/settings/portfolio', { growth_uv_7d: 500, ivt_pct: 15 });
  assert.equal(r.status, 200);
  r = await (await consoleReq(env, 'GET', '/api/settings/portfolio')).json();
  assert.equal(r.growth_uv_7d, 500); assert.equal(r.ivt_pct, 15); assert.equal(r.decline_pct, 30);
  assert.equal((await consoleReq(env, 'PUT', '/api/settings/portfolio', { ivt_pct: 0 })).status, 400);
  assert.equal((await consoleReq(env, 'PUT', '/api/settings/portfolio', { decline_pct: '30' })).status, 400);
  assert.equal((await consoleReq(env, 'PUT', '/api/settings/portfolio', { bogus: 1 })).status, 400);
  const anon = await consoleWorker.fetch(new Request('https://console.test/api/settings/portfolio'), env);
  assert.equal(anon.status, 401);
});

test('cohortTag is the ISO week of creation in the given timezone', async () => {
  const { cohortTag, normalizeTag } = await import('../.test-labels.mjs');
  assert.equal(cohortTag(Date.UTC(2026, 10, 16, 12), 'UTC'), 'launch:2026-W47');
  assert.equal(cohortTag(Date.UTC(2021, 0, 1, 12), 'UTC'), 'launch:2020-W53');
  assert.equal(cohortTag(Date.UTC(2024, 11, 30, 12), 'UTC'), 'launch:2025-W01');
  // Sunday 20:00 UTC is already Monday in Shanghai → next ISO week
  assert.equal(cohortTag(Date.UTC(2026, 10, 15, 20), 'UTC'), 'launch:2026-W46');
  assert.equal(cohortTag(Date.UTC(2026, 10, 15, 20), 'Asia/Shanghai'), 'launch:2026-W47');
  assert.equal(normalizeTag(' a\n  b '), 'a b');
  assert.equal(normalizeTag('LAUNCH:x'), null);
});
