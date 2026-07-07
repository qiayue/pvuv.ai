/**
 * Console session verification, shared by the api worker (owner-scope reads,
 * §10) and the console worker (same-origin dashboard API). Lives outside the
 * worker entry module — workerd only allows handler exports there.
 */

import { hmacVerify, parseCookies } from '../../../shared/ids';

/** Console session cookie name. */
export const SESSION_COOKIE = '_pvc_s';

/** Verify the console-issued session cookie (b64url(JSON{u,exp}).sig) → user id. */
export async function verifySession(secret: string, cookieHeader: string | null): Promise<string | null> {
  const raw = parseCookies(cookieHeader)[SESSION_COOKIE];
  if (!raw) return null;
  const dot = raw.indexOf('.');
  if (dot <= 0) return null;
  const payload = raw.slice(0, dot);
  // domain-separated: must match the console signer's `session|` prefix
  if (!(await hmacVerify(secret, `session|${payload}`, raw.slice(dot + 1)))) return null;
  try {
    const s = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as { u: string; exp: number };
    if (typeof s.u !== 'string' || typeof s.exp !== 'number' || s.exp < Date.now()) return null;
    return s.u;
  } catch {
    return null;
  }
}
