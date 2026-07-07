/**
 * pvuv.ai console worker — pvuv.ai apex (PROJECT_PLAN.md §11, §18.6).
 *
 * Same-origin JSON API for the plain-HTML frontend in public/ (§19: no
 * framework, no <meta name="keywords">), static pages via ASSETS:
 *
 *   POST /api/login            {email, password}
 *   POST /api/logout
 *   GET  /api/me
 *   GET  /api/sites
 *   POST /api/sites            {name, domains[], adguard_mode?, adclient?}
 *   GET  /api/sites/:id/(overview|timeseries|breakdown|quality|traffic)
 *   GET  /api/sites/:id/visitors/:vid/profile
 *
 * M1 auth: single owner account — ADMIN_EMAIL is a plain var; the password
 * comes ONLY from `wrangler secret put ADMIN_PASSWORD` (§22: no secrets in
 * files). Sessions are HMAC-signed cookies; queries reuse the api worker's
 * query layer against the same D1.
 */

import { parsePeriod, overview, timeseries, breakdown, quality, traffic, visitorProfile, ApiError } from '../../api/src/queries';
import { verifySession, SESSION_COOKIE } from '../../api/src/auth';
import { generateSiteId, hmacSign, serializeCookie } from '../../../shared/ids';

export interface Env {
  DB: D1Database;
  SITE_CONFIG: KVNamespace;
  ASSETS: Fetcher;
  /** Secrets via `wrangler secret put` — never in any file. */
  HMAC_KEY: string;
  ADMIN_PASSWORD: string;
  /** Plain var (workers/console/wrangler.toml [vars]) */
  ADMIN_EMAIL: string;
}

const SESSION_TTL_MS = 7 * 86400e3;
const ADMIN_USER_ID = 'admin';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        return await api(request, env, url);
      } catch (err) {
        if (err instanceof ApiError) return json({ error: err.message }, err.status);
        console.error('console api error', err);
        return json({ error: 'internal error' }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

async function api(request: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;

  if (request.method === 'POST' && path === '/api/login') return login(request, env);

  if (request.method === 'POST' && path === '/api/logout') {
    return json({ ok: true }, 200, serializeCookie(SESSION_COOKIE, '', { maxAgeSeconds: 0, httpOnly: true }));
  }

  // everything below requires a session
  const user = await verifySession(env.HMAC_KEY, request.headers.get('cookie'));
  if (!user) throw new ApiError(401, 'auth required');

  if (request.method === 'GET' && path === '/api/me') return json({ user });

  if (path === '/api/sites') {
    if (request.method === 'GET') {
      const rows = await env.DB.prepare(
        'SELECT site_id, name, allowed_domains, adguard_mode, adclient, created_at, status FROM sites WHERE owner_id = ? ORDER BY created_at DESC',
      ).bind(user).all();
      return json({ sites: rows.results });
    }
    if (request.method === 'POST') return createSite(request, env, user);
  }

  // site-scoped queries — reuse the api worker's query layer
  const m = path.match(/^\/api\/sites\/([A-Za-z0-9]{4,16})\/([a-z_]+)(?:\/([^/]+)\/([a-z_]+))?$/);
  if (m && request.method === 'GET') {
    const [, siteId, resource, subId, subResource] = m;
    const site = await env.DB.prepare('SELECT owner_id FROM sites WHERE site_id = ?').bind(siteId).first<{ owner_id: string }>();
    if (!site || site.owner_id !== user) throw new ApiError(403, 'not your site');

    const period = parsePeriod(url.searchParams.get('period'));
    const q = url.searchParams;
    if (resource === 'overview') return json(await overview(env.DB, siteId, period));
    if (resource === 'timeseries') return json(await timeseries(env.DB, siteId, q.get('metric') ?? 'pv', period));
    if (resource === 'breakdown') {
      return json(await breakdown(env.DB, siteId, q.get('dim') ?? 'page', period, parseInt(q.get('limit') ?? '20', 10)));
    }
    if (resource === 'quality') return json(await quality(env.DB, siteId, period));
    if (resource === 'traffic') {
      return json(await traffic(env.DB, siteId, period, {
        verdict: q.get('verdict'),
        minScore: q.has('min_score') ? parseInt(q.get('min_score')!, 10) : undefined,
        limit: parseInt(q.get('limit') ?? '50', 10),
      }));
    }
    if (resource === 'visitors' && subId && subResource === 'profile') {
      return json(await visitorProfile(env.DB, siteId, subId, period));
    }
  }

  throw new ApiError(404, 'not found');
}

// ---------------------------------------------------------------------------
// login / session
// ---------------------------------------------------------------------------

async function login(request: Request, env: Env): Promise<Response> {
  if (!env.HMAC_KEY || !env.ADMIN_PASSWORD) {
    console.error('HMAC_KEY / ADMIN_PASSWORD secrets not set');
    return json({ error: 'server not configured' }, 500);
  }
  let body: { email?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'bad json' }, 400);
  }

  // constant-time-ish compares via HMAC (never compare secrets directly)
  const [pwGot, pwWant] = await Promise.all([
    hmacSign(env.HMAC_KEY, `pw|${body.password ?? ''}`),
    hmacSign(env.HMAC_KEY, `pw|${env.ADMIN_PASSWORD}`),
  ]);
  const emailOk = (body.email ?? '').toLowerCase() === env.ADMIN_EMAIL.toLowerCase();
  if (!emailOk || pwGot !== pwWant) return json({ error: 'invalid credentials' }, 401);

  await env.DB.prepare(`
    INSERT INTO users (user_id, email, name, created_at) VALUES (?, ?, 'Owner', ?)
    ON CONFLICT(user_id) DO UPDATE SET email = excluded.email
  `).bind(ADMIN_USER_ID, env.ADMIN_EMAIL, Date.now()).run();

  const payload = btoa(JSON.stringify({ u: ADMIN_USER_ID, exp: Date.now() + SESSION_TTL_MS }))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const cookie = `${payload}.${await hmacSign(env.HMAC_KEY, payload)}`;
  return json({ ok: true, user: ADMIN_USER_ID }, 200,
    serializeCookie(SESSION_COOKIE, cookie, { maxAgeSeconds: SESSION_TTL_MS / 1000, httpOnly: true, sameSite: 'Lax' }));
}

// ---------------------------------------------------------------------------
// site registration (§18.6): issue site_id, persist, write-through KV cache
// ---------------------------------------------------------------------------

const ADGUARD_MODES = new Set(['off', 'loose', 'balanced', 'strict']);

async function createSite(request: Request, env: Env, owner: string): Promise<Response> {
  let body: { name?: string; domains?: string[]; adguard_mode?: string; adclient?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'bad json' }, 400);
  }

  const name = (body.name ?? '').trim().slice(0, 100);
  const domains = (body.domains ?? [])
    .map((d) => String(d).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
    .filter((d) => /^[a-z0-9.-]+$/.test(d));
  if (!name || domains.length === 0) return json({ error: 'name and at least one valid domain required' }, 400);

  const adguardMode = ADGUARD_MODES.has(body.adguard_mode ?? '') ? body.adguard_mode! : 'off';
  const adclient = body.adclient && /^ca-pub-\d{6,20}$/.test(body.adclient) ? body.adclient : null;

  const siteId = generateSiteId();
  await env.DB.prepare(`
    INSERT INTO sites (site_id, name, owner_id, allowed_domains, adguard_mode, adclient, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(siteId, name, owner, JSON.stringify(domains), adguardMode, adclient, Date.now()).run();

  // write-through KV so ingest sees the new site immediately (§5 whitelist);
  // shape must match the ingest worker's SiteConfig
  await env.SITE_CONFIG.put(`site:${siteId}`, JSON.stringify({
    site_id: siteId,
    allowed_domains: domains,
    adguard_mode: adguardMode,
    adclient,
    status: 'active',
  }), { expirationTtl: 300 });

  return json({ site_id: siteId, name, domains, adguard_mode: adguardMode, adclient });
}

function json(data: unknown, status = 200, setCookie?: string): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (setCookie) headers['set-cookie'] = setCookie;
  return new Response(JSON.stringify(data), { status, headers });
}
