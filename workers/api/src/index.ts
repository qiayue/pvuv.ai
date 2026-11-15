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
 *
 * Auth (§10): external systems send `Authorization: Bearer <API_TOKEN>`
 * (server-side token, full read access); owners use the console's signed
 * session cookie and can only read their own sites.
 */

import { parsePeriod, siteTimezone, overview, sitesSummary, realtime, timeseries, breakdown, quality, alerts, anomalies, funnel, funnelDropoff, traffic, visitorsList, visitorProfile, ranking, adguardImpact, edge, vitals, conversionTiming, ApiError, FILTERABLE, type Filter, type FunnelStep } from './queries';
import { verifySession } from './auth';
import { bearerFrom, hashToken, looksLikeApiToken } from '../../../shared/tokens';
import { hmacSign, generateSiteId } from '../../../shared/ids';
import { CONFIG } from '../../../shared/config.gen';

export interface Env {
  DB: D1Database;
  /** Secrets via `wrangler secret put` — never in any file. */
  HMAC_KEY: string;
  API_TOKEN: string;
  SITE_CONFIG: KVNamespace;
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
  if (request.method === 'POST') return handleWrite(request, env);
  if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);

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
    return json({
      sites: rows.results.map((r) => {
        let domains: string[] = [];
        try { domains = JSON.parse(r.allowed_domains); } catch { /* stored malformed → report none */ }
        return { site_id: r.site_id, name: r.name, domains, timezone: r.timezone, created_at: r.created_at };
      }),
    });
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

  if (resource === 'realtime') return json(await realtime(env.DB, siteId, Date.now()));
  if (resource === 'overview') return json(await overview(env.DB, siteId, period, filters));
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
    return json(await funnel(env.DB, siteId, period, fsteps, filters, { breakdown: q.get('breakdown') }));
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

  return json({ error: 'not found' }, 404);
}

async function handleWrite(request: Request, env: Env): Promise<Response> {
  const path = new URL(request.url).pathname;
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
  try { body = JSON.parse(text); } catch { return json({error: 'bad json'}, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({error: 'bad json'}, 400);
  if (path === '/v1/sites') {
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 100) : '';
    const domain = typeof body.domain === 'string' ? body.domain.trim().toLowerCase() : '';
    if (!name || domain.length > 253 || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(domain)) return json({error:'valid name and domain required'},400);
    const existing = await env.DB.prepare("SELECT site_id,name,allowed_domains,timezone FROM sites WHERE owner_id = ? AND status = 'active' AND EXISTS (SELECT 1 FROM json_each(allowed_domains) WHERE value = ?) LIMIT 1")
      .bind(caller.owner_id, domain).first<{site_id:string;name:string;allowed_domains:string;timezone:string}>();
    if (existing) return json({created:false,site:{site_id:existing.site_id,name:existing.name,domains:JSON.parse(existing.allowed_domains),timezone:existing.timezone}});
    const owner = await env.DB.prepare('SELECT timezone FROM users WHERE user_id = ?').bind(caller.owner_id).first<{timezone:string}>();
    const timezone = owner?.timezone || 'UTC';
    const now = Date.now(), siteId = generateSiteId(), shadow = now + Math.max(0, CONFIG.adguard.shadow_days) * 86400000;
    const inserted = await env.DB.prepare(`INSERT INTO sites (site_id,name,owner_id,allowed_domains,adguard_mode,timezone,engaged_seconds,shadow_until,created_at)
      SELECT ?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM sites WHERE owner_id = ? AND status = 'active' AND EXISTS (SELECT 1 FROM json_each(allowed_domains) WHERE value = ?))`)
      .bind(siteId,name,caller.owner_id,JSON.stringify([domain]),'off',timezone,15,shadow,now,caller.owner_id,domain).run();
    if (!inserted.meta.changes) {
      const winner = await env.DB.prepare("SELECT site_id,name,allowed_domains,timezone FROM sites WHERE owner_id = ? AND status = 'active' AND EXISTS (SELECT 1 FROM json_each(allowed_domains) WHERE value = ?) LIMIT 1")
        .bind(caller.owner_id,domain).first<{site_id:string;name:string;allowed_domains:string;timezone:string}>();
      if (!winner) throw new ApiError(409,'site creation conflicted; retry');
      return json({created:false,site:{site_id:winner.site_id,name:winner.name,domains:JSON.parse(winner.allowed_domains),timezone:winner.timezone}});
    }
    await env.SITE_CONFIG.put(`site:${siteId}`,JSON.stringify({site_id:siteId,allowed_domains:[domain],adguard_mode:'off',adclient:null,status:'active',shadow_until:shadow}),{expirationTtl:300});
    return json({created:true,site:{site_id:siteId,name,domains:[domain],timezone}});
  }
  const match = path.match(/^\/v1\/sites\/([A-Za-z0-9]{4,16})\/(tokens|funnels)$/);
  if (match) {
    const siteId = match[1];
    await requireOwner(env, siteId, caller.owner_id);
    // GeFeiSites treats an absent token as disabled crawler reporting. The
    // self-hosted analytics schema counts crawler pageviews in overall UV, so
    // minting an ingest token here would misrepresent crawlers as visitors.
    if (match[2] === 'tokens') return json({token:null, supported:false, reason:'crawler reporting is unavailable'});
    const steps = Array.isArray(body.steps) ? body.steps.filter((x: unknown): x is {type: 'page' | 'event'; value: string} => {
      if (!x || typeof x !== 'object') return false;
      const step = x as Record<string, unknown>;
      return (step.type === 'page' || step.type === 'event') && typeof step.value === 'string' && step.value.length > 0;
    }).slice(0,8) : [];
    if (steps.length < 2) return json({error:'a funnel needs 2–8 valid steps'},400);
    const id = generateSiteId(), now = Date.now(), name = typeof body.name === 'string' ? body.name.trim().slice(0,60) || 'Funnel' : 'Funnel';
    await env.DB.prepare('INSERT INTO funnels (site_id,funnel_id,name,steps,created_at,updated_at) VALUES (?,?,?,?,?,?)').bind(siteId,id,name,JSON.stringify(steps),now,now).run();
    return json({funnel_id:id,name,steps,updated_at:now});
  }
  return json({error:'not found'},404);
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
