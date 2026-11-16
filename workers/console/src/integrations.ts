/**
 * Console API for external integrations (session-authenticated; the caller
 * has already verified the session and passes the user id).
 *
 *   GET    /api/integrations                    status, properties, sites, settings
 *   GET    /api/integrations/google/start       → 302 to Google consent (CSRF state)
 *   GET    /api/integrations/google/callback    ← Google; stores the refresh token encrypted
 *   POST   /api/integrations/google/disconnect  revoke + delete
 *   PUT    /api/integrations/adsterra           {token} verify + store encrypted
 *   DELETE /api/integrations/adsterra
 *   POST   /api/integrations/sync               {source?} run a sync now
 *   PUT    /api/integrations/mapping            {source, property_id, site_id|null, mode}
 *   POST   /api/integrations/settings           {no_revenue_min_uv}
 *
 * Credentials never leave the worker: responses carry only labels/status.
 */

import { hmacSign, hmacVerify, serializeCookie, parseCookies } from '../../../shared/ids';
import {
  type ExtEnv, type Source, SOURCES, googleClient, saveCredential, loadCredential, deleteCredential, credentialRows,
  syncStatuses, properties, setMapping, noRevenueMinUv, NO_REVENUE_MIN_UV_KEY, type GoogleCredential, type AdsterraCredential,
} from '../../../shared/external/store';
import {
  type FetchFn, googleAuthUrl, exchangeGoogleCode, googleEmail, revokeGoogleToken, refreshGoogleToken, ExtError,
} from '../../../shared/external/google';
import { adsterraDomains } from '../../../shared/external/adsterra';
import { runExternalSync } from '../../../shared/external/sync';
import { parseDomains } from '../../../shared/external/domains';

export const EXT_STATE_COOKIE = '_pvc_ext';
const STATE_TTL_MS = 10 * 60 * 1000;

function json(data: unknown, status = 200, setCookie?: string): Response {
  const h = new Headers({ 'content-type': 'application/json', 'cache-control': 'no-store' });
  if (setCookie) h.append('set-cookie', setCookie);
  return new Response(JSON.stringify(data), { status, headers: h });
}

function redirect(location: string, setCookie?: string): Response {
  const h = new Headers({ location, 'cache-control': 'no-store' });
  if (setCookie) h.append('set-cookie', setCookie);
  return new Response(null, { status: 302, headers: h });
}

const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Signed, expiring, user-bound state; also set as an HttpOnly cookie (double submit). */
export async function signExtState(secret: string, user: string, now: number): Promise<string> {
  const payload = b64({ u: user, exp: now + STATE_TTL_MS, n: crypto.randomUUID() });
  return `${payload}.${await hmacSign(secret, `extstate|${payload}`)}`;
}

export async function verifyExtState(secret: string, state: string, cookieState: string | undefined, user: string, now: number): Promise<boolean> {
  if (!state || !cookieState || state !== cookieState) return false;
  const dot = state.indexOf('.');
  if (dot <= 0) return false;
  const payload = state.slice(0, dot);
  if (!(await hmacVerify(secret, `extstate|${payload}`, state.slice(dot + 1)))) return false;
  try {
    const s = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as { u: string; exp: number };
    return s.u === user && typeof s.exp === 'number' && s.exp >= now;
  } catch {
    return false;
  }
}

const redirectUri = (origin: string) => `${origin}/api/integrations/google/callback`;
const clearState = () => serializeCookie(EXT_STATE_COOKIE, '', { maxAgeSeconds: 0, httpOnly: true, path: '/api/integrations' });

async function body(request: Request): Promise<Record<string, unknown>> {
  try { const b = await request.json(); return b && typeof b === 'object' ? b as Record<string, unknown> : {}; } catch { return {}; }
}

/** Returns null when the path is not an integrations route. */
export async function integrationsApi(
  request: Request, env: ExtEnv, url: URL, user: string, fetchFn: FetchFn = (...a) => fetch(...a),
): Promise<Response | null> {
  const path = url.pathname;
  if (!path.startsWith('/api/integrations')) return null;
  const m = request.method;
  const now = Date.now();

  try {
    await env.DB.prepare('SELECT 1 FROM ext_credentials LIMIT 1').first();
  } catch {
    return json({ error: 'integrations are not installed: apply database migration 0028' }, 503);
  }

  if (path === '/api/integrations' && m === 'GET') return json(await overview(env, user));

  if (path === '/api/integrations/google/start' && m === 'GET') {
    const client = googleClient(env);
    if (!client || !env.HMAC_KEY) return redirect('/integrations.html?error=google_not_configured');
    const state = await signExtState(env.HMAC_KEY, user, now);
    return redirect(googleAuthUrl(client, redirectUri(url.origin), state),
      serializeCookie(EXT_STATE_COOKIE, state, { maxAgeSeconds: STATE_TTL_MS / 1000, httpOnly: true, sameSite: 'Lax', path: '/api/integrations' }));
  }

  if (path === '/api/integrations/google/callback' && m === 'GET') {
    const client = googleClient(env);
    if (!client || !env.HMAC_KEY) return redirect('/integrations.html?error=google_not_configured', clearState());
    if (url.searchParams.get('error')) return redirect('/integrations.html?error=google_denied', clearState());
    const code = url.searchParams.get('code') ?? '';
    const state = url.searchParams.get('state') ?? '';
    const cookieState = parseCookies(request.headers.get('cookie'))[EXT_STATE_COOKIE];
    if (!code || !(await verifyExtState(env.HMAC_KEY, state, cookieState, user, now))) {
      return redirect('/integrations.html?error=bad_state', clearState());
    }
    try {
      const tok = await exchangeGoogleCode(fetchFn, client, code, redirectUri(url.origin));
      if (!tok.refresh_token) return redirect('/integrations.html?error=no_refresh_token', clearState());
      const email = await googleEmail(fetchFn, tok.access_token);
      await saveCredential(env, 'google', user, { refresh_token: tok.refresh_token }, email, tok.scope ?? null, now);
      return redirect('/integrations.html?connected=google', clearState());
    } catch (e) {
      console.error('google integration callback failed', e instanceof Error ? e.message : e);
      return redirect('/integrations.html?error=token_exchange', clearState());
    }
  }

  if (path === '/api/integrations/google/disconnect' && m === 'POST') {
    try {
      const cred = await loadCredential<GoogleCredential>(env, 'google');
      if (cred) await revokeGoogleToken(fetchFn, cred.refresh_token);
    } catch { /* undecryptable → just delete */ }
    await deleteCredential(env.DB, 'google');
    return json({ ok: true });
  }

  if (path === '/api/integrations/adsterra' && m === 'PUT') {
    const b = await body(request);
    const token = String(b.token ?? '').trim();
    if (!token || token.length > 200 || /\s/.test(token)) return json({ error: 'invalid token' }, 400);
    let domains = 0;
    try {
      domains = (await adsterraDomains(fetchFn, token)).length;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return json({ error: `Adsterra rejected the token: ${msg}` }, 400);
    }
    await saveCredential(env, 'adsterra', user, { token }, `${token.slice(0, 4)}…${token.slice(-2)}`, null, now);
    return json({ ok: true, domains });
  }
  if (path === '/api/integrations/adsterra' && m === 'DELETE') {
    await deleteCredential(env.DB, 'adsterra');
    return json({ ok: true });
  }

  if (path === '/api/integrations/sync' && m === 'POST') {
    const b = await body(request);
    const src = b.source ? String(b.source) : null;
    if (src && !(SOURCES as string[]).includes(src)) return json({ error: 'unknown source' }, 400);
    const result = await runExternalSync(env, { mode: 'manual', fetchFn, sources: src ? [src as Source] : undefined, budget: 150 });
    return json({ ok: true, result, ...(await overview(env, user)) });
  }

  if (path === '/api/integrations/mapping' && m === 'PUT') {
    const b = await body(request);
    const source = String(b.source ?? '');
    const propertyId = String(b.property_id ?? '');
    const mode = String(b.mode ?? (b.site_id ? 'manual' : 'ignored'));
    if (!(SOURCES as string[]).includes(source) || !propertyId) return json({ error: 'source and property_id required' }, 400);
    if (!['auto', 'manual', 'ignored'].includes(mode)) return json({ error: 'invalid mode' }, 400);
    let siteId: string | null = b.site_id ? String(b.site_id) : null;
    if (mode === 'manual') {
      if (!siteId) return json({ error: 'site_id required for a manual mapping' }, 400);
      const own = await env.DB.prepare('SELECT 1 AS ok FROM sites WHERE site_id = ? AND owner_id = ?').bind(siteId, user).first();
      if (!own) return json({ error: 'not your site' }, 403);
    }
    if (mode === 'auto') siteId = null; // re-derived on the next sync
    const ok = await setMapping(env.DB, source as Source, propertyId, mode as 'auto' | 'manual' | 'ignored', siteId);
    if (!ok) return json({ error: 'no such property' }, 404);
    return json({ ok: true });
  }

  if (path === '/api/integrations/settings' && m === 'POST') {
    const b = await body(request);
    const n = parseInt(String(b.no_revenue_min_uv ?? ''), 10);
    if (!Number.isFinite(n) || n < 1 || n > 1_000_000) return json({ error: 'no_revenue_min_uv must be 1–1000000' }, 400);
    await env.DB.prepare(`INSERT INTO instance_settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .bind(NO_REVENUE_MIN_UV_KEY, String(n), now).run();
    return json({ ok: true, no_revenue_min_uv: n });
  }

  if (path === '/api/integrations/google/test' && m === 'POST') {
    // explicit credential check (refresh only) for the "test" button
    try {
      const cred = await loadCredential<GoogleCredential>(env, 'google');
      const client = googleClient(env);
      if (!cred || !client) return json({ ok: false, error: 'not connected' }, 400);
      await refreshGoogleToken(fetchFn, client, cred.refresh_token);
      return json({ ok: true });
    } catch (e) {
      return json({ ok: false, error: e instanceof Error ? e.message : String(e), reauth: e instanceof ExtError && e.kind === 'auth' }, 400);
    }
  }

  return json({ error: 'not found' }, 404);
}

async function overview(env: ExtEnv, user: string) {
  const [creds, statuses, props, sites, minUv] = await Promise.all([
    credentialRows(env.DB), syncStatuses(env.DB), properties(env.DB),
    env.DB.prepare("SELECT site_id, name, allowed_domains FROM sites WHERE owner_id = ? AND status = 'active' AND name != '__pvuv_selftest' ORDER BY name")
      .bind(user).all<{ site_id: string; name: string; allowed_domains: string }>(),
    noRevenueMinUv(env.DB),
  ]);
  const cred = (p: string) => creds.find((c) => c.provider === p) ?? null;
  const g = cred('google');
  const a = cred('adsterra');
  return {
    google: {
      configured: !!(googleClient(env) && env.HMAC_KEY),
      connected: !!g, account: g?.account_label ?? null, scopes: g?.scopes ? g.scopes.split(' ') : [],
      connected_at: g?.created_at ?? null, updated_at: g?.updated_at ?? null,
    },
    adsterra: { connected: !!a, token_hint: a?.account_label ?? null, connected_at: a?.created_at ?? null },
    sources: SOURCES.map((s) => {
      const st = statuses.find((x) => x.source === s);
      return {
        source: s,
        connected: s === 'ads_txt' ? true : s === 'adsterra' ? !!a : !!g,
        last_run_at: st?.last_run_at ?? null, last_ok_at: st?.last_ok_at ?? null, last_error: st?.last_error ?? null,
        error_count: st?.error_count ?? 0, backoff_until: st?.backoff_until ?? null, stats: st?.stats ?? null,
        properties: props.filter((p) => p.source === s).length,
        mapped: props.filter((p) => p.source === s && p.site_id).length,
      };
    }),
    properties: props.map((p) => {
      let detail: unknown = null;
      try { detail = p.detail ? JSON.parse(p.detail) : null; } catch { /* keep null */ }
      return { ...p, detail };
    }),
    sites: sites.results.map((s) => ({ site_id: s.site_id, name: s.name, domains: parseDomains(s.allowed_domains) })),
    settings: { no_revenue_min_uv: minUv },
  };
}
