// External integrations (migration 0028): credential encryption, OAuth state,
// domain mapping, sync idempotency against recorded API fixtures, loadExternal
// shape + attention rules, endpoint auth/scoping. No live credentials needed:
// every outbound call goes through an injected fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import api from '../.test-api.mjs';
import consoleWorker from '../.test-console.mjs';
import {
  runExternalSync, checkAdsTxt, encryptSecret, decryptSecret, normalizeHost, matchSite, buildDomainIndex, gscPreference,
  saveCredential, loadCredential, setMapping, googleAuthUrl, loadExternal, siteExternal, previousWindow,
  integrationsApi, signExtState, verifyExtState, EXT_STATE_COOKIE,
} from '../.test-cron.mjs';

const NOW = Date.UTC(2026, 10, 16, 12, 0, 0); // 2026-11-16 12:00 UTC
const DAY = 86400e3;
const ymd = (t) => new Date(t).toISOString().slice(0, 10);
const TODAY = ymd(NOW);

// ---------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync('shared/schema.sql', 'utf8'));
  db.exec("INSERT INTO users(user_id,created_at) VALUES ('admin',1),('other',1)");
  const site = db.prepare('INSERT INTO sites(site_id,name,owner_id,allowed_domains,adclient,timezone,created_at) VALUES (?,?,?,?,?,?,?)');
  site.run('siteA001', 'Alpha', 'admin', '["alpha.example","www.alpha.example"]', 'ca-pub-111', 'UTC', 1);
  site.run('siteB001', 'Beta', 'admin', '["beta.example"]', null, 'UTC', 1);
  site.run('siteC001', 'Gamma', 'admin', '["play.gamma.example"]', null, 'UTC', 1);
  site.run('siteD001', 'Delta', 'admin', '["delta.example"]', null, 'UTC', 1);
  site.run('siteO001', 'Other', 'other', '["other.example"]', null, 'UTC', 1);
  const hmac = (token) => createHmac('sha256', 'test-key').update('apitoken:' + token).digest('base64url');
  for (const [id, token, owner, s] of [['r', 'pvuv_read', 'admin', null], ['s', 'pvuv_scoped', 'admin', 'siteA001'], ['o', 'pvuv_other', 'other', null]]) {
    db.prepare('INSERT INTO api_tokens(token_id,owner_id,name,token_hash,prefix,site_id,created_at,permission) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, owner, id, hmac(token), id, s, 1, 'read');
  }
  // 7 days of traffic: Alpha and Beta busy, Delta quiet
  const roll = db.prepare('INSERT INTO rollup_site_daily(site_id,day,pv,uv,clean_count) VALUES (?,?,?,?,?)');
  for (let i = 0; i < 7; i++) {
    const d = ymd(NOW - i * DAY);
    roll.run('siteA001', d, 1000, 400, 900);
    roll.run('siteB001', d, 500, 200, 450);
    roll.run('siteD001', d, 10, 5, 10);
  }
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
  const env = {
    DB, HMAC_KEY: 'test-key', API_TOKEN: '', SITE_CONFIG: { put: async () => {}, delete: async () => {} },
    GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'csecret', ADMIN_EMAILS: 'a@example.com',
  };
  return { db, env };
}

const sessionCookie = (user) => {
  const payload = Buffer.from(JSON.stringify({ u: user, exp: Date.now() + 60000 })).toString('base64url');
  return `_pvc_s=${payload}.${createHmac('sha256', 'test-key').update('session|' + payload).digest('base64url')}`;
};

// ---------------------------------------------------------------------------
// recorded API fixtures (shapes from the official API references)
// ---------------------------------------------------------------------------

function mockFetch(overrides = {}) {
  const calls = [];
  const res = (body, status = 200, headers = { 'content-type': 'application/json' }) =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
  const days = (n) => Array.from({ length: n }, (_, i) => ymd(NOW - (n - 1 - i) * DAY));
  const fn = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, method: init.method ?? 'GET', body: init.body ?? null, headers: init.headers ?? {} });
    for (const [pat, h] of Object.entries(overrides)) if (url.includes(pat)) return h(url, init, res);
    if (url === 'https://oauth2.googleapis.com/token') {
      const p = new URLSearchParams(init.body);
      if (p.get('grant_type') === 'authorization_code') return res({ access_token: 'at-1', refresh_token: 'rt-secret', scope: 'openid email https://www.googleapis.com/auth/adsense.readonly https://www.googleapis.com/auth/webmasters.readonly', expires_in: 3599 });
      return res({ access_token: 'at-2', expires_in: 3599 });
    }
    if (url.startsWith('https://openidconnect.googleapis.com/v1/userinfo')) return res({ email: 'owner@example.com', email_verified: true });
    if (url.startsWith('https://oauth2.googleapis.com/revoke')) return res({});
    if (url.startsWith('https://adsense.googleapis.com/v2/accounts?')) return res({ accounts: [{ name: 'accounts/pub-111', displayName: 'Pub' }] });
    if (url.includes('/v2/accounts/pub-111/sites')) {
      return res({ sites: [
        { name: 'accounts/pub-111/sites/1', domain: 'alpha.example', state: 'READY', autoAdsEnabled: true, reportingDimensionId: '1' },
        { name: 'accounts/pub-111/sites/2', domain: 'beta.example', state: 'NEEDS_ATTENTION', reportingDimensionId: '2' },
        { name: 'accounts/pub-111/sites/3', domain: 'unknown.example', state: 'GETTING_READY', reportingDimensionId: '3' },
      ] });
    }
    if (url.includes('/policyIssues')) return res({ policyIssues: [{ site: 'delta.example', entityType: 'SITE', action: 'AD_SERVING_DISABLED', policyTopics: [{ topic: 'VALUABLE_INVENTORY' }] }] });
    if (url.includes('/alerts')) return res({ alerts: [{ severity: 'WARNING', type: 'ads-txt', message: '<b>Earnings at risk</b>' }] });
    if (url.includes('reports:generate')) {
      const u = new URL(url);
      const start = `${u.searchParams.get('startDate.year')}-${String(u.searchParams.get('startDate.month')).padStart(2, '0')}-${String(u.searchParams.get('startDate.day')).padStart(2, '0')}`;
      const usd = u.searchParams.get('currencyCode') === 'USD';
      const ds = days(28).filter((d) => d >= start);
      return res({
        headers: [
          { name: 'DATE', type: 'DIMENSION' }, { name: 'DOMAIN_NAME', type: 'DIMENSION' },
          { name: 'ESTIMATED_EARNINGS', type: 'METRIC_CURRENCY', currencyCode: usd ? 'USD' : 'EUR' },
          { name: 'IMPRESSIONS', type: 'METRIC_TALLY' }, { name: 'CLICKS', type: 'METRIC_TALLY' }, { name: 'PAGE_VIEWS', type: 'METRIC_TALLY' },
        ],
        rows: ds.flatMap((d) => [
          { cells: [{ value: d }, { value: 'alpha.example' }, { value: usd ? '2.50' : '2.30' }, { value: '1000' }, { value: '5' }, { value: '800' }] },
          { cells: [{ value: d }, { value: 'www.alpha.example' }, { value: usd ? '0.50' : '0.46' }, { value: '100' }, { value: '1' }, { value: '90' }] },
        ]),
      });
    }
    if (url.startsWith('https://www.googleapis.com/webmasters/v3/sites') && !url.includes('searchAnalytics')) {
      return res({ siteEntry: [
        { siteUrl: 'sc-domain:alpha.example', permissionLevel: 'siteOwner' },
        { siteUrl: 'https://www.alpha.example/', permissionLevel: 'siteOwner' },
        { siteUrl: 'sc-domain:gamma.example', permissionLevel: 'siteFullUser' },
        { siteUrl: 'https://nope.example/', permissionLevel: 'siteUnverifiedUser' },
      ] });
    }
    if (url.includes('searchAnalytics/query')) {
      const b = JSON.parse(init.body);
      if (b.dimensions[0] === 'page') return res({ rows: [{ keys: ['https://alpha.example/'], clicks: 3, impressions: 40 }, { keys: ['https://alpha.example/a'], clicks: 1, impressions: 9 }] });
      return res({ rows: days(28).filter((d) => d >= b.startDate).map((d) => ({ keys: [d], clicks: 4, impressions: 100, ctr: 0.04, position: 7.5 })) });
    }
    if (url.includes('urlInspection/index:inspect')) return res({ inspectionResult: { indexStatusResult: { verdict: 'PASS', coverageState: 'Submitted and indexed', lastCrawlTime: '2026-11-14T01:02:03Z' } } });
    if (url.startsWith('https://api3.adsterratools.com/publisher/domains.json')) return res({ items: [{ id: 42, title: 'beta.example' }, { id: 43, title: 'zzz.example' }], itemCount: 2 });
    if (url.startsWith('https://api3.adsterratools.com/publisher/stats.json')) {
      const u = new URL(url);
      return res({ items: days(28).filter((d) => d >= u.searchParams.get('start_date')).map((d) => ({ date: d, domain: 42, impression: 300, clicks: 2, ctr: 0.66, cpm: 1, revenue: 0.3 })) });
    }
    if (url === 'https://alpha.example/ads.txt') return res('# ads\ngoogle.com, pub-111, DIRECT, f08c47fec0942fa0\n', 200, { 'content-type': 'text/plain' });
    if (url === 'https://beta.example/ads.txt') return res('google.com, pub-999, DIRECT, f08c47fec0942fa0\n', 200, { 'content-type': 'text/plain' });
    if (url.endsWith('/ads.txt')) return res('<html>not found</html>', 200, { 'content-type': 'text/html' });
    return res({ error: { message: 'unexpected ' + url } }, 500);
  };
  return { fn, calls };
}

async function connectAll(env) {
  await saveCredential(env, 'google', 'admin', { refresh_token: 'rt-secret' }, 'owner@example.com', 'scopes', NOW);
  await saveCredential(env, 'adsterra', 'admin', { token: 'adst-token-xyz' }, 'adst…yz', null, NOW);
}

const snapshot = (db) => ({
  props: db.prepare('SELECT source, property_id, site_id, mapping, state, ads_txt, indexed_pages FROM ext_properties ORDER BY source, property_id').all(),
  daily: db.prepare('SELECT * FROM ext_daily ORDER BY source, property_id, day').all().map(({ updated_at, ...r }) => r),
});

// ---------------------------------------------------------------------------
// unit-level
// ---------------------------------------------------------------------------

test('credential encryption: round trip, provider binding, key binding, no plaintext at rest', async () => {
  const blob = await encryptSecret('k1', 'google', { refresh_token: 'rt-secret' });
  assert.match(blob, /^v1\.[\w-]+\.[\w-]+$/);
  assert.ok(!blob.includes('rt-secret'));
  assert.deepEqual(await decryptSecret('k1', 'google', blob), { refresh_token: 'rt-secret' });
  await assert.rejects(decryptSecret('k1', 'adsterra', blob));          // wrong provider (AAD)
  await assert.rejects(decryptSecret('k2', 'google', blob));            // rotated key
  await assert.rejects(decryptSecret('k1', 'google', blob.slice(0, -2) + 'AA')); // tampered
  assert.notEqual(await encryptSecret('k1', 'google', { a: 1 }), await encryptSecret('k1', 'google', { a: 1 })); // random IV

  const { db, env } = fixture();
  await saveCredential(env, 'google', 'admin', { refresh_token: 'rt-secret' }, 'x@example.com', null, NOW);
  const row = db.prepare('SELECT * FROM ext_credentials').get();
  assert.ok(!JSON.stringify(row).includes('rt-secret'));
  assert.deepEqual(await loadCredential(env, 'google'), { refresh_token: 'rt-secret' });
  await assert.rejects(loadCredential({ ...env, HMAC_KEY: 'changed' }, 'google'), /reconnect/);
});

test('domain mapping: www/apex, sc-domain properties, ambiguity, preference', () => {
  assert.equal(normalizeHost('https://WWW.Example.com:443/path?q'), 'example.com');
  assert.equal(normalizeHost('sc-domain:example.com'), 'example.com');
  assert.equal(normalizeHost('example.com.'), 'example.com');
  const idx = buildDomainIndex([
    { site_id: 'A', domains: ['alpha.example', 'www.alpha.example'] },
    { site_id: 'C', domains: ['play.gamma.example'] },
    { site_id: 'M1', domains: ['a.multi.example'] },
    { site_id: 'M2', domains: ['b.multi.example'] },
  ]);
  assert.equal(matchSite(idx, 'www.alpha.example'), 'A');
  assert.equal(matchSite(idx, 'https://alpha.example/'), 'A');
  assert.equal(matchSite(idx, 'gamma.example'), null);           // URL-prefix does not cover subdomains
  assert.equal(matchSite(idx, 'gamma.example', true), 'C');      // sc-domain: does, single owner
  assert.equal(matchSite(idx, 'multi.example', true), null);     // two owners → ambiguous
  assert.equal(matchSite(idx, 'nothing.example', true), null);
  const order = ['http://www.x.example/', 'https://x.example/', 'sc-domain:x.example', 'https://www.x.example/', 'http://x.example/']
    .sort((a, b) => gscPreference(a) - gscPreference(b));
  assert.deepEqual(order, ['sc-domain:x.example', 'https://x.example/', 'https://www.x.example/', 'http://x.example/', 'http://www.x.example/']);
});

test('ads.txt evaluation', () => {
  assert.equal(checkAdsTxt('google.com, pub-111, DIRECT, f08c47fec0942fa0', ['pub-111']), 'ok');
  assert.equal(checkAdsTxt('Google.com,PUB-111,direct', ['pub-111']), 'ok');
  assert.equal(checkAdsTxt('google.com, pub-111, RESELLER', ['pub-111']), 'mismatch');
  assert.equal(checkAdsTxt('google.com, pub-222, DIRECT', ['pub-111']), 'mismatch');
  assert.equal(checkAdsTxt('# google.com, pub-111, DIRECT\nadsterra.com, 1, DIRECT', ['pub-111']), 'missing');
  assert.equal(checkAdsTxt('contact=x@example.com\n', ['pub-111']), 'missing');
});

test('OAuth state: signed, user-bound, cookie-bound, expiring', async () => {
  const s = await signExtState('test-key', 'admin', NOW);
  assert.equal(await verifyExtState('test-key', s, s, 'admin', NOW + 1000), true);
  assert.equal(await verifyExtState('test-key', s, undefined, 'admin', NOW), false);           // no cookie (CSRF)
  assert.equal(await verifyExtState('test-key', s, s + 'x', 'admin', NOW), false);             // cookie mismatch
  assert.equal(await verifyExtState('test-key', s, s, 'other', NOW), false);                   // other user
  assert.equal(await verifyExtState('test-key', s, s, 'admin', NOW + 11 * 60e3), false);       // expired
  assert.equal(await verifyExtState('other-key', s, s, 'admin', NOW), false);                  // forged
  const u = new URL(googleAuthUrl({ clientId: 'cid', clientSecret: 'x' }, 'https://c.example/cb', s));
  assert.equal(u.searchParams.get('access_type'), 'offline');
  assert.equal(u.searchParams.get('prompt'), 'consent');
  assert.match(u.searchParams.get('scope'), /adsense\.readonly/);
  assert.match(u.searchParams.get('scope'), /webmasters\.readonly/);
  assert.ok(!u.toString().includes('x&'), 'client secret never in the URL');
});

// ---------------------------------------------------------------------------
// sync
// ---------------------------------------------------------------------------

test('sync: nothing connected is a no-op; no outbound calls except ads.txt of monetized sites', async () => {
  const { db, env } = fixture();
  const { fn, calls } = mockFetch();
  const out = await runExternalSync(env, { mode: 'daily', now: NOW, fetchFn: fn });
  assert.equal(out.adsense.skipped, 'not connected');
  assert.equal(out.adsterra.skipped, 'not connected');
  assert.equal(out.gsc.skipped, 'not connected');
  // site A has an ad client → its ads.txt is checked without any credential
  assert.deepEqual(calls.map((c) => c.url), ['https://alpha.example/ads.txt']);
  assert.equal(db.prepare("SELECT ads_txt FROM ext_properties WHERE source='ads_txt'").get().ads_txt, 'ok');
});

test('sync: full daily pass maps properties, writes revenue/search, and is idempotent', async () => {
  const { db, env } = fixture();
  await connectAll(env);
  const { fn, calls } = mockFetch();
  const out = await runExternalSync(env, { mode: 'daily', now: NOW, fetchFn: fn });
  for (const s of ['adsense', 'adsterra', 'gsc', 'ads_txt']) assert.equal(out[s].ok, true, `${s}: ${out[s].error}`);
  const snap = snapshot(db);

  const p = (src, id) => snap.props.find((x) => x.source === src && x.property_id === id);
  assert.equal(p('adsense', 'alpha.example').site_id, 'siteA001');
  assert.equal(p('adsense', 'alpha.example').state, 'ready');
  assert.equal(p('adsense', 'beta.example').state, 'needs_attention');
  assert.equal(p('adsense', 'unknown.example').site_id, null);
  assert.equal(p('adsterra', '42').site_id, 'siteB001');
  assert.equal(p('adsterra', '43').site_id, null);
  assert.equal(p('gsc', 'sc-domain:alpha.example').site_id, 'siteA001');
  assert.equal(p('gsc', 'sc-domain:alpha.example').indexed_pages, 2);
  assert.equal(p('gsc', 'https://www.alpha.example/').state, 'duplicate'); // overlapping property not double counted
  assert.equal(p('gsc', 'sc-domain:gamma.example').site_id, 'siteC001');   // subdomain site via Domain property
  assert.equal(p('gsc', 'https://nope.example/'), undefined);              // unverified ignored
  assert.equal(p('ads_txt', 'alpha.example').ads_txt, 'ok');
  assert.equal(p('ads_txt', 'beta.example').ads_txt, 'mismatch');          // in AdSense, wrong pub id

  // first run backfills 28 days; www + apex report rows fold into one property
  const a = snap.daily.filter((r) => r.source === 'adsense' && r.site_id === 'siteA001');
  assert.equal(a.length, 28);
  const day = a.find((r) => r.property_id === 'alpha.example' && r.day === TODAY);
  assert.equal(day.revenue_usd, 3);
  assert.equal(Math.round(day.revenue * 100), 276);
  assert.equal(day.pageviews, 890);
  assert.equal(day.currency, 'EUR');
  assert.equal(snap.daily.filter((r) => r.source === 'gsc' && r.property_id === 'https://www.alpha.example/').length, 0);
  assert.equal(snap.daily.filter((r) => r.source === 'adsterra').length, 28);

  // credentials never travel anywhere but their own provider
  for (const c of calls) {
    const blob = JSON.stringify(c);
    if (blob.includes('rt-secret')) assert.equal(c.url, 'https://oauth2.googleapis.com/token');
    if (blob.includes('adst-token-xyz')) assert.ok(c.url.startsWith('https://api3.adsterratools.com/'));
  }

  // re-run: same data (manual mode forces every property again)
  await runExternalSync(env, { mode: 'manual', now: NOW + 60e3, fetchFn: fn });
  const again = snapshot(db);
  assert.deepEqual(again.daily, snap.daily);
  assert.deepEqual(again.props, snap.props);

  // hourly pass only refreshes the last two days and skips fresh properties
  const h = mockFetch();
  await runExternalSync(env, { mode: 'hourly', now: NOW + 3600e3, fetchFn: h.fn });
  assert.ok(!h.calls.some((c) => c.url.includes('searchAnalytics')), 'fresh GSC properties are not re-queried');
  assert.ok(!h.calls.some((c) => c.url.endsWith('/ads.txt')));
  const rep = h.calls.find((c) => c.url.includes('reports:generate'));
  assert.equal(new URL(rep.url).searchParams.get('startDate.day'), '15');
  assert.deepEqual(snapshot(db).daily, snap.daily);
});

test('sync: manual mapping survives re-sync and moves daily rows; ignored detaches', async () => {
  const { db, env } = fixture();
  await connectAll(env);
  const { fn } = mockFetch();
  await runExternalSync(env, { mode: 'daily', now: NOW, fetchFn: fn });
  assert.ok(await setMapping(env.DB, 'adsterra', '43', 'manual', 'siteD001'));
  await runExternalSync(env, { mode: 'manual', now: NOW + 1000, fetchFn: fn, sources: ['adsterra'] });
  assert.equal(db.prepare("SELECT site_id FROM ext_properties WHERE source='adsterra' AND property_id='43'").get().site_id, 'siteD001');
  assert.ok(await setMapping(env.DB, 'adsterra', '42', 'ignored', null));
  await runExternalSync(env, { mode: 'manual', now: NOW + 2000, fetchFn: fn, sources: ['adsterra'] });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM ext_daily WHERE source='adsterra' AND site_id IS NOT NULL").get().n, 0);
  assert.equal(db.prepare("SELECT site_id FROM ext_properties WHERE source='adsterra' AND property_id='42'").get().site_id, null);
});

test('sync: quota errors back off; one failing source or property never stops the others', async () => {
  const { db, env } = fixture();
  await connectAll(env);
  const { fn } = mockFetch({
    'reports:generate': (u, i, res) => res({ error: { code: 429, message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' } }, 429),
    'sc-domain%3Agamma.example/searchAnalytics': (u, i, res) => res({ error: { code: 403, message: 'User does not have sufficient permission' } }, 403),
  });
  const out = await runExternalSync(env, { mode: 'daily', now: NOW, fetchFn: fn });
  assert.equal(out.adsense.ok, false);
  assert.match(out.adsense.error, /Quota/);
  assert.equal(out.adsterra.ok, true);
  assert.equal(out.gsc.ok, true);
  const gamma = db.prepare("SELECT error, checked_at FROM ext_properties WHERE property_id='sc-domain:gamma.example'").get();
  assert.match(gamma.error, /permission/);
  assert.equal(gamma.checked_at, null);
  const st = db.prepare("SELECT * FROM ext_sync_status WHERE source='adsense'").get();
  assert.equal(st.error_count, 1);
  assert.equal(st.backoff_until, NOW + 3600e3);
  // within backoff: skipped without calls; manual "sync now" ignores it
  const later = mockFetch();
  const out2 = await runExternalSync(env, { mode: 'hourly', now: NOW + 600e3, fetchFn: later.fn, sources: ['adsense'] });
  assert.equal(out2.adsense.skipped, 'backoff');
  assert.equal(later.calls.length, 0);
  const out3 = await runExternalSync(env, { mode: 'manual', now: NOW + 700e3, fetchFn: later.fn, sources: ['adsense'] });
  assert.equal(out3.adsense.ok, true);
  assert.equal(db.prepare("SELECT error_count, backoff_until FROM ext_sync_status WHERE source='adsense'").get().backoff_until, null);
});

test('sync: revoked Google grant is recorded on both Google sources, Adsterra unaffected', async () => {
  const { db, env } = fixture();
  await connectAll(env);
  const { fn } = mockFetch({ 'oauth2.googleapis.com/token': (u, i, res) => res({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400) });
  const out = await runExternalSync(env, { mode: 'daily', now: NOW, fetchFn: fn });
  assert.match(out.adsense.error, /revoked/);
  assert.match(out.gsc.error, /revoked/);
  assert.equal(out.adsterra.ok, true);
  assert.equal(db.prepare("SELECT backoff_until FROM ext_sync_status WHERE source='gsc'").get().backoff_until, null);
});

test('sync: tables missing → quiet no-op', async () => {
  const { db, env } = fixture();
  db.exec('DROP TABLE ext_sync_status');
  const out = await runExternalSync(env, { mode: 'daily', now: NOW, fetchFn: mockFetch().fn });
  assert.equal(out.adsense.skipped, 'not installed');
  assert.deepEqual(await loadExternal(env.DB, ['siteA001'], { start: TODAY, end: TODAY }, NOW), {});
});

// ---------------------------------------------------------------------------
// loadExternal
// ---------------------------------------------------------------------------

const PERIOD = { start: ymd(NOW - 6 * DAY), end: TODAY };

test('loadExternal: nothing connected → {}', async () => {
  const { env } = fixture();
  assert.deepEqual(await loadExternal(env.DB, ['siteA001', 'siteB001'], PERIOD, NOW), {});
  assert.deepEqual(previousWindow(PERIOD), { start: ymd(NOW - 13 * DAY), end: ymd(NOW - 7 * DAY) });
});

test('loadExternal: contract shape, revenue/RPM, and every attention rule', async () => {
  const { db, env } = fixture();
  await connectAll(env);
  await runExternalSync(env, { mode: 'daily', now: NOW, fetchFn: mockFetch().fn });
  // Delta: AdSense disabled ad serving (policy issue on a property we map manually)
  db.prepare("INSERT INTO ext_properties(source,property_id,label,domain,site_id,mapping,state,detail,checked_at) VALUES ('adsense','delta.example','delta.example','delta.example','siteD001','manual','ready',?,?)")
    .run(JSON.stringify({ policy: { action: 'AD_SERVING_DISABLED', topics: ['VALUABLE_INVENTORY'] } }), NOW);

  const ext = await loadExternal(env.DB, ['siteA001', 'siteB001', 'siteC001', 'siteD001', 'siteO001'], PERIOD, NOW);
  const keys = ['revenue_usd', 'revenue_prev_usd', 'rpm_usd', 'adsense', 'adsterra', 'search', 'attention'];
  for (const id of ['siteA001', 'siteB001', 'siteC001', 'siteD001']) assert.deepEqual(Object.keys(ext[id]).sort(), [...keys].sort(), id);
  assert.equal(ext.siteO001, undefined); // no traffic, nothing mapped

  const A = ext.siteA001;
  assert.equal(A.revenue_usd, 21);        // (2.50 + 0.50) × 7 days
  assert.equal(A.revenue_prev_usd, 21);   // first run backfilled 28 days
  assert.equal(A.rpm_usd, 3.33);          // 21 / (900 × 7) × 1000
  assert.deepEqual({ status: A.adsense.status, ads_txt: A.adsense.ads_txt }, { status: 'ready', ads_txt: 'ok' });
  assert.equal(A.adsterra, null);
  assert.equal(A.search.impressions, 700);
  assert.equal(A.search.clicks, 28);
  assert.equal(A.search.indexed_pages, 2);
  assert.equal(A.search.home_verdict, 'PASS');
  assert.deepEqual(A.attention, []);

  const B = ext.siteB001;
  assert.equal(B.revenue_usd, 2.1);
  assert.equal(B.adsterra.status, 'active');
  const codes = (x) => x.attention.map((a) => a.code).sort();
  assert.deepEqual(codes(B), ['ads_txt_problem', 'adsense_needs_attention']);
  assert.equal(B.attention.find((a) => a.code === 'adsense_needs_attention').severity, 'high');
  assert.deepEqual(B.attention.find((a) => a.code === 'ads_txt_problem').params, { status: 'mismatch', domain: 'beta.example' });

  const D = ext.siteD001;
  assert.equal(D.revenue_usd, 0);
  assert.deepEqual(codes(D), ['network_declined']); // only 35 clean visitors → below the no-revenue threshold
  assert.equal(D.attention[0].severity, 'critical');

  // traffic but no revenue: raise Delta's traffic above the threshold
  db.prepare("UPDATE rollup_site_daily SET pv = 400, uv = 100, clean_count = 400 WHERE site_id = 'siteD001'").run();
  const D2 = (await loadExternal(env.DB, ['siteD001'], PERIOD, NOW)).siteD001;
  const tnr = D2.attention.find((a) => a.code === 'traffic_no_revenue');
  assert.equal(tnr.severity, 'high');
  assert.deepEqual(tnr.params, { uv: 700, revenue_usd: 0, min_uv: 200 });
  // threshold is configurable
  db.prepare("INSERT INTO instance_settings(key,value,updated_at) VALUES ('ext_no_revenue_min_uv','5000',1)").run();
  assert.ok(!(await loadExternal(env.DB, ['siteD001'], PERIOD, NOW)).siteD001.attention.some((a) => a.code === 'traffic_no_revenue'));
  // a single (still accruing) day never raises it
  db.prepare("DELETE FROM instance_settings WHERE key='ext_no_revenue_min_uv'").run();
  assert.ok(!(await loadExternal(env.DB, ['siteD001'], { start: TODAY, end: TODAY }, NOW)).siteD001.attention.some((a) => a.code === 'traffic_no_revenue'));

  // stale: > 48 h without a successful sync of a source the site depends on
  const stale = await loadExternal(env.DB, ['siteA001'], PERIOD, NOW + 50 * 3600e3);
  const st = stale.siteA001.attention.filter((a) => a.code === 'external_stale').map((a) => a.params.source).sort();
  assert.deepEqual(st, ['ads_txt', 'adsense', 'gsc']);
  assert.ok(stale.siteA001.attention.every((a) => a.code !== 'external_stale' || a.severity === 'normal'));
});

test('loadExternal: batched — constant query count for 500 sites', async () => {
  const { env } = fixture();
  await connectAll(env);
  let n = 0;
  const DB = { ...env.DB, prepare: (sql) => { n++; return env.DB.prepare(sql); } };
  const ids = Array.from({ length: 500 }, (_, i) => `s${String(i).padStart(7, '0')}`);
  await loadExternal(DB, ids, PERIOD, NOW);
  assert.ok(n <= 3 + 3 * Math.ceil(500 / 90), `queries: ${n}`);
});

// ---------------------------------------------------------------------------
// endpoints
// ---------------------------------------------------------------------------

const cget = (env, path, user = 'admin', init = {}) => consoleWorker.fetch(new Request('https://console.test' + path, {
  ...init, headers: { ...(user ? { cookie: sessionCookie(user) } : {}), ...(init.headers ?? {}) },
}), env);

test('console /api/integrations*: auth, OAuth start/callback, adsterra token, mapping scoping, no secrets in responses', async () => {
  const { db, env } = fixture();
  assert.equal((await cget(env, '/api/integrations', null)).status, 401);
  const r0 = await (await cget(env, '/api/integrations')).json();
  assert.equal(r0.google.configured, true);
  assert.equal(r0.google.connected, false);
  assert.deepEqual(r0.sites.map((s) => s.site_id).sort(), ['siteA001', 'siteB001', 'siteC001', 'siteD001']); // not other owner's

  // start: redirect to Google with state + matching HttpOnly cookie
  const start = await cget(env, '/api/integrations/google/start');
  assert.equal(start.status, 302);
  const loc = new URL(start.headers.get('location'));
  assert.equal(loc.origin + loc.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(loc.searchParams.get('redirect_uri'), 'https://console.test/api/integrations/google/callback');
  const state = loc.searchParams.get('state');
  assert.match(start.headers.get('set-cookie'), new RegExp(`${EXT_STATE_COOKIE}=.*HttpOnly`));

  // callback through the module with a mocked Google
  const { fn, calls } = mockFetch();
  const cb = (q, cookieState) => integrationsApi(new Request(`https://console.test/api/integrations/google/callback?${q}`, {
    headers: { cookie: cookieState ? `${EXT_STATE_COOKIE}=${encodeURIComponent(cookieState)}` : '' },
  }), env, new URL(`https://console.test/api/integrations/google/callback?${q}`), 'admin', fn);
  const bad = await cb(`code=c&state=${encodeURIComponent(state)}`, null);           // CSRF: no cookie
  assert.equal(bad.headers.get('location'), '/integrations.html?error=bad_state');
  assert.equal(calls.length, 0);
  const ok = await cb(`code=c&state=${encodeURIComponent(state)}`, state);
  assert.equal(ok.headers.get('location'), '/integrations.html?connected=google');
  const tokenCall = calls.find((c) => c.url === 'https://oauth2.googleapis.com/token');
  assert.equal(new URLSearchParams(tokenCall.body).get('redirect_uri'), 'https://console.test/api/integrations/google/callback');
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM ext_credentials').all()).includes('rt-secret'));
  assert.deepEqual(await loadCredential(env, 'google'), { refresh_token: 'rt-secret' });

  const r1 = await (await cget(env, '/api/integrations')).json();
  assert.equal(r1.google.connected, true);
  assert.equal(r1.google.account, 'owner@example.com');
  assert.ok(!JSON.stringify(r1).includes('rt-secret'));

  // adsterra token: validated against the API, stored encrypted, never echoed
  const put = (token, f) => integrationsApi(new Request('https://console.test/api/integrations/adsterra', { method: 'PUT', body: JSON.stringify({ token }) }),
    env, new URL('https://console.test/api/integrations/adsterra'), 'admin', f);
  const rej = await put('bad', mockFetch({ 'domains.json': (u, i, res) => res({ message: 'Token not found' }, 401) }).fn);
  assert.equal(rej.status, 400);
  const acc = await put('adst-token-xyz', mockFetch().fn);
  assert.equal(acc.status, 200);
  assert.ok(!JSON.stringify(await (await cget(env, '/api/integrations')).json()).includes('adst-token-xyz'));

  // mapping: only to the owner's own sites
  await runExternalSync(env, { mode: 'daily', now: NOW, fetchFn: mockFetch().fn, sources: ['adsterra'] });
  const map = (b) => cget(env, '/api/integrations/mapping', 'admin', { method: 'PUT', body: JSON.stringify(b) });
  assert.equal((await map({ source: 'adsterra', property_id: '43', site_id: 'siteO001', mode: 'manual' })).status, 403);
  assert.equal((await map({ source: 'adsterra', property_id: 'nope', site_id: 'siteD001', mode: 'manual' })).status, 404);
  assert.equal((await map({ source: 'bogus', property_id: '43' })).status, 400);
  assert.equal((await map({ source: 'adsterra', property_id: '43', site_id: 'siteD001', mode: 'manual' })).status, 200);
  assert.equal(db.prepare("SELECT site_id, mapping FROM ext_properties WHERE property_id='43'").get().mapping, 'manual');

  // settings validation
  const set = (v) => cget(env, '/api/integrations/settings', 'admin', { method: 'POST', body: JSON.stringify({ no_revenue_min_uv: v }) });
  assert.equal((await set(0)).status, 400);
  assert.equal((await set(300)).status, 200);
  assert.equal((await (await cget(env, '/api/integrations')).json()).settings.no_revenue_min_uv, 300);

  // disconnect
  assert.equal((await cget(env, '/api/integrations/adsterra', 'admin', { method: 'DELETE' })).status, 200);
  assert.equal((await (await cget(env, '/api/integrations')).json()).adsterra.connected, false);
});

test('GET /api/sites/{id}/external and /v1/sites/{id}/external: auth + scoping + shape', async () => {
  const { env } = fixture();
  await connectAll(env);
  await runExternalSync(env, { mode: 'daily', now: Date.now(), fetchFn: mockFetch().fn });

  assert.equal((await cget(env, '/api/sites/siteA001/external', null)).status, 401);
  assert.equal((await cget(env, '/api/sites/siteO001/external')).status, 403);
  const c = await (await cget(env, '/api/sites/siteA001/external?period=7d')).json();
  assert.equal(c.available, true);
  assert.ok(c.external && Array.isArray(c.external.attention));
  assert.ok(Array.isArray(c.series) && Array.isArray(c.properties));
  assert.ok(c.properties.some((p) => p.source === 'gsc' && p.property_id === 'sc-domain:alpha.example'));
  assert.ok(!JSON.stringify(c).includes('rt-secret'));

  const get = (path, token) => api.fetch(new Request('https://api.test' + path, { headers: token ? { authorization: `Bearer ${token}` } : {} }), env);
  assert.equal((await get('/v1/sites/siteA001/external')).status, 401);
  assert.equal((await get('/v1/sites/siteA001/external', 'pvuv_other')).status, 403);
  assert.equal((await get('/v1/sites/siteB001/external', 'pvuv_scoped')).status, 403);
  const r = await get('/v1/sites/siteA001/external?period=30d', 'pvuv_scoped');
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.external.adsense.status, 'ready');
  assert.ok(d.external.revenue_usd > 0);
});
