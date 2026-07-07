/**
 * Google / GitHub OAuth login for the console (authorization-code flow).
 *
 * A provider is only offered when both its client id (var) and client secret
 * (wrangler secret) are configured. Identity is keyed on the provider-verified
 * email; the caller gates which emails may sign in (ADMIN_EMAILS) — OAuth is
 * authentication, not open registration.
 *
 * Secrets (never in files):
 *   GOOGLE_CLIENT_SECRET, GITHUB_CLIENT_SECRET   (wrangler secret put)
 * Vars (workers/console/wrangler.toml [vars]):
 *   GOOGLE_CLIENT_ID, GITHUB_CLIENT_ID
 */

import { hmacSign, hmacVerify, serializeCookie, parseCookies } from '../../../shared/ids';

export type Provider = 'google' | 'github';

export interface OAuthEnv {
  HMAC_KEY: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
}

export interface Identity {
  email: string;
  name: string | null;
}

const STATE_COOKIE = '_pvc_oauth';
const STATE_TTL_MS = 10 * 60 * 1000;

const PROVIDERS = {
  google: {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    userinfo: 'https://openidconnect.googleapis.com/v1/userinfo',
    scope: 'openid email profile',
  },
  github: {
    authorize: 'https://github.com/login/oauth/authorize',
    token: 'https://github.com/login/oauth/access_token',
    userinfo: 'https://api.github.com/user',
    scope: 'read:user user:email',
  },
} as const;

export function isProvider(p: string): p is Provider {
  return p === 'google' || p === 'github';
}

function clientId(env: OAuthEnv, p: Provider): string | undefined {
  return p === 'google' ? env.GOOGLE_CLIENT_ID : env.GITHUB_CLIENT_ID;
}
function clientSecret(env: OAuthEnv, p: Provider): string | undefined {
  return p === 'google' ? env.GOOGLE_CLIENT_SECRET : env.GITHUB_CLIENT_SECRET;
}

/** Which providers are fully configured (both id + secret). */
export function configuredProviders(env: OAuthEnv): Provider[] {
  return (['google', 'github'] as Provider[]).filter((p) => clientId(env, p) && clientSecret(env, p));
}

function redirectUri(origin: string, p: Provider): string {
  return `${origin}/api/auth/${p}/callback`;
}

// --- signed state (CSRF) ---------------------------------------------------

function b64urlJson(obj: unknown): string {
  return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function signState(secret: string, p: Provider, now: number): Promise<string> {
  // nonce derived from HMAC of (provider|exp) — no RNG needed and still
  // unguessable without the key; exp bounds replay
  const exp = now + STATE_TTL_MS;
  const payload = b64urlJson({ p, exp });
  const sig = await hmacSign(secret, `state|${payload}`);
  return `${payload}.${sig}`;
}

async function verifyState(secret: string, state: string, p: Provider, now: number): Promise<boolean> {
  const dot = state.indexOf('.');
  if (dot <= 0) return false;
  const payload = state.slice(0, dot);
  if (!(await hmacVerify(secret, `state|${payload}`, state.slice(dot + 1)))) return false;
  try {
    const s = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as { p: string; exp: number };
    return s.p === p && typeof s.exp === 'number' && s.exp >= now;
  } catch {
    return false;
  }
}

// --- start: redirect the browser to the provider ---------------------------

export async function oauthStart(env: OAuthEnv, p: Provider, origin: string, now: number): Promise<Response> {
  const cid = clientId(env, p);
  if (!cid || !clientSecret(env, p)) return new Response('provider not configured', { status: 404 });

  const state = await signState(env.HMAC_KEY, p, now);
  const cfg = PROVIDERS[p];
  const params = new URLSearchParams({
    client_id: cid,
    redirect_uri: redirectUri(origin, p),
    response_type: 'code',
    scope: cfg.scope,
    state,
  });
  if (p === 'google') params.set('access_type', 'online');

  return new Response(null, {
    status: 302,
    headers: {
      location: `${cfg.authorize}?${params.toString()}`,
      // bind state to this browser (double-submit) — verified on callback
      'set-cookie': serializeCookie(STATE_COOKIE, state, { maxAgeSeconds: STATE_TTL_MS / 1000, httpOnly: true, sameSite: 'Lax' }),
    },
  });
}

// --- callback: verify state, exchange code, fetch verified identity --------

export class OAuthError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

export async function oauthCallback(
  env: OAuthEnv, p: Provider, url: URL, request: Request, now: number,
  fetchFn: typeof fetch = fetch,
): Promise<Identity> {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) throw new OAuthError('bad_request', 'missing code/state');

  const cookieState = parseCookies(request.headers.get('cookie'))[STATE_COOKIE];
  if (!cookieState || cookieState !== state) throw new OAuthError('bad_state', 'state cookie mismatch');
  if (!(await verifyState(env.HMAC_KEY, state, p, now))) throw new OAuthError('bad_state', 'state invalid/expired');

  const origin = url.origin;
  const token = await exchangeCode(env, p, code, redirectUri(origin, p), fetchFn);
  const identity = await fetchIdentity(p, token, fetchFn);
  if (!identity.email) throw new OAuthError('no_email', 'no verified email from provider');
  return identity;
}

async function exchangeCode(env: OAuthEnv, p: Provider, code: string, redirect: string, fetchFn: typeof fetch): Promise<string> {
  const cfg = PROVIDERS[p];
  const body = new URLSearchParams({
    client_id: clientId(env, p)!,
    client_secret: clientSecret(env, p)!,
    code,
    redirect_uri: redirect,
    grant_type: 'authorization_code',
  });
  const r = await fetchFn(cfg.token, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: body.toString(),
  });
  if (!r.ok) throw new OAuthError('token_exchange', `token exchange failed (${r.status})`);
  const data = await r.json() as { access_token?: string; error?: string };
  if (!data.access_token) throw new OAuthError('token_exchange', data.error || 'no access_token');
  return data.access_token;
}

async function fetchIdentity(p: Provider, token: string, fetchFn: typeof fetch): Promise<Identity> {
  const headers = { authorization: `Bearer ${token}`, accept: 'application/json', 'user-agent': 'pvuv.ai-console' };
  const r = await fetchFn(PROVIDERS[p].userinfo, { headers });
  if (!r.ok) throw new OAuthError('userinfo', `userinfo failed (${r.status})`);
  const u = await r.json() as Record<string, unknown>;

  if (p === 'google') {
    // Google only returns verified emails on the userinfo endpoint
    if (u.email_verified === false) throw new OAuthError('no_email', 'email not verified');
    return { email: String(u.email ?? '').toLowerCase(), name: (u.name as string) ?? null };
  }

  // GitHub: /user may not include a (verified, primary) email → fetch /user/emails
  let email = typeof u.email === 'string' ? u.email : '';
  if (!email) {
    const er = await fetchFn('https://api.github.com/user/emails', { headers });
    if (er.ok) {
      const emails = await er.json() as Array<{ email: string; primary: boolean; verified: boolean }>;
      const pick = emails.find((x) => x.primary && x.verified) ?? emails.find((x) => x.verified);
      email = pick?.email ?? '';
    }
  }
  if (!email) throw new OAuthError('no_email', 'no verified GitHub email');
  return { email: email.toLowerCase(), name: (u.name as string) ?? (u.login as string) ?? null };
}

export function clearStateCookie(): string {
  return serializeCookie(STATE_COOKIE, '', { maxAgeSeconds: 0, httpOnly: true });
}
