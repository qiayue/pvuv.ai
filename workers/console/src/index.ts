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
import { runDiagnostics, probeEvent } from './diagnostics';
import {
  isProvider, configuredProviders, oauthStart, oauthCallback, isEmailAllowed,
  clearStateCookie, OAuthError,
} from './oauth';

export interface Env {
  DB: D1Database;
  SITE_CONFIG: KVNamespace;
  ASSETS: Fetcher;
  /** Secrets via `wrangler secret put` — never in any file. */
  HMAC_KEY: string;
  ADMIN_PASSWORD: string;
  GOOGLE_CLIENT_SECRET?: string;
  GITHUB_CLIENT_SECRET?: string;
  /** Plain vars (workers/console/wrangler.toml [vars]) */
  ADMIN_EMAIL: string;
  ALLOWED_EMAILS?: string;
  GOOGLE_CLIENT_ID?: string;
  GITHUB_CLIENT_ID?: string;
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
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return homepage(request, env);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

// ---------------------------------------------------------------------------
// homepage: custom full page (public/home.html, gitignored) wins; otherwise
// the shipped default page rendered with the instance settings. Deployers
// customize via console settings (name/description) or home.html — never by
// editing tracked files. Attribution links stay on the homepage (README).
// ---------------------------------------------------------------------------

const DEFAULT_HOME = {
  site_name: 'Web analytics',
  site_description: 'This site runs a self-hosted analytics instance.',
};

/** Attribution footer (README "Attribution", AGPL-3.0 §7(b) additional term).
 *  Appended automatically to custom home.html pages so deployers don't need
 *  to (and must not forget to) include it themselves. Inline-styled so it
 *  renders sanely regardless of the page's own CSS. */
const ATTRIBUTION_FOOTER =
  '<div style="padding:16px;text-align:center;font:12.5px/1.6 system-ui,sans-serif;color:#8a8f98">' +
  'Powered by <a href="https://pvuv.ai" style="color:inherit">pvuv.ai</a> · ' +
  '<a href="https://github.com/qiayue/pvuv.ai" style="color:inherit">open source</a></div>';

async function homepage(request: Request, env: Env): Promise<Response> {
  const origin = new URL(request.url).origin;

  // full override: workers/console/public/home.html (uploaded on deploy if
  // present locally; gitignored so it never enters the public repo).
  // The attribution footer is streamed in at document end — it appears on
  // the homepage even when the custom page doesn't include it.
  const custom = await env.ASSETS.fetch(new Request(`${origin}/home`));
  if (custom.ok) {
    const withFooter = new HTMLRewriter()
      .onDocument({
        end(end) {
          end.append(ATTRIBUTION_FOOTER, { html: true });
        },
      })
      .transform(new Response(custom.body, custom));
    return new Response(withFooter.body, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }

  const s = await instanceSettings(env.DB);
  const def = await env.ASSETS.fetch(new Request(`${origin}/`));
  const html = (await def.text())
    .replaceAll('{{name}}', escapeHtml(s.site_name))
    .replaceAll('{{description}}', escapeHtml(s.site_description));
  return new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

async function instanceSettings(db: D1Database): Promise<typeof DEFAULT_HOME> {
  const out = { ...DEFAULT_HOME };
  try {
    const rows = await db
      .prepare("SELECT key, value FROM instance_settings WHERE key IN ('site_name','site_description')")
      .all<{ key: string; value: string }>();
    for (const r of rows.results) {
      if (r.value && (r.key === 'site_name' || r.key === 'site_description')) out[r.key] = r.value;
    }
  } catch {
    /* table missing (migration not applied yet) → defaults */
  }
  return out;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}

async function api(request: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;

  // public: homepage text (also used by sites.html to prefill the form)
  if (request.method === 'GET' && path === '/api/home') {
    const s = await instanceSettings(env.DB);
    return json({ name: s.site_name, description: s.site_description });
  }

  if (request.method === 'POST' && path === '/api/login') return login(request, env);

  if (request.method === 'POST' && path === '/api/logout') {
    return json({ ok: true }, 200, serializeCookie(SESSION_COOKIE, '', { maxAgeSeconds: 0, httpOnly: true }));
  }

  // which login methods this deployment offers (login.html renders buttons)
  if (request.method === 'GET' && path === '/api/auth/providers') {
    return json({ password: !!env.ADMIN_PASSWORD, providers: configuredProviders(env) });
  }

  // OAuth: /api/auth/:provider/start → redirect; /callback → set session
  const authMatch = path.match(/^\/api\/auth\/([a-z]+)\/(start|callback)$/);
  if (authMatch && request.method === 'GET') {
    const [, provider, action] = authMatch;
    if (!isProvider(provider)) return json({ error: 'unknown provider' }, 404);
    if (action === 'start') return oauthStart(env, provider, url.origin, Date.now());
    return oauthCallbackHandler(request, env, url, provider);
  }

  // everything below requires a session
  const user = await verifySession(env.HMAC_KEY, request.headers.get('cookie'));
  if (!user) throw new ApiError(401, 'auth required');

  if (request.method === 'GET' && path === '/api/me') return json({ user });

  // instance settings: homepage name/description
  if (request.method === 'POST' && path === '/api/settings') {
    let body: { name?: string; description?: string };
    try {
      body = await request.json();
    } catch {
      return json({ error: 'bad json' }, 400);
    }
    const entries: [string, string][] = [
      ['site_name', (body.name ?? '').trim().slice(0, 100)],
      ['site_description', (body.description ?? '').trim().slice(0, 500)],
    ];
    const now = Date.now();
    await env.DB.batch(entries.map(([k, v]) => env.DB.prepare(`
      INSERT INTO instance_settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).bind(k, v, now)));
    return json({ ok: true });
  }

  // --- self-check (health.html) ------------------------------------------
  if (request.method === 'GET' && path === '/api/diagnostics') {
    return json({ checks: await runDiagnostics(env) });
  }
  // ensure a dedicated self-test site whose allowed_domains = this console's
  // host, so a browser test event from health.html passes the ingest whitelist
  if (request.method === 'POST' && path === '/api/diagnostics/selftest-site') {
    // the browser reports its own hostname — the test event's Origin will be
    // this exact host, so the self-test site must be whitelisted for it
    // (deriving it from request.url is unreliable: wrangler dev reports the
    // route pattern host, not the address the browser actually used)
    let reqHost = '';
    try { reqHost = ((await request.json()) as { host?: string }).host ?? ''; } catch { /* body optional */ }
    const host = /^[a-z0-9.-]+$/i.test(reqHost) ? reqHost.toLowerCase() : new URL(request.url).hostname;
    const existing = await env.DB.prepare(
      "SELECT site_id FROM sites WHERE owner_id = ? AND name = '__pvuv_selftest'",
    ).bind(user).first<{ site_id: string }>();
    let siteId = existing?.site_id;
    if (siteId) {
      // refresh the whitelist in case the console host changed since last run
      await env.DB.prepare('UPDATE sites SET allowed_domains = ? WHERE site_id = ?')
        .bind(JSON.stringify([host]), siteId).run();
    } else {
      siteId = generateSiteId();
      await env.DB.prepare(`
        INSERT INTO sites (site_id, name, owner_id, allowed_domains, adguard_mode, created_at)
        VALUES (?, '__pvuv_selftest', ?, ?, 'balanced', ?)
      `).bind(siteId, user, JSON.stringify([host]), Date.now()).run();
    }
    // (re)write the KV cache so ingest sees it immediately
    await env.SITE_CONFIG.put(`site:${siteId}`, JSON.stringify({
      site_id: siteId, allowed_domains: [host], adguard_mode: 'balanced', adclient: null, status: 'active',
    }), { expirationTtl: 300 });
    return json({ site_id: siteId, host });
  }
  if (request.method === 'GET' && path === '/api/diagnostics/probe') {
    const siteId = url.searchParams.get('site') ?? '';
    const vid = url.searchParams.get('vid') ?? '';
    if (!/^[A-Za-z0-9]{4,16}$/.test(siteId) || !vid) return json({ error: 'bad params' }, 400);
    const owns = await env.DB.prepare('SELECT owner_id FROM sites WHERE site_id = ?').bind(siteId).first<{ owner_id: string }>();
    if (!owns || owns.owner_id !== user) throw new ApiError(403, 'not your site');
    return json(await probeEvent(env, siteId, vid, Date.now()));
  }

  if (path === '/api/sites') {
    if (request.method === 'GET') {
      const rows = await env.DB.prepare(
        "SELECT site_id, name, allowed_domains, adguard_mode, adclient, created_at, status FROM sites WHERE owner_id = ? AND name != '__pvuv_selftest' ORDER BY created_at DESC",
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
  if (!env.HMAC_KEY || !env.ADMIN_PASSWORD || !env.ADMIN_EMAIL) {
    console.error('HMAC_KEY / ADMIN_PASSWORD secrets or ADMIN_EMAIL var not set');
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

  const userId = await resolveUser(env, env.ADMIN_EMAIL, 'Owner');
  return json({ ok: true, user: userId }, 200, await sessionCookie(env, userId));
}

// OAuth callback: verify + exchange, gate by allowlist, issue a session, then
// redirect the browser back into the console (errors bounce to the login page)
async function oauthCallbackHandler(request: Request, env: Env, url: URL, provider: 'google' | 'github'): Promise<Response> {
  let identity;
  try {
    identity = await oauthCallback(env, provider, url, request, Date.now());
  } catch (e) {
    const code = e instanceof OAuthError ? e.code : 'oauth_failed';
    return redirect('/login.html?error=' + encodeURIComponent(code), clearStateCookie());
  }
  if (!isEmailAllowed(env, identity.email)) {
    return redirect('/login.html?error=not_allowed', clearStateCookie());
  }
  const userId = await resolveUser(env, identity.email, identity.name ?? identity.email);
  const setSession = await sessionCookie(env, userId);
  // two Set-Cookie headers: clear the oauth state, set the session
  return new Response(null, {
    status: 302,
    headers: [['location', '/sites.html'], ['set-cookie', clearStateCookie()], ['set-cookie', setSession]],
  });
}

/** Map a verified email to a stable user_id; the owner keeps 'admin' so
 *  existing sites stay attached. Upserts the users row. */
async function resolveUser(env: Env, email: string, name: string): Promise<string> {
  const isOwner = env.ADMIN_EMAIL && email.toLowerCase() === env.ADMIN_EMAIL.toLowerCase();
  const userId = isOwner ? ADMIN_USER_ID : `email:${email.toLowerCase()}`;
  await env.DB.prepare(`
    INSERT INTO users (user_id, email, name, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET email = excluded.email, name = excluded.name
  `).bind(userId, email.toLowerCase(), name.slice(0, 100), Date.now()).run();
  return userId;
}

/** Build the signed session Set-Cookie header (format verified by api/auth.ts). */
async function sessionCookie(env: Env, userId: string): Promise<string> {
  const payload = btoa(JSON.stringify({ u: userId, exp: Date.now() + SESSION_TTL_MS }))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const cookie = `${payload}.${await hmacSign(env.HMAC_KEY, payload)}`;
  return serializeCookie(SESSION_COOKIE, cookie, { maxAgeSeconds: SESSION_TTL_MS / 1000, httpOnly: true, sameSite: 'Lax' });
}

function redirect(location: string, setCookie?: string): Response {
  const headers: Record<string, string> = { location };
  if (setCookie) headers['set-cookie'] = setCookie;
  return new Response(null, { status: 302, headers });
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
