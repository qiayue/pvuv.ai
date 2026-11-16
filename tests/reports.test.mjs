// Reports for site launchers / A/B-testing clients: experiment, experiments,
// event_inventory, ai_referrals, plus overview compare, realtime window,
// funnel mode and the release / not_found breakdown dims.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import api from '../.test-api.mjs';
import consoleWorker from '../.test-console.mjs';
import { betaBinomialPBest, decide, seedOf, aiAssistantOf, classifyChannel, eventsTableDDL, monthSuffix } from '../.test-cron.mjs';

const HOUR = 3600e3;
const hmac = (token) => createHmac('sha256', 'test-key').update('apitoken:' + token).digest('base64url');

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync('shared/schema.sql', 'utf8'));
  const now = Date.now();
  for (const t of [now, now - 4 * 86400e3]) for (const sql of eventsTableDDL(monthSuffix(t))) db.exec(sql);
  db.exec("INSERT INTO users(user_id,created_at) VALUES ('owner',1),('other',1)");
  db.prepare('INSERT INTO sites(site_id,name,owner_id,allowed_domains,timezone,created_at) VALUES (?,?,?,?,?,?)')
    .run('siteA001', 'A', 'owner', '["a.example"]', 'UTC', now - 30 * 86400e3);
  for (const [id, token, owner] of [['r', 'pvuv_read', 'owner'], ['o', 'pvuv_other', 'other']]) {
    db.prepare('INSERT INTO api_tokens(token_id,owner_id,name,token_hash,prefix,site_id,created_at,permission) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, owner, id, hmac(token), id, null, 1, 'read');
  }
  let n = 0;
  const ev = (vid, event, ts, { path = '/', props = null, verdict = 'clean', ref = null } = {}) =>
    db.prepare(`INSERT INTO events_${monthSuffix(ts)}(eid,site_id,event,visitor_id,session_id,url,hostname,path,ref_domain,verdict,props,ts,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(`e${n++}`, 'siteA001', event, vid, `s-${vid}`, `https://a.example${path}`, 'a.example', path, ref, verdict,
        props ? JSON.stringify(props) : null, ts, ts);
  const expo = (vid, variant, ts, verdict) => ev(vid, 'exposure', ts, { props: { experiment: 'headline', variant }, verdict });

  // headline: baseline 150 visitors / 30 convert, bold 150 / 60 convert
  const t0 = now - 3 * HOUR;
  for (let i = 0; i < 150; i++) {
    expo(`b${i}`, 'baseline', t0 + i);
    if (i < 30) ev(`b${i}`, 'play_start', t0 + HOUR + i, { props: { mode: 'easy' } });
    expo(`x${i}`, 'bold', t0 + i);
    if (i < 60) ev(`x${i}`, 'play_start', t0 + HOUR + i, { props: { mode: 'hard' } });
  }
  // a second exposure on the next day doesn't make a second visitor
  expo('b0', 'baseline', t0 + 10);
  // saw both variants: attributed to the first (baseline), flagged as multi
  expo('m1', 'baseline', t0 + 5); expo('m1', 'bold', t0 + 50);
  // bot exposure + bot conversion: ignored entirely
  expo('bot1', 'bold', t0, 'bot'); ev('bot1', 'play_start', t0 + 1, { verdict: 'bot' });
  // converted, but outside the 48h window after first exposure
  expo('late', 'baseline', now - 3 * 86400e3); ev('late', 'play_start', now - HOUR);
  // converted BEFORE exposure: not a conversion
  ev('early', 'play_start', t0 - HOUR); expo('early', 'bold', t0);
  // another experiment
  ev('o1', 'exposure', t0, { props: { experiment: 'cover', variant: 'a' } }); ev('o2', 'exposure', t0, { props: { experiment: 'cover', variant: 'b' } });

  // pageviews with release / 404 props (from f.js)
  ev('p1', 'pageview', now - 2 * HOUR, { props: { release: 'v12' } });
  ev('p2', 'pageview', now - 2 * HOUR, { props: { release: 'v13' } });
  ev('p2', 'pageview', now - 2 * HOUR + 1, { path: '/missing', props: { release: 'v13', not_found: 1 }, ref: 'google.com' });
  ev('p3', 'pageview', now - 2 * HOUR, { path: '/missing', props: { not_found: 1 } });

  // funnel: /f → f_goal
  ev('f1', 'pageview', now - 2 * HOUR, { path: '/f' }); ev('f1', 'f_goal', now - 2 * HOUR + 1);
  ev('f2', 'f_goal', now - 2 * HOUR); ev('f2', 'pageview', now - 2 * HOUR + 1, { path: '/f' });
  ev('f3', 'f_goal', now - 2 * HOUR);
  // realtime
  ev('rt', 'pageview', now - 60e3);

  // sessions for ai_referrals
  const sess = (sid, vid, source, channel, verdict = 'clean', page = '/', pv = 2) =>
    db.prepare(`INSERT INTO sessions(session_id,site_id,visitor_id,entry_page,pageviews,source,channel,verdict,started_at,last_active_at,is_bounce)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(sid, 'siteA001', vid, page, pv, source, channel, verdict, now - 2 * HOUR, now - HOUR, pv > 1 ? 0 : 1);
  sess('s1', 'v1', 'chatgpt.com', 'ai', 'clean', '/games/pipe');
  sess('s2', 'v2', 'chatgpt.com', 'ai', 'clean', '/', 1);
  sess('s3', 'v3', 'perplexity.ai', 'ai');
  sess('s4', 'v4', 'chatgpt.com', 'ai', 'bot');
  sess('s5', 'v5', 'google.com', 'organic_search');

  const DB = {
    prepare(sql) {
      let args = [];
      return {
        bind(...x) { args = x; return this; },
        async first() { return db.prepare(sql).get(...args) ?? null; },
        async all() { return { results: db.prepare(sql).all(...args) }; },
        async run() { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
      };
    },
  };
  return { db, now, env: { DB, HMAC_KEY: 'test-key', SITE_CONFIG: { put: async () => {} } } };
}

const get = async (env, path, token = 'pvuv_read') => {
  const r = await api.fetch(new Request('https://api.test' + path, { headers: { authorization: `Bearer ${token}` } }), env);
  return { status: r.status, body: await r.json() };
};
const cookie = () => {
  const payload = Buffer.from(JSON.stringify({ u: 'owner', exp: Date.now() + 60000 })).toString('base64url');
  return `_pvc_s=${payload}.${createHmac('sha256', 'test-key').update('session|' + payload).digest('base64url')}`;
};

// ---------------------------------------------------------------------------
// pure functions
// ---------------------------------------------------------------------------

test('Beta-Binomial p_best: deterministic, sums to 1, sensible', () => {
  const arms = [{ visitors: 1000, conversions: 100 }, { visitors: 1000, conversions: 130 }];
  const a = betaBinomialPBest(arms, { seed: 42 });
  assert.deepEqual(betaBinomialPBest(arms, { seed: 42 }), a);
  assert.ok(Math.abs(a.p_best[0] + a.p_best[1] - 1) < 1e-9);
  assert.ok(a.p_best[1] > 0.97 && a.p_best[1] < 1, String(a.p_best[1]));
  // identical arms ≈ coin flip
  const eq = betaBinomialPBest([{ visitors: 500, conversions: 50 }, { visitors: 500, conversions: 50 }], { seed: 7 });
  assert.ok(Math.abs(eq.p_best[0] - 0.5) < 0.03, String(eq.p_best[0]));
  // no data at all: uniform posteriors, three arms ≈ 1/3 each
  const none = betaBinomialPBest([{ visitors: 0, conversions: 0 }, { visitors: 0, conversions: 0 }, { visitors: 0, conversions: 0 }], { seed: 1 });
  for (const p of none.p_best) assert.ok(Math.abs(p - 1 / 3) < 0.03);
  // p_beat_baseline: null for the baseline itself
  const bb = betaBinomialPBest(arms, { seed: 42, baseline: 0 });
  assert.equal(bb.p_beat_baseline[0], null);
  assert.equal(bb.p_beat_baseline[1], bb.p_best[1]); // two arms: beating baseline = being best
  assert.equal(typeof seedOf('x'), 'number');
});

test('decision rule', () => {
  const v = (variant, visitors, p_best) => ({ variant, visitors, p_best });
  assert.equal(decide([v('a', 500, 0.5)], 100).status, 'insufficient');
  assert.deepEqual(decide([v('a', 50, 0.001), v('b', 500, 0.999)], 100), {
    status: 'insufficient', winner: null, losers: [], reason: 'below min_exposures (100): a',
  });
  const w = decide([v('a', 500, 0.004), v('b', 500, 0.996)], 100);
  assert.equal(w.status, 'winner'); assert.equal(w.winner, 'b'); assert.deepEqual(w.losers, ['a']);
  const r = decide([v('a', 500, 0.005), v('b', 500, 0.5), v('c', 500, 0.495)], 100);
  assert.equal(r.status, 'running'); assert.equal(r.winner, null); assert.deepEqual(r.losers, ['a']);
  // default threshold is strict (0.99); win_threshold can relax it
  assert.equal(decide([v('a', 500, 0.03), v('b', 500, 0.97)], 100).status, 'running');
  assert.equal(decide([v('a', 500, 0.03), v('b', 500, 0.97)], 100, 0.95).status, 'winner');
});

test('AI assistant classification shares the channel rules', () => {
  assert.equal(aiAssistantOf('chatgpt.com'), 'chatgpt');
  assert.equal(aiAssistantOf('chat.openai.com'), 'chatgpt');
  assert.equal(aiAssistantOf('chatgpt'), 'chatgpt'); // utm_source=chatgpt
  assert.equal(aiAssistantOf('www.perplexity.ai'), 'perplexity');
  assert.equal(aiAssistantOf('chat.deepseek.com'), 'deepseek');
  assert.equal(aiAssistantOf('gemini.google.com'), 'gemini');
  assert.equal(aiAssistantOf('google.com'), null);
  assert.equal(classifyChannel({ refDomain: null, utmSource: 'chatgpt.com', utmMedium: null, clickIdType: null }), 'ai');
  assert.equal(classifyChannel({ refDomain: 'claude.ai', utmSource: null, utmMedium: null, clickIdType: null }), 'ai');
});

// ---------------------------------------------------------------------------
// endpoints
// ---------------------------------------------------------------------------

test('experiment: first-exposure attribution, window, clean only, decision', async () => {
  const { env } = fixture();
  const q = '/v1/sites/siteA001/experiment?experiment=headline&goal=play_start&window_hours=48&baseline=baseline&split=adaptive';
  const { status, body } = await get(env, q);
  assert.equal(status, 200);
  const by = Object.fromEntries(body.variants.map((v) => [v.variant, v]));
  // baseline: 150 + m1 + late = 152 visitors, 30 conversions (late is outside the window)
  assert.equal(by.baseline.visitors, 152);
  assert.equal(by.baseline.conversions, 30);
  assert.equal(by.baseline.multi_variant_visitors, 1);
  // bold: 150 + early = 151 (bot excluded), 60 conversions (early converted before exposure)
  assert.equal(by.bold.visitors, 151);
  assert.equal(by.bold.conversions, 60);
  assert.equal(body.variants[0].variant, 'baseline'); // baseline listed first
  assert.ok(by.bold.p_best > 0.99);
  assert.equal(by.bold.p_beat_baseline, by.bold.p_best);
  assert.equal(by.baseline.p_beat_baseline, null);
  assert.ok(by.bold.lift > 0.9);
  assert.deepEqual(body.decision.status, 'winner');
  assert.equal(body.decision.winner, 'bold');
  assert.deepEqual(body.decision.losers, ['baseline']);
  assert.equal(body.split, 'adaptive');
  assert.equal(body.visitors_multi_variant, 1);
  assert.match(body.method, /Beta\(1 \+ conversions/);
  // deterministic
  assert.deepEqual((await get(env, q)).body, body);

  // shorter window drops nobody here; huge min_exposures → insufficient
  const ins = (await get(env, q + '&min_exposures=1000')).body;
  assert.equal(ins.decision.status, 'insufficient');
  assert.deepEqual(ins.decision.losers, []);
  // unknown baseline is still reported, with zero exposures
  const nb = (await get(env, '/v1/sites/siteA001/experiment?experiment=headline&goal=play_start&baseline=control')).body;
  assert.equal(nb.variants[0].variant, 'control');
  assert.equal(nb.variants[0].visitors, 0);
  assert.equal(nb.decision.status, 'insufficient');
  // required params; auth
  assert.equal((await get(env, '/v1/sites/siteA001/experiment?experiment=headline')).status, 400);
  assert.equal((await get(env, '/v1/sites/siteA001/experiment?goal=x')).status, 400);
  assert.equal((await get(env, q, 'pvuv_other')).status, 403);
});

test('experiments + event_inventory', async () => {
  const { env } = fixture();
  const ex = (await get(env, '/v1/sites/siteA001/experiments?period=7d')).body;
  const headline = ex.experiments.find((e) => e.experiment === 'headline');
  assert.equal(headline.visitors, 303); // m1 saw both variants but is one visitor
  assert.equal(headline.variants.find((v) => v.variant === 'bold').visitors, 152); // per variant, m1 counts in both
  assert.deepEqual(headline.variants.map((v) => v.variant).sort(), ['baseline', 'bold']);
  assert.ok(ex.experiments.find((e) => e.experiment === 'cover'));

  const inv = (await get(env, '/v1/sites/siteA001/event_inventory?period=7d')).body;
  const names = inv.events.map((e) => e.event);
  assert.ok(names.includes('play_start') && names.includes('exposure') && names.includes('f_goal'));
  assert.ok(!names.includes('pageview'));
  const ps = inv.events.find((e) => e.event === 'play_start');
  assert.equal(ps.count, 30 + 60 + 2); // bot excluded; late + early included
  assert.deepEqual(ps.props.map((p) => p.key), ['mode']);
  assert.deepEqual(ps.props[0].examples.sort(), ['easy', 'hard']);
  const expo = inv.events.find((e) => e.event === 'exposure');
  assert.deepEqual(expo.props.map((p) => p.key).sort(), ['experiment', 'variant']);
});

test('ai_referrals: clean AI sessions, per assistant, filter', async () => {
  const { env } = fixture();
  const all = (await get(env, '/v1/sites/siteA001/ai_referrals?period=7d')).body;
  assert.deepEqual(all.totals, { sessions: 3, visitors: 3, pageviews: 5 });
  assert.deepEqual(all.assistants.map((a) => [a.assistant, a.sessions]), [['chatgpt', 2], ['perplexity', 1]]);
  assert.equal(all.daily.length, 7);
  assert.equal(all.daily.reduce((s, d) => s + d.sessions, 0), 3);
  assert.equal(all.landing_pages[0].page, '/');
  const gpt = (await get(env, '/v1/sites/siteA001/ai_referrals?period=7d&assistant=chatgpt')).body;
  assert.equal(gpt.totals.sessions, 2);
  assert.deepEqual(gpt.landing_pages.map((p) => p.page).sort(), ['/', '/games/pipe']);
  const none = (await get(env, '/v1/sites/siteA001/ai_referrals?period=7d&assistant=claude')).body;
  assert.equal(none.totals.sessions, 0);
  assert.equal((await get(env, '/v1/sites/siteA001/ai_referrals?assistant=nope')).status, 400);
});

test('overview compare, realtime window, funnel mode + ad-hoc steps, release / 404 breakdown', async () => {
  const { env } = fixture();
  const ov = (await get(env, '/v1/sites/siteA001/overview?period=7d&compare=previous')).body;
  assert.ok(ov.pv > 0);
  assert.equal(ov.compare.mode, 'previous');
  assert.equal(ov.compare.values.pv, 0);
  assert.equal(ov.compare.delta.pv.abs, ov.pv);
  assert.equal(ov.compare.delta.pv.pct, null);
  assert.equal((await get(env, '/v1/sites/siteA001/overview?compare=year')).status, 400);
  assert.equal((await get(env, '/v1/sites/siteA001/overview')).body.compare, undefined);

  const rt = (await get(env, '/v1/sites/siteA001/realtime?window=5')).body;
  assert.equal(rt.window_minutes, 5); assert.equal(rt.minutes.length, 5); assert.equal(rt.online, 1);
  assert.equal((await get(env, '/v1/sites/siteA001/realtime?window=500')).body.window_minutes, 60);
  assert.equal((await get(env, '/v1/sites/siteA001/realtime?window=1')).body.window_minutes, 5);
  assert.equal((await get(env, '/v1/sites/siteA001/realtime')).body.window_minutes, 30);

  const steps = encodeURIComponent(JSON.stringify([{ type: 'page', value: '/f' }, { type: 'event', value: 'f_goal' }]));
  const counts = async (mode) => {
    const r = await get(env, `/v1/sites/siteA001/funnel?period=7d&steps=${steps}${mode ? `&mode=${mode}` : ''}`);
    assert.equal(r.status, 200);
    return [r.body.mode, ...r.body.steps.map((s) => s.visitors)];
  };
  assert.deepEqual(await counts(null), ['ordered', 2, 1]);
  assert.deepEqual(await counts('closed'), ['ordered', 2, 1]);
  assert.deepEqual(await counts('unordered'), ['unordered', 2, 2]);
  assert.deepEqual(await counts('open'), ['open', 2, 3]);
  assert.equal((await get(env, `/v1/sites/siteA001/funnel?steps=${steps}&mode=zigzag`)).status, 400);

  const rel = (await get(env, '/v1/sites/siteA001/breakdown?period=7d&dim=release')).body;
  assert.deepEqual(rel.rows.map((r) => [r.key, r.pv]), [['v13', 2], ['v12', 1]]);
  const nf = (await get(env, '/v1/sites/siteA001/breakdown?period=7d&dim=not_found')).body;
  assert.deepEqual(nf.rows.map((r) => [r.key, r.pv, r.uv]), [['/missing', 2, 2]]);
  assert.equal(nf.rows[0].ref_domains, 'google.com');
  for (const dim of ['page', 'source', 'country', 'device']) {
    assert.equal((await get(env, `/v1/sites/siteA001/breakdown?period=7d&dim=${dim}`)).status, 200, dim);
  }
});

test('console serves the same reports to the owner session', async () => {
  const { env } = fixture();
  const r = await consoleWorker.fetch(new Request('https://console.test/api/sites/siteA001/experiment?experiment=headline&goal=play_start', {
    headers: { cookie: cookie() },
  }), env);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).decision.winner, 'bold');
  for (const p of ['experiments', 'event_inventory', 'ai_referrals', 'realtime?window=10', 'overview?compare=previous']) {
    const x = await consoleWorker.fetch(new Request(`https://console.test/api/sites/siteA001/${p}`, { headers: { cookie: cookie() } }), env);
    assert.equal(x.status, 200, p);
  }
});
