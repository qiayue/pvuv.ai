/**
 * pvuv.ai api worker — api.pvuv.ai (PROJECT_PLAN.md §10, §18.5).
 *
 * M1 endpoints under /v1:
 *   GET /v1/sites/:id/overview?period=30d
 *   GET /v1/sites/:id/timeseries?metric=pv&interval=day&period=30d
 *   GET /v1/sites/:id/breakdown?dim=page|source|utm_campaign|country|device
 *   GET /v1/sites/:id/quality?period=30d
 *   GET /v1/sites/:id/traffic?verdict=bot&min_score=70&limit=50
 *   GET /v1/sites/:id/visitors/:vid/profile
 *
 * Auth (§10): external systems send `Authorization: Bearer <API_TOKEN>`
 * (server-side token, full read access); owners use the console's signed
 * session cookie and can only read their own sites.
 */

import { parsePeriod, siteTimezone, overview, realtime, timeseries, breakdown, quality, traffic, visitorProfile, ApiError, FILTERABLE, type Filter } from './queries';
import { verifySession } from './auth';
import { hmacSign } from '../../../shared/ids';

export interface Env {
  DB: D1Database;
  /** Secrets via `wrangler secret put` — never in any file. */
  HMAC_KEY: string;
  API_TOKEN: string;
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
  if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);

  const url = new URL(request.url);
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
  if (resource === 'traffic') {
    return json(await traffic(env.DB, siteId, period, {
      verdict: q.get('verdict'),
      minScore: q.has('min_score') ? parseInt(q.get('min_score')!, 10) : undefined,
      limit: parseInt(q.get('limit') ?? '50', 10),
    }, filters));
  }
  if (resource === 'visitors' && subId && subResource === 'profile') {
    return json(await visitorProfile(env.DB, siteId, subId, period));
  }

  return json({ error: 'not found' }, 404);
}

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------

async function authorize(request: Request, env: Env, siteId: string): Promise<void> {
  // server-side token (external ranking / AI systems, §10)
  const auth = request.headers.get('authorization');
  if (auth?.startsWith('Bearer ') && env.API_TOKEN) {
    const token = auth.slice(7);
    // constant-time-ish compare: compare HMACs of both values
    const [a, b] = await Promise.all([hmacSign(env.HMAC_KEY, token), hmacSign(env.HMAC_KEY, env.API_TOKEN)]);
    if (a === b) return;
    throw new ApiError(401, 'bad token');
  }

  // console owner session
  const user = await verifySession(env.HMAC_KEY, request.headers.get('cookie'));
  if (!user) throw new ApiError(401, 'auth required');
  const site = await env.DB.prepare('SELECT owner_id FROM sites WHERE site_id = ?').bind(siteId).first<{ owner_id: string }>();
  if (!site || site.owner_id !== user) throw new ApiError(403, 'not your site');
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
      .map((f) => ({ dim: f.dim, value: f.value }));
  } catch { return []; }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
