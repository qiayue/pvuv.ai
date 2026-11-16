/**
 * pvuv.ai api worker — api.pvuv.ai (PROJECT_PLAN.md §10, §18.5).
 *
 * M1 endpoints under /v1:
 *   GET /v1/sites/:id/overview?period=30d
 *   GET /v1/sites/:id/timeseries?metric=pv&interval=day&period=30d
 *   GET /v1/sites/:id/breakdown?dim=page|source|utm_campaign|country|device
 *   GET /v1/sites/:id/quality?period=30d
 *   GET /v1/sites/:id/vitals?period=30d
 *   GET /v1/sites/:id/traffic?verdict=bot&min_score=70&limit=50
 *   GET /v1/sites/:id/funnels                       — saved funnels
 *   GET /v1/sites/:id/funnel?funnel_id=…&breakdown=source
 *   GET /v1/sites/:id/funnel_dropoff?funnel_id=…&step=1
 *   GET /v1/sites/:id/visitors?path=/pay&limit=50
 *   GET /v1/sites/:id/visitors/:vid/profile
 *   GET /v1/sites/:id/crawlers?period=30d             — crawler/indexing signals (separate metric)
 *   GET /v1/sites/:id/experiment?experiment=…&goal=…  — A/B readout (reports.ts)
 *   GET /v1/sites/:id/experiments | event_inventory | ai_referrals
 *   GET /v1/templates                               — the owner's site templates
 *   GET /v1/portfolio?period=7d                     — portfolio overview (all-sites tokens)
 *
 * Site provisioning (write tokens only — see handleWrite):
 *   POST  /v1/sites, PATCH /v1/sites/:id, POST /v1/sites/:id/funnels,
 *   POST  /v1/sites/:id/tokens (mints a site-scoped ingest-only token)
 *
 * Server-side crawler reporting (ingest token, or the owner's write token):
 *   POST  /v1/sites/:id/crawler_hits — the `server` source of /crawlers
 *
 * Auth (§10): external systems send `Authorization: Bearer <API_TOKEN>`
 * (server-side token, full read access); owners use the console's signed
 * session cookie and can only read their own sites.
 */

import { parsePeriod, siteTimezone, overviewCompare, sitesSummary, realtime, timeseries, breakdown, quality, alerts, anomalies, funnel, funnelDropoff, traffic, visitorsList, visitorProfile, ranking, adguardImpact, edge, vitals, conversionTiming, ApiError, FILTERABLE, type Filter, type FunnelStep } from './queries';
import { verifySession } from './auth';
import { crawlers, firstSearchCrawls, truthyParam } from './crawlers';
import { bearerFrom, hashToken, looksLikeApiToken, createToken } from '../../../shared/tokens';
import {
  prepareCrawlerHits, crawlerHitStatements, CRAWLER_HITS_MAX_BODY_BYTES, CRAWLER_HITS_MAX_PER_REQUEST, MAX_INGEST_TOKENS_PER_SITE,
} from '../../../shared/crawler_hits';
import { extraReport } from './reports';
import { cachedPortfolio } from './portfolio';
import { hmacSign } from '../../../shared/ids';
import { CONFIG } from '../../../shared/config.gen';
import {
  normalizeDomains, resolveSettings, insertSite, getSite, findActiveSiteByDomain, findTemplate, listTemplates,
  ensureFunnel, validateSteps, funnelName, buildSnippet, SiteError, SITE_STATUSES, MAX_STEP_LENGTH,
  type SiteRecord, type SiteTemplate,
} from '../../../shared/sites';

export interface Env {
  DB: D1Database;
  /** Secrets via `wrangler secret put` — never in any file. */
  HMAC_KEY: string;
  API_TOKEN: string;
  SITE_CONFIG: KVNamespace;
  /** Plain vars (workers/api/wrangler.toml [vars]) — where the embed snippet
   *  returned by POST /v1/sites points: f.js is served by the console, events
   *  go to the ingest worker. Unset → `snippet: null`. */
  CONSOLE_HOST?: string;
  INGEST_HOST?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (err) {
      if (err instanceof ApiError) return json({ error: err.message }, err.status);
      console.error('api error', err);
      return json({ error: 'internal error' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') return handleWrite(request, env);

  const url = new URL(request.url);

  // cross-site ranking (§14) — not site-scoped; server-side token only. Placed
  // before the site-scoped matcher since it has no site id in the path.
  if (url.pathname === '/v1/ranking') {
    await authorizeToken(request, env);
    // cross-site: no single site timezone, so resolve the period in UTC
    const period = parsePeriod(url.searchParams.get('period'), 'UTC');
    const limit = parseInt(url.searchParams.get('limit') ?? '100', 10);
    return json(await ranking(env.DB, period, limit));
  }

  // site discovery — every programmatic client (MCP, CLI, integrations) needs
  // this before it can query anything, since site ids aren't guessable.
  if (url.pathname === '/v1/sites') {
    const caller = await resolveCaller(request, env);
    const where: string[] = ["status = 'active'"];
    const binds: unknown[] = [];
    if (caller.ownerId) { where.push('owner_id = ?'); binds.push(caller.ownerId); }
    if (caller.siteId) { where.push('site_id = ?'); binds.push(caller.siteId); }
    const rows = await env.DB.prepare(
      `SELECT site_id, name, allowed_domains, timezone, created_at FROM sites WHERE ${where.join(' AND ')} ORDER BY created_at`,
    ).bind(...binds).all<{ site_id: string; name: string; allowed_domains: string; timezone: string; created_at: number }>();
    // launch overview: when a search engine first crawled each site (crawler
    // milestones, 0024) — null until one has
    const firstCrawl = await firstSearchCrawls(env.DB, rows.results.map((r) => r.site_id));
    return json({
      sites: rows.results.map((r) => {
        let domains: string[] = [];
        try { domains = JSON.parse(r.allowed_domains); } catch { /* stored malformed → report none */ }
        return {
          site_id: r.site_id, name: r.name, domains, timezone: r.timezone, created_at: r.created_at,
          first_search_crawl_at: firstCrawl.get(r.site_id) ?? null,
        };
      }),
    });
  }

  // portfolio overview (docs/design/portfolio-ui.md §3.1) — every site of the
  // token's owner, so a site-scoped token is refused. Same payload and 5-minute
  // cache as the console's /api/portfolio.
  if (url.pathname === '/v1/portfolio') {
    const caller = await resolveCaller(request, env);
    if (caller.siteId) throw new ApiError(403, 'portfolio needs a token for all sites');
    const q = url.searchParams;
    const { body, hit } = await cachedPortfolio(env.DB, caller.ownerId, q.get('period'), q.get('compare'), q.get('fresh') === '1');
    return new Response(body, { headers: { 'content-type': 'application/json', 'x-cache': hit ? 'hit' : 'miss' } });
  }

  // site templates (migration 0023) — what an integration may pass as
  // POST /v1/sites {"template": …}. Any of the owner's tokens may list them.
  if (url.pathname === '/v1/templates') {
    const caller = await resolveCaller(request, env);
    if (!caller.ownerId) throw new ApiError(403, 'templates belong to an owner — use a personal API token');
    return json({ templates: await listTemplates(env.DB, caller.ownerId) });
  }

  // batched per-site totals for a site LIST — one pass over the rollups (and,
  // for the current day, one pass per partition) instead of one whole-period
  // raw scan per site. See sitesSummary.
  if (url.pathname === '/v1/sites/summary') {
    const caller = await resolveCaller(request, env);
    const where: string[] = ["status = 'active'", "name != '__pvuv_selftest'"];
    const binds: unknown[] = [];
    if (caller.ownerId) { where.push('owner_id = ?'); binds.push(caller.ownerId); }
    if (caller.siteId) { where.push('site_id = ?'); binds.push(caller.siteId); }
    const rows = await env.DB.prepare(
      `SELECT site_id, timezone FROM sites WHERE ${where.join(' AND ')}`,
    ).bind(...binds).all<{ site_id: string; timezone: string | null }>();
    return json(await sitesSummary(env.DB, rows.results, url.searchParams.get('period')));
  }

  const m = url.pathname.match(/^\/v1\/sites\/([A-Za-z0-9]{4,16})\/([a-z_]+)(?:\/([^/]+)\/([a-z_]+))?$/);
  if (!m) return json({ error: 'not found' }, 404);
  const [, siteId, resource, subId, subResource] = m;

  await authorize(request, env, siteId);

  // period is resolved in the site's own timezone (rollups are keyed on it)
  const period = parsePeriod(url.searchParams.get('period'), await siteTimezone(env.DB, siteId));
  const q = url.searchParams;
  const filters = parseFilters(q.get('filters'));

  if (resource === 'realtime') return json(await realtime(env.DB, siteId, Date.now(), parseInt(q.get('window') ?? '30', 10)));
  if (resource === 'overview') return json(await overviewCompare(env.DB, siteId, period, filters, q.get('compare')));
  if (resource === 'timeseries') {
    return json(await timeseries(env.DB, siteId, q.get('metric') ?? 'pv', period, q.get('interval') ?? 'day', filters));
  }
  if (resource === 'breakdown') {
    return json(await breakdown(env.DB, siteId, q.get('dim') ?? 'page', period, parseInt(q.get('limit') ?? '20', 10), q.get('key'), filters));
  }
  if (resource === 'quality') return json(await quality(env.DB, siteId, period, filters));
  if (resource === 'vitals') return json(await vitals(env.DB, siteId, period, filters));
  if (resource === 'ctit') return json(await conversionTiming(env.DB, siteId, period));
  if (resource === 'adguard') return json(await adguardImpact(env.DB, siteId, period));
  if (resource === 'edge') return json(await edge(env.DB, siteId, period));
  if (resource === 'crawlers') {
    return json(await crawlers(env.DB, siteId, period, { limit: parseInt(q.get('limit') ?? '20', 10), bot: q.get('bot'), search: truthyParam(q.get('search')) }));
  }
  if (resource === 'alerts') return json(await alerts(env.DB, siteId, period, filters));
  if (resource === 'anomalies') return json(await anomalies(env.DB, siteId));
  // funnel: ad-hoc `steps`, or a saved funnel by `funnel_id` (so an agent can
  // ask about "the checkout funnel" without being told its steps)
  if (resource === 'funnels') {
    const rows = await env.DB.prepare(
      'SELECT funnel_id, name, steps, created_at, updated_at FROM funnels WHERE site_id = ? ORDER BY created_at',
    ).bind(siteId).all<{ funnel_id: string; name: string; steps: string; created_at: number; updated_at: number }>();
    return json({ funnels: rows.results.map((r) => ({ ...r, steps: parseFunnelSteps(r.steps) })) });
  }
  if (resource === 'funnel' || resource === 'funnel_dropoff') {
    let fsteps = parseFunnelSteps(q.get('steps'));
    const fid = q.get('funnel_id');
    if (fid) {
      const row = await env.DB.prepare('SELECT steps FROM funnels WHERE site_id = ? AND funnel_id = ?')
        .bind(siteId, fid).first<{ steps: string }>();
      if (!row) throw new ApiError(404, 'no such funnel');
      fsteps = parseFunnelSteps(row.steps);
    }
    if (resource === 'funnel_dropoff') {
      return json(await funnelDropoff(env.DB, siteId, period, fsteps, parseInt(q.get('step') ?? '0', 10), filters,
        parseInt(q.get('limit') ?? '50', 10)));
    }
    return json(await funnel(env.DB, siteId, period, fsteps, filters, { breakdown: q.get('breakdown'), mode: q.get('mode') }));
  }
  if (resource === 'traffic') {
    return json(await traffic(env.DB, siteId, period, {
      verdict: q.get('verdict'),
      minScore: q.has('min_score') ? parseInt(q.get('min_score')!, 10) : undefined,
      limit: parseInt(q.get('limit') ?? '50', 10),
    }, filters));
  }
  if (resource === 'visitors' && !subId) {
    return json(await visitorsList(env.DB, siteId, period, {
      path: q.get('path'),
      verdict: q.get('verdict'),
      limit: parseInt(q.get('limit') ?? '50', 10),
    }));
  }
  if (resource === 'visitors' && subId && subResource === 'profile') {
    return json(await visitorProfile(env.DB, siteId, subId, period));
  }
  if (!subId) {
    const extra = await extraReport(env.DB, siteId, resource, q, period);
    if (extra !== undefined) return json(extra);
  }

  return json({ error: 'not found' }, 404);
}

// ---------------------------------------------------------------------------
// site provisioning (write tokens only)
//
//   POST  /v1/sites                  find-or-create a site by domain (+ template)
//   PATCH /v1/sites/:id              rename, change domains, archive / restore
//   POST  /v1/sites/:id/funnels      find-or-create a saved funnel by name
//   POST  /v1/sites/:id/tokens       mint a site-scoped ingest-only token
//   POST  /v1/sites/:id/crawler_hits server-side crawler reports (ingest token)
//
// Every call except /tokens is safe to retry: an integration that times out
// and tries again gets the same site / funnel back rather than a duplicate.
// /tokens mints a new token per call (a plaintext cannot be shown twice);
// /crawler_hits is additive (a retried report is counted again).
// ---------------------------------------------------------------------------

/** Route a non-GET request. Unknown paths are a 404 BEFORE any auth, so a typo
 *  reads as "no such endpoint" rather than "bad token". */
async function handleWrite(request: Request, env: Env): Promise<Response> {
  const path = new URL(request.url).pathname;
  const siteMatch = path.match(/^\/v1\/sites\/([A-Za-z0-9]{4,16})$/);
  const subMatch = path.match(/^\/v1\/sites\/([A-Za-z0-9]{4,16})\/(tokens|funnels|crawler_hits)$/);
  const method = path === '/v1/sites' || subMatch ? 'POST' : siteMatch ? 'PATCH' : null;
  if (!method) return json({ error: 'not found' }, 404);
  if (request.method !== method) return json({ error: 'method not allowed' }, 405);
  // crawler reports have their own auth (ingest tokens) and limits
  if (subMatch && subMatch[2] === 'crawler_hits') return crawlerHits(request, env, subMatch[1]);

  const token = bearerFrom(request);
  if (!token || !looksLikeApiToken(token)) throw new ApiError(401, 'auth required');
  const hash = await hashToken(env.HMAC_KEY, token);
  const caller = await env.DB.prepare('SELECT owner_id, site_id, permission, revoked_at FROM api_tokens WHERE token_hash = ?')
    .bind(hash).first<{owner_id: string; site_id: string | null; permission: string; revoked_at: number | null}>();
  if (!caller || caller.revoked_at) throw new ApiError(401, 'bad token');
  if (caller.permission !== 'write' || caller.site_id) throw new ApiError(403, 'write permission required');
  try { await env.DB.prepare('UPDATE api_tokens SET last_used_at = ? WHERE token_hash = ?').bind(Date.now(),hash).run(); } catch { /* telemetry only */ }
  const length = Number(request.headers.get('content-length') || 0);
  if (length > 16384) return json({error:'request too large'},413);
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > 16384) return json({error:'request too large'},413);
  let body: Record<string, unknown>;
  // POST /tokens: the body (just an optional name) may be empty
  if (!text.trim() && subMatch?.[2] === 'tokens') body = {};
  else {
    try { body = JSON.parse(text); } catch { return json({error: 'bad json'}, 400); }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({error: 'bad json'}, 400);

  try {
    if (path === '/v1/sites') return await provisionSite(env, caller.owner_id, body);
    if (siteMatch) {
      await requireOwner(env, siteMatch[1], caller.owner_id);
      return await updateSite(env, caller.owner_id, siteMatch[1], body);
    }
    const siteId = subMatch![1];
    await requireOwner(env, siteId, caller.owner_id);
    if (subMatch![2] === 'tokens') return await mintIngestToken(env, caller.owner_id, siteId, body);
    const steps = validateSteps(body.steps);
    if (steps.length < 2) return json({ error: `a funnel needs 2–8 steps with a value (max ${MAX_STEP_LENGTH} chars)` }, 400);
    return json(await ensureFunnel(env.DB, siteId, funnelName(body.name), steps));
  } catch (err) {
    if (err instanceof SiteError) throw new ApiError(err.status, err.message);
    throw err;
  }
}

/** POST /v1/sites/:id/tokens — mint a site-scoped, ingest-only token for
 *  server-side crawler reporting. NOT idempotent: the plaintext cannot be
 *  recovered, so every call mints a new token (callers ask only when they hold
 *  none). Capped at MAX_INGEST_TOKENS_PER_SITE live tokens per site; old ones
 *  are revoked in the console token list. */
async function mintIngestToken(env: Env, owner: string, siteId: string, body: Record<string, unknown>): Promise<Response> {
  const live = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM api_tokens WHERE site_id = ? AND permission = 'ingest' AND revoked_at IS NULL",
  ).bind(siteId).first<{ n: number }>();
  if ((live?.n ?? 0) >= MAX_INGEST_TOKENS_PER_SITE) {
    return json({ error: `this site already has ${MAX_INGEST_TOKENS_PER_SITE} live ingest tokens — revoke unused ones in the console` }, 409);
  }
  const name = (typeof body.name === 'string' ? body.name.trim() : '') || 'crawler ingest';
  const { plaintext, row } = await createToken(env.HMAC_KEY, owner, name, siteId);
  await env.DB.prepare(`
    INSERT INTO api_tokens (token_id, owner_id, name, token_hash, prefix, site_id, created_at, permission)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'ingest')
  `).bind(row.token_id, row.owner_id, row.name, row.token_hash, row.prefix, row.site_id, row.created_at).run();
  return json({
    token: plaintext, token_id: row.token_id, site_id: siteId, scopes: ['ingest'],
    name: row.name, prefix: row.prefix, created_at: row.created_at,
  });
}

/** POST /v1/sites/:id/crawler_hits — server-side crawler reports (the `server`
 *  source of the crawler metric). Auth: an ingest token scoped to THIS site, or
 *  the owner's all-sites read/write token. One point read (token + site) and one
 *  batched write per request; nothing reaches events / PV/UV / scoring. */
async function crawlerHits(request: Request, env: Env, siteId: string): Promise<Response> {
  const token = bearerFrom(request);
  if (!token || !looksLikeApiToken(token)) throw new ApiError(401, 'auth required');
  const hash = await hashToken(env.HMAC_KEY, token);
  const row = await env.DB.prepare(`
    SELECT t.token_id, t.owner_id, t.site_id, t.permission, t.revoked_at, t.last_used_at,
           s.owner_id AS site_owner, s.status, s.timezone
    FROM api_tokens t LEFT JOIN sites s ON s.site_id = ?
    WHERE t.token_hash = ?
  `).bind(siteId, hash).first<{
    token_id: string; owner_id: string; site_id: string | null; permission: string; revoked_at: number | null;
    last_used_at: number | null; site_owner: string | null; status: string | null; timezone: string | null;
  }>();
  if (!row || row.revoked_at) throw new ApiError(401, 'bad token');
  if (row.permission === 'ingest') {
    if (row.site_id !== siteId) throw new ApiError(403, 'token not valid for this site');
  } else if (row.permission !== 'write' || row.site_id) {
    throw new ApiError(403, 'ingest or write permission required');
  }
  if (!row.site_owner || row.site_owner !== row.owner_id) throw new ApiError(403, 'not your site');
  if (row.status && row.status !== 'active') throw new ApiError(403, 'site is not active');

  const length = Number(request.headers.get('content-length') || 0);
  if (length > CRAWLER_HITS_MAX_BODY_BYTES) return json({ error: 'request too large' }, 413);
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > CRAWLER_HITS_MAX_BODY_BYTES) return json({ error: 'request too large' }, 413);
  let body: { hits?: unknown };
  try { body = JSON.parse(text); } catch { return json({ error: 'bad json' }, 400); }
  if (!body || typeof body !== 'object' || !Array.isArray(body.hits)) return json({ error: 'body must be {"hits": [...]}' }, 400);
  if (body.hits.length > CRAWLER_HITS_MAX_PER_REQUEST) {
    return json({ error: `at most ${CRAWLER_HITS_MAX_PER_REQUEST} hits per request` }, 413);
  }

  const now = Date.now();
  const { accepted, ignored, groups } = prepareCrawlerHits(body.hits, row.timezone || 'UTC', now);
  const stmts = crawlerHitStatements(env.DB, siteId, groups, now);
  // last_used_at at most once an hour per token: every crawler hit lands here
  if (!row.last_used_at || row.last_used_at < now - 3600e3) {
    stmts.push(env.DB.prepare('UPDATE api_tokens SET last_used_at = ? WHERE token_id = ?').bind(now, row.token_id));
  }
  if (stmts.length) {
    try {
      await env.DB.batch(stmts);
    } catch (err) {
      // most likely migration 0025 not applied yet — say so instead of a bare 500
      console.error('crawler_hits write failed', err);
      throw new ApiError(503, 'crawler reporting is not available on this deployment yet (apply migration 0025)');
    }
  }
  return json({ accepted, ignored });
}

/** Public shape of a site in write responses (a superset of GET /v1/sites). */
function siteOut(s: SiteRecord) {
  return { site_id: s.site_id, name: s.name, domains: s.domains, timezone: s.timezone, status: s.status,
    adguard_mode: s.adguard_mode, adclient: s.adclient, engaged_seconds: s.engaged_seconds, shadow_until: s.shadow_until };
}

/** The embed tag, when the deployment declares where f.js and ingest live
 *  (workers/api/wrangler.toml [vars] CONSOLE_HOST / INGEST_HOST). */
function snippetFor(env: Env, s: SiteRecord): string | null {
  if (!env.CONSOLE_HOST || !env.INGEST_HOST) return null;
  return buildSnippet(`https://${env.CONSOLE_HOST}`, env.INGEST_HOST, s);
}

/** POST /v1/sites — idempotent per owner + domain. Settings: explicit field >
 *  template > default, validated with the console's rules (but strictly: a
 *  malformed adclient or mode is a 400, not silently dropped). A template's
 *  default funnels are ensured by name on every call, so a retry after a
 *  partial failure completes the set. */
async function provisionSite(env: Env, owner: string, body: Record<string, unknown>): Promise<Response> {
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 100) : '';
  const requested = [body.domain, ...(Array.isArray(body.domains) ? body.domains : [])].filter((d) => d !== undefined && d !== null && d !== '');
  const { domains, invalid } = normalizeDomains(requested);
  if (!name || !domains.length) return json({error:'valid name and domain required'},400);
  if (invalid.length) return json({ error: `invalid domain: ${invalid[0]}` }, 400);

  let template: SiteTemplate | null = null;
  if (body.template !== undefined && body.template !== null && body.template !== '') {
    template = await findTemplate(env.DB, owner, String(body.template));
    if (!template) return json({ error: `no such template: ${String(body.template)}` }, 400);
  }
  const owned = await env.DB.prepare('SELECT timezone FROM users WHERE user_id = ?').bind(owner).first<{timezone:string}>();
  const resolved = resolveSettings(body, template, owned?.timezone || 'UTC', true);
  if ('error' in resolved) return json({ error: resolved.error }, 400);

  const { created, site } = await insertSite(env.DB, env.SITE_CONFIG, owner, { name, domains, ...resolved.settings },
    { dedupe: true, shadowDays: CONFIG.adguard.shadow_days });
  const funnels = [];
  for (const f of template?.funnels ?? []) {
    const r = await ensureFunnel(env.DB, site.site_id, f.name, f.steps);
    funnels.push({ funnel_id: r.funnel_id, name: r.name, created: r.created, updated: r.updated });
  }
  return json({ created, site: siteOut(site), snippet: snippetFor(env, site), template: template?.template_id ?? null, funnels });
}

/** PATCH /v1/sites/:id — `name`; `domains` (replace the list) and/or
 *  `add_domains` / `remove_domains`; `status` 'active' | 'archived'. An
 *  archived site stops collecting (ingest only accepts active sites) but keeps
 *  its data, and drops out of GET /v1/sites. A domain may belong to only one
 *  active site per owner, which keeps POST /v1/sites' dedupe unambiguous. */
async function updateSite(env: Env, owner: string, siteId: string, body: Record<string, unknown>): Promise<Response> {
  const site = await getSite(env.DB, siteId);
  if (!site) throw new ApiError(404, 'no such site');

  let name = site.name;
  if (body.name !== undefined) {
    name = typeof body.name === 'string' ? body.name.trim().slice(0, 100) : '';
    if (!name) return json({ error: 'name must be a non-empty string' }, 400);
  }
  let domains = site.domains.slice();
  const list = (key: string): string[] | Response => {
    if (body[key] === undefined) return [];
    if (!Array.isArray(body[key])) return json({ error: `${key} must be a list` }, 400);
    const { domains: d, invalid } = normalizeDomains(body[key]);
    if (invalid.length) return json({ error: `invalid domain: ${invalid[0]}` }, 400);
    return d;
  };
  const replace = list('domains'), add = list('add_domains'), remove = list('remove_domains');
  for (const x of [replace, add, remove]) if (x instanceof Response) return x;
  if (body.domains !== undefined) domains = replace as string[];
  for (const d of add as string[]) if (!domains.includes(d)) domains.push(d);
  domains = domains.filter((d) => !(remove as string[]).includes(d));
  if (!domains.length) return json({ error: 'a site needs at least one domain' }, 400);

  let status = site.status;
  if (body.status !== undefined) {
    if (typeof body.status !== 'string' || !SITE_STATUSES.has(body.status)) return json({ error: 'status must be active or archived' }, 400);
    status = body.status;
  }
  if (status === 'active') {
    const clash = await findActiveSiteByDomain(env.DB, owner, domains, siteId);
    if (clash) {
      const taken = domains.find((d) => clash.domains.includes(d));
      return json({ error: `domain ${taken} already belongs to active site ${clash.site_id}`, site_id: clash.site_id }, 409);
    }
  }

  const changed = name !== site.name || status !== site.status || JSON.stringify(domains) !== JSON.stringify(site.domains);
  if (changed) {
    await env.DB.prepare('UPDATE sites SET name = ?, allowed_domains = ?, status = ? WHERE site_id = ?')
      .bind(name, JSON.stringify(domains), status, siteId).run();
    // ingest caches site:<id> for minutes; drop it so the new whitelist /
    // status applies on the next event instead of after the TTL
    await env.SITE_CONFIG.delete(`site:${siteId}`);
  }
  return json({ changed, site: siteOut({ ...site, name, domains, status }) });
}

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------

/** Require the server-side API token (external ranking / AI systems, §10, §14).
 *  Owner sessions are per-site and can't authorize a cross-site query. */
async function authorizeToken(request: Request, env: Env): Promise<void> {
  const token = bearerFrom(request);
  if (token && env.API_TOKEN) {
    const [a, b] = await Promise.all([hmacSign(env.HMAC_KEY, token), hmacSign(env.HMAC_KEY, env.API_TOKEN)]);
    if (a === b) return;
  }
  throw new ApiError(401, 'auth required');
}

/** Look up a personal API token (§10) by its stored HMAC. Returns the owner and
 *  the token's site restriction, or null when it is unknown or revoked.
 *  `last_used_at` is refreshed opportunistically so an owner can spot tokens
 *  that are no longer in use; a failed refresh never fails the request. */
async function resolveApiToken(env: Env, plaintext: string): Promise<{ owner_id: string; site_id: string | null } | null> {
  const hash = await hashToken(env.HMAC_KEY, plaintext);
  const row = await env.DB
    .prepare('SELECT token_id, owner_id, site_id, revoked_at, permission FROM api_tokens WHERE token_hash = ?')
    .bind(hash).first<{ token_id: string; owner_id: string; site_id: string | null; revoked_at: number | null; permission: string }>();
  if (!row || row.revoked_at) return null;
  if (row.permission === 'ingest') throw new ApiError(403, 'ingest token cannot read');
  try {
    await env.DB.prepare('UPDATE api_tokens SET last_used_at = ? WHERE token_id = ?').bind(Date.now(), row.token_id).run();
  } catch { /* telemetry only */ }
  return { owner_id: row.owner_id, site_id: row.site_id };
}

async function authorize(request: Request, env: Env, siteId: string): Promise<void> {
  const token = bearerFrom(request);
  if (token) {
    // personal API token (§10): scoped to its owner's sites, individually
    // revocable. Checked first — it is the credential MCP/CLI clients use.
    if (looksLikeApiToken(token)) {
      const t = await resolveApiToken(env, token);
      if (!t) throw new ApiError(401, 'bad token');
      if (t.site_id && t.site_id !== siteId) throw new ApiError(403, 'token not valid for this site');
      await requireOwner(env, siteId, t.owner_id);
      return;
    }
    // legacy deployment-wide server token (external ranking / AI systems, §14)
    if (env.API_TOKEN) {
      const [a, b] = await Promise.all([hmacSign(env.HMAC_KEY, token), hmacSign(env.HMAC_KEY, env.API_TOKEN)]);
      if (a === b) return;
    }
    throw new ApiError(401, 'bad token');
  }

  // console owner session
  const user = await verifySession(env.HMAC_KEY, request.headers.get('cookie'));
  if (!user) throw new ApiError(401, 'auth required');
  await requireOwner(env, siteId, user);
}

/** Identify the caller for non-site-scoped routes. `ownerId` null means the
 *  deployment-wide server token (sees everything); `siteId` non-null means a
 *  personal token that was restricted to a single site. */
async function resolveCaller(request: Request, env: Env): Promise<{ ownerId: string | null; siteId: string | null }> {
  const token = bearerFrom(request);
  if (token) {
    if (looksLikeApiToken(token)) {
      const t = await resolveApiToken(env, token);
      if (!t) throw new ApiError(401, 'bad token');
      return { ownerId: t.owner_id, siteId: t.site_id };
    }
    if (env.API_TOKEN) {
      const [a, b] = await Promise.all([hmacSign(env.HMAC_KEY, token), hmacSign(env.HMAC_KEY, env.API_TOKEN)]);
      if (a === b) return { ownerId: null, siteId: null };
    }
    throw new ApiError(401, 'bad token');
  }
  const user = await verifySession(env.HMAC_KEY, request.headers.get('cookie'));
  if (!user) throw new ApiError(401, 'auth required');
  return { ownerId: user, siteId: null };
}

async function requireOwner(env: Env, siteId: string, ownerId: string): Promise<void> {
  const site = await env.DB.prepare('SELECT owner_id FROM sites WHERE site_id = ?').bind(siteId).first<{ owner_id: string }>();
  if (!site || site.owner_id !== ownerId) throw new ApiError(403, 'not your site');
}

/** Parse the `filters` query param: a JSON array of {dim,value}, capped and
 *  validated against the filterable-dim allowlist. Malformed → no filters. */
function parseFilters(raw: string | null): Filter[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((f) => f && typeof f.dim === 'string' && typeof f.value === 'string' && FILTERABLE.has(f.dim))
      .slice(0, 8)
      .map((f) => {
        const values = Array.isArray(f.values)
          ? f.values.filter((v: unknown) => typeof v === 'string').slice(0, 20) as string[] : [];
        return values.length ? { dim: f.dim, value: f.value, values } : { dim: f.dim, value: f.value };
      });
  } catch { return []; }
}

/** Parse the funnel `steps` param: JSON [{type,value}], capped and validated. */
function parseFunnelSteps(raw: string | null): FunnelStep[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((s) => s && (s.type === 'page' || s.type === 'event') && typeof s.value === 'string')
      .slice(0, 8)
      .map((s) => ({ type: s.type, value: s.value }));
  } catch { return []; }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
