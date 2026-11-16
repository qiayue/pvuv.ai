// Site provisioning: shared site creation, templates, snippet, idempotent
// funnels and site lifecycle (PATCH / archive). Same in-memory D1 fake as
// integration-api.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import api from '../.test-api.mjs';
import consoleWorker from '../.test-console.mjs';

function fixture(vars = { CONSOLE_HOST: 'stats.example.net', INGEST_HOST: 'in.example.net' }) {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync('shared/schema.sql', 'utf8'));
  db.exec("INSERT INTO users(user_id,created_at,timezone) VALUES ('owner',1,'Asia/Shanghai'),('other',1,'UTC')");
  const hmac = (token) => createHmac('sha256', 'test-key').update('apitoken:' + token).digest('base64url');
  for (const [id, token, permission, owner, site] of [
    ['w', 'pvuv_write', 'write', 'owner', null], ['r', 'pvuv_read', 'read', 'owner', null], ['o', 'pvuv_other', 'write', 'other', null],
  ]) {
    db.prepare('INSERT INTO api_tokens(token_id,owner_id,name,token_hash,prefix,site_id,created_at,permission) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, owner, id, hmac(token), id, site, 1, permission);
  }
  const DB = { prepare(sql) { let args = []; return {
    bind(...x) { args = x; return this; },
    async first() { return db.prepare(sql).get(...args) ?? null; },
    async all() { return { results: db.prepare(sql).all(...args) }; },
    async run() { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
  }; } };
  const cache = new Map(); const deleted = [];
  const env = { DB, HMAC_KEY: 'test-key', ...vars,
    SITE_CONFIG: { put: async (k, v) => cache.set(k, v), delete: async (k) => { deleted.push(k); cache.delete(k); } } };
  return { db, env, cache, deleted };
}
const call = (env, method, token, path, body) => api.fetch(new Request('https://api.test' + path, {
  method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
}), env);
const post = (env, token, path, body) => call(env, 'POST', token, path, body);
const patch = (env, token, path, body) => call(env, 'PATCH', token, path, body);
const get = (env, token, path) => call(env, 'GET', token, path);
function consoleCall(env, method, path, body, user = 'owner') {
  const payload = Buffer.from(JSON.stringify({ u: user, exp: Date.now() + 60000 })).toString('base64url');
  const sig = createHmac('sha256', 'test-key').update('session|' + payload).digest('base64url');
  return consoleWorker.fetch(new Request('https://console.test' + path, {
    method, headers: { cookie: `_pvc_s=${payload}.${sig}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env);
}

test('api normalises domains like the console and stays idempotent across spellings', async () => {
  const { env } = fixture();
  const a = await (await post(env, 'pvuv_write', '/v1/sites', { name: 'Ex', domain: 'https://Example.COM:8443/some/path?q=1' })).json();
  assert.equal(a.created, true);
  assert.deepEqual(a.site.domains, ['example.com']);
  assert.equal(a.site.timezone, 'Asia/Shanghai'); // owner default
  const b = await (await post(env, 'pvuv_write', '/v1/sites', { name: 'Ex', domain: 'example.com.' })).json();
  assert.equal(b.created, false);
  assert.equal(b.site.site_id, a.site.site_id);
  // an extra domain that is already taken also resolves to the same site
  const c = await (await post(env, 'pvuv_write', '/v1/sites', { name: 'Ex', domain: 'www.example.com', domains: ['example.com'] })).json();
  assert.equal(c.site.site_id, a.site.site_id);
  const idn = await (await post(env, 'pvuv_write', '/v1/sites', { name: 'IDN', domain: 'bücher.de' })).json();
  assert.deepEqual(idn.site.domains, ['xn--bcher-kva.de']);
  for (const bad of ['not a domain', '127.0.0.1', 'exa_mple.com', '']) {
    assert.equal((await post(env, 'pvuv_write', '/v1/sites', { name: 'Bad', domain: bad })).status, 400, bad);
  }
  assert.equal((await post(env, 'pvuv_write', '/v1/sites', { name: 'Mixed', domain: 'ok.com', domains: ['bad domain'] })).status, 400);
});

test('console createSite uses the shared normaliser, keeps its response shape and does not dedupe', async () => {
  const { env, db, cache } = fixture();
  const r = await consoleCall(env, 'POST', '/api/sites', { name: 'Blog', domains: ['https://Blog.Example.com/x', 'bad domain'], adguard_mode: 'nope', adclient: 'junk', engaged_seconds: 9999 });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.deepEqual(Object.keys(d).sort(), ['adclient', 'adguard_mode', 'domains', 'name', 'shadow_until', 'site_id', 'timezone']);
  assert.deepEqual(d.domains, ['blog.example.com']);
  assert.equal(d.adguard_mode, 'off'); // lenient, as before
  assert.equal(d.adclient, null);
  assert.equal(db.prepare('SELECT engaged_seconds FROM sites WHERE site_id=?').get(d.site_id).engaged_seconds, 300);
  const kv = JSON.parse(cache.get('site:' + d.site_id));
  assert.deepEqual(Object.keys(kv).sort(), ['adclient', 'adguard_mode', 'allowed_domains', 'shadow_until', 'site_id', 'status']);
  await consoleCall(env, 'POST', '/api/sites', { name: 'Blog 2', domains: ['blog.example.com'] });
  assert.equal(db.prepare("SELECT count(*) n FROM sites WHERE owner_id='owner'").get().n, 2);
  assert.equal((await consoleCall(env, 'POST', '/api/sites', { name: 'X', domains: ['blog.example.com'], timezone: 'Mars/Base' })).status, 400);
});

test('POST /v1/sites returns the embed snippet in the console format', async () => {
  const { env } = fixture();
  const d = await (await post(env, 'pvuv_write', '/v1/sites', { name: 'Ads', domain: 'ads.example.com', adguard_mode: 'balanced', adclient: 'ca-pub-1234567890' })).json();
  assert.equal(d.snippet, `<script defer src="https://stats.example.net/f.js"\n        data-site="${d.site.site_id}"\n        data-api="https://in.example.net"\n        data-adguard="balanced"\n        data-adclient="ca-pub-1234567890"></script>`);
  const plain = await (await post(env, 'pvuv_write', '/v1/sites', { name: 'Plain', domain: 'plain.example.com' })).json();
  assert.ok(!plain.snippet.includes('data-adguard'));
  const { env: bare } = fixture({});
  assert.equal((await (await post(bare, 'pvuv_write', '/v1/sites', { name: 'X', domain: 'x.example.com' })).json()).snippet, null);
});

test('explicit settings are validated strictly like the console rules', async () => {
  const { env } = fixture();
  const bad = [{ timezone: 'Mars/Base' }, { adclient: 'pub-123' }, { adguard_mode: 'paranoid' }, { engaged_seconds: 'soon' }];
  for (const o of bad) assert.equal((await post(env, 'pvuv_write', '/v1/sites', { name: 'S', domain: 's.example.com', ...o })).status, 400, JSON.stringify(o));
  const d = await (await post(env, 'pvuv_write', '/v1/sites', { name: 'S', domain: 's.example.com', timezone: 'Europe/Berlin', engaged_seconds: 0 })).json();
  assert.equal(d.site.timezone, 'Europe/Berlin');
  assert.equal(d.site.engaged_seconds, 1);
});

test('templates: console CRUD, API listing, apply with overrides, idempotent default funnels', async () => {
  const { env, db } = fixture();
  const funnels = [{ name: 'Play', steps: [{ type: 'page', value: '/' }, { type: 'event', value: 'play_start' }] },
    { name: 'Ads', steps: [{ type: 'page', value: '/' }, { type: 'event', value: 'ad_click' }] }];
  const r = await consoleCall(env, 'POST', '/api/templates', { name: 'Game site', timezone: 'America/New_York', engaged_seconds: 20, adguard_mode: 'balanced', adclient: 'ca-pub-9999999999', funnels });
  assert.equal(r.status, 200);
  const tpl = await r.json();
  assert.ok(tpl.template_id);
  // validation + uniqueness
  assert.equal((await consoleCall(env, 'POST', '/api/templates', { name: 'game SITE' })).status, 409);
  assert.equal((await consoleCall(env, 'POST', '/api/templates', { name: 'T2', timezone: 'Nope/Zone' })).status, 400);
  assert.equal((await consoleCall(env, 'POST', '/api/templates', { name: 'T2', adclient: 'x' })).status, 400);
  assert.equal((await consoleCall(env, 'POST', '/api/templates', { name: 'T2', funnels: [{ name: 'one', steps: [{ type: 'page', value: '/' }] }] })).status, 400);
  // update in place keeps the id
  const upd = await consoleCall(env, 'POST', `/api/templates/${tpl.template_id}`, { name: 'Game site', timezone: 'America/New_York', engaged_seconds: 20, adguard_mode: 'balanced', adclient: 'ca-pub-9999999999', funnels });
  assert.equal(upd.status, 200);
  assert.equal(db.prepare('SELECT count(*) n FROM site_templates').get().n, 1);
  // any of the owner's tokens may list; another owner sees nothing
  const listed = await (await get(env, 'pvuv_read', '/v1/templates')).json();
  assert.equal(listed.templates.length, 1);
  assert.equal(listed.templates[0].funnels.length, 2);
  assert.equal((await (await get(env, 'pvuv_other', '/v1/templates')).json()).templates.length, 0);
  assert.equal((await get(env, null, '/v1/templates')).status, 401);

  const body = { name: 'Snake', domain: 'snake.example.com', template: 'game site', adguard_mode: 'strict' };
  const a = await (await post(env, 'pvuv_write', '/v1/sites', body)).json();
  assert.equal(a.created, true);
  assert.equal(a.template, tpl.template_id);
  assert.equal(a.site.timezone, 'America/New_York');
  assert.equal(a.site.engaged_seconds, 20);
  assert.equal(a.site.adclient, 'ca-pub-9999999999');
  assert.equal(a.site.adguard_mode, 'strict'); // explicit override beats the template
  assert.deepEqual(a.funnels.map((f) => [f.name, f.created]), [['Play', true], ['Ads', true]]);
  const b = await (await post(env, 'pvuv_write', '/v1/sites', { ...body, template: tpl.template_id })).json();
  assert.equal(b.created, false);
  assert.deepEqual(b.funnels.map((f) => f.created), [false, false]);
  assert.equal(db.prepare('SELECT count(*) n FROM funnels WHERE site_id=?').get(a.site.site_id).n, 2);
  // adclient: null clears the template's client
  const c = await (await post(env, 'pvuv_write', '/v1/sites', { name: 'NoAds', domain: 'noads.example.com', template: 'Game site', adclient: null })).json();
  assert.equal(c.site.adclient, null);
  assert.equal((await post(env, 'pvuv_write', '/v1/sites', { name: 'X', domain: 'x.example.com', template: 'missing' })).status, 400);
  // another owner can't use it by id
  assert.equal((await post(env, 'pvuv_other', '/v1/sites', { name: 'X', domain: 'x.example.com', template: tpl.template_id })).status, 400);

  assert.equal((await consoleCall(env, 'DELETE', `/api/templates/${tpl.template_id}`)).status, 200);
  assert.equal((await (await consoleCall(env, 'GET', '/api/templates')).json()).templates.length, 0);
});

test('funnels are find-or-create by name, update differing steps and cap step length', async () => {
  const { env, db } = fixture();
  const id = (await (await post(env, 'pvuv_write', '/v1/sites', { name: 'F', domain: 'f.example.com' })).json()).site.site_id;
  const steps = [{ type: 'page', value: '/' }, { type: 'event', value: 'play_start' }];
  const a = await (await post(env, 'pvuv_write', `/v1/sites/${id}/funnels`, { name: 'Game', steps })).json();
  assert.equal(a.created, true);
  const b = await (await post(env, 'pvuv_write', `/v1/sites/${id}/funnels`, { name: 'Game', steps })).json();
  assert.deepEqual([b.funnel_id, b.created, b.updated], [a.funnel_id, false, false]);
  const changed = [...steps, { type: 'event', value: 'level_2' }];
  const c = await (await post(env, 'pvuv_write', `/v1/sites/${id}/funnels`, { name: 'Game', steps: changed })).json();
  assert.deepEqual([c.funnel_id, c.created, c.updated], [a.funnel_id, false, true]);
  assert.equal(JSON.parse(db.prepare('SELECT steps FROM funnels WHERE funnel_id=?').get(a.funnel_id).steps).length, 3);
  assert.equal(db.prepare('SELECT count(*) n FROM funnels WHERE site_id=?').get(id).n, 1);
  const long = 'x'.repeat(513);
  assert.equal((await post(env, 'pvuv_write', `/v1/sites/${id}/funnels`, { name: 'Long', steps: [{ type: 'page', value: '/' }, { type: 'page', value: long }] })).status, 400);
  assert.equal((await post(env, 'pvuv_write', `/v1/sites/${id}/funnels`, { name: 'Empty', steps: [{ type: 'page', value: '/' }, { type: 'event', value: '  ' }] })).status, 400);
  // the console's own save path enforces the same cap
  assert.equal((await consoleCall(env, 'POST', `/api/sites/${id}/funnels`, { name: 'Long', steps: [{ type: 'page', value: '/' }, { type: 'page', value: long }] })).status, 400);
  const rs = await Promise.all(Array.from({ length: 4 }, () => post(env, 'pvuv_write', `/v1/sites/${id}/funnels`, { name: 'Race', steps })));
  assert.equal(new Set(await Promise.all(rs.map(async (r) => (await r.json()).funnel_id))).size, 1);
});

test('PATCH renames, moves domains, archives and restores with KV invalidation', async () => {
  const { env, db, deleted } = fixture();
  const site = (await (await post(env, 'pvuv_write', '/v1/sites', { name: 'Beta', domain: 'beta.test-host.com' })).json()).site;
  const r = await patch(env, 'pvuv_write', `/v1/sites/${site.site_id}`, { name: 'Prod', add_domains: ['https://www.prod.com/', 'prod.com'], remove_domains: ['beta.test-host.com'] });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.changed, true);
  assert.equal(d.site.name, 'Prod');
  assert.deepEqual(d.site.domains, ['www.prod.com', 'prod.com']);
  assert.deepEqual(JSON.parse(db.prepare('SELECT allowed_domains FROM sites WHERE site_id=?').get(site.site_id).allowed_domains), ['www.prod.com', 'prod.com']);
  assert.deepEqual(deleted, ['site:' + site.site_id]);
  // no-op patch does not touch KV
  assert.equal((await (await patch(env, 'pvuv_write', `/v1/sites/${site.site_id}`, { name: 'Prod' })).json()).changed, false);
  assert.equal(deleted.length, 1);
  // replace the list outright
  assert.deepEqual((await (await patch(env, 'pvuv_write', `/v1/sites/${site.site_id}`, { domains: ['prod.com'] })).json()).site.domains, ['prod.com']);
  for (const bad of [{ domains: [] }, { remove_domains: ['prod.com'] }, { domains: ['bad domain'] }, { status: 'deleted' }, { name: '' }, { add_domains: 'x.com' }]) {
    assert.equal((await patch(env, 'pvuv_write', `/v1/sites/${site.site_id}`, bad)).status, 400, JSON.stringify(bad));
  }
  // a domain can only belong to one active site of the owner
  const other = (await (await post(env, 'pvuv_write', '/v1/sites', { name: 'Other', domain: 'other.com' })).json()).site;
  assert.equal((await patch(env, 'pvuv_write', `/v1/sites/${other.site_id}`, { add_domains: ['prod.com'] })).status, 409);
  // ownership + permission
  assert.equal((await patch(env, 'pvuv_other', `/v1/sites/${site.site_id}`, { name: 'Mine' })).status, 403);
  assert.equal((await patch(env, 'pvuv_read', `/v1/sites/${site.site_id}`, { name: 'Mine' })).status, 403);

  // archive: drops out of the listing, stops ingest (status != active)
  const arch = await (await patch(env, 'pvuv_write', `/v1/sites/${site.site_id}`, { status: 'archived' })).json();
  assert.equal(arch.site.status, 'archived');
  assert.equal(db.prepare('SELECT status FROM sites WHERE site_id=?').get(site.site_id).status, 'archived');
  const listed = (await (await get(env, 'pvuv_read', '/v1/sites')).json()).sites.map((s) => s.site_id);
  assert.ok(!listed.includes(site.site_id));
  // the domain is free again → a new site; restoring the archived one now clashes
  const again = await (await post(env, 'pvuv_write', '/v1/sites', { name: 'Prod v2', domain: 'prod.com' })).json();
  assert.equal(again.created, true);
  assert.equal((await patch(env, 'pvuv_write', `/v1/sites/${site.site_id}`, { status: 'active' })).status, 409);
  await patch(env, 'pvuv_write', `/v1/sites/${again.site.site_id}`, { status: 'archived' });
  assert.equal((await (await patch(env, 'pvuv_write', `/v1/sites/${site.site_id}`, { status: 'active' })).json()).site.status, 'active');
});

test('write routing: unknown paths 404 before auth, wrong methods 405', async () => {
  const { env } = fixture();
  assert.equal((await post(env, null, '/v1/nope', {})).status, 404);
  assert.equal((await call(env, 'DELETE', null, '/v1/sites/abcd/overview')).status, 404);
  assert.equal((await call(env, 'DELETE', 'pvuv_write', '/v1/sites')).status, 405);
  assert.equal((await patch(env, 'pvuv_write', '/v1/sites/abcd/funnels', {})).status, 405);
  assert.equal((await post(env, 'pvuv_write', '/v1/sites/abcd', {})).status, 405);
  assert.equal((await post(env, null, '/v1/sites', {})).status, 401);
  assert.equal((await patch(env, null, '/v1/sites/abcd', {})).status, 401);
  assert.equal((await patch(env, 'pvuv_write', '/v1/sites/abcd', {})).status, 403); // not this owner's (no such) site
});

test('migration 0023 applies cleanly and matches the canonical schema', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync('migrations/0023_site_templates.sql', 'utf8'));
  db.exec(readFileSync('migrations/0023_site_templates.sql', 'utf8')); // idempotent
  const cols = (d) => d.prepare("SELECT name FROM pragma_table_info('site_templates') ORDER BY cid").all().map((r) => r.name);
  const canonical = new DatabaseSync(':memory:');
  canonical.exec(readFileSync('shared/schema.sql', 'utf8'));
  assert.deepEqual(cols(db), cols(canonical));
  db.exec("INSERT INTO site_templates(template_id,owner_id,name,created_at,updated_at) VALUES ('a','o','Game',1,1)");
  assert.throws(() => db.exec("INSERT INTO site_templates(template_id,owner_id,name,created_at,updated_at) VALUES ('b','o','GAME',1,1)"));
});
