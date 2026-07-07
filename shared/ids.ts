/**
 * ID generation / cookies / HMAC — PROJECT_PLAN.md §3 (identity system).
 *
 * Runs in both Cloudflare Workers and the browser SDK bundle (WebCrypto
 * only, no Node APIs). Secrets are NEVER in code: the HMAC key arrives via
 * `wrangler secret put HMAC_KEY` and is passed in as a parameter.
 */

import type { Verdict } from './flags';

// ---------------------------------------------------------------------------
// Cookie names & identity-system constants (§3)
// ---------------------------------------------------------------------------

export const COOKIE = {
  /** visitor_id, first-party, domain=.example.com, 13-month lifetime */
  VISITOR: '_pv_id',
  /** session_id + last-active timestamp */
  SESSION: '_pv_sid',
  /** first-touch attribution snapshot, never overwritten */
  FIRST_TOUCH: '_pv_ft',
  /** HMAC-signed verdict state, read by /v for re-checks */
  VERDICT: '_pv_v',
} as const;

/** visitor_id cookie lifetime: 13 months (§3). */
export const VISITOR_TTL_DAYS = 13 * 30 + 6; // 396
/** A new session starts after 30 min of inactivity (§3). */
export const SESSION_IDLE_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

/** visitor_id / session_id: UUID v4 (§3). */
export function uuid(): string {
  return crypto.randomUUID();
}

/**
 * site_id: 8-char random string (§3), unambiguous alphabet (no 0/O/1/l/I)
 * to keep embed snippets copy-safe. ~47 bits of entropy.
 */
const SITE_ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

export function generateSiteId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < 8; i++) out += SITE_ID_ALPHABET[bytes[i] % SITE_ID_ALPHABET.length];
  return out;
}

// ---------------------------------------------------------------------------
// Cookie parsing / serialization (header-level helpers for workers;
// the SDK sets cookies via document.cookie with the same names)
// ---------------------------------------------------------------------------

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k) out[k] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

export function serializeCookie(
  name: string,
  value: string,
  opts: {
    maxAgeSeconds?: number;
    domain?: string;
    path?: string;
    sameSite?: 'Lax' | 'Strict' | 'None';
    secure?: boolean;
    httpOnly?: boolean;
  } = {},
): string {
  let s = `${name}=${encodeURIComponent(value)}`;
  s += `; Path=${opts.path ?? '/'}`;
  if (opts.maxAgeSeconds !== undefined) s += `; Max-Age=${Math.floor(opts.maxAgeSeconds)}`;
  if (opts.domain) s += `; Domain=${opts.domain}`;
  s += `; SameSite=${opts.sameSite ?? 'Lax'}`;
  if (opts.secure !== false) s += '; Secure';
  if (opts.httpOnly) s += '; HttpOnly';
  return s;
}

// ---------------------------------------------------------------------------
// HMAC (WebCrypto, SHA-256) — signs the _pv_v verdict-state cookie (§3, §8)
// ---------------------------------------------------------------------------

function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const enc = new TextEncoder();

async function importHmacKey(secret: string, usages: ('sign' | 'verify')[]): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, usages);
}

/** HMAC-SHA256(secret, payload) → base64url signature. */
export async function hmacSign(secret: string, payload: string): Promise<string> {
  const key = await importHmacKey(secret, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  return b64url(new Uint8Array(sig));
}

/** Timing-safe verify via crypto.subtle.verify. */
export async function hmacVerify(secret: string, payload: string, signature: string): Promise<boolean> {
  const key = await importHmacKey(secret, ['verify']);
  let sig: Uint8Array;
  try {
    sig = b64urlDecode(signature);
  } catch {
    return false;
  }
  return crypto.subtle.verify('HMAC', key, sig, enc.encode(payload));
}

// ---------------------------------------------------------------------------
// Verdict-state cookie _pv_v (§3): tamper-proof client-held state used by /v
// for progressive re-checks (§7.2). Format: base64url(JSON) + "." + signature
// ---------------------------------------------------------------------------

export interface VerdictState {
  /** current verdict */
  v: Verdict;
  /** pages seen this session */
  p: number;
  /** whether any human interaction occurred (0/1) */
  i: 0 | 1;
  /** previous-page dwell, ms */
  d: number;
  /** unix ms when this state was signed */
  ts: number;
}

export async function signVerdictState(secret: string, state: VerdictState): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify(state)));
  const sig = await hmacSign(secret, payload);
  return `${payload}.${sig}`;
}

/** Returns the state if the signature checks out, otherwise null. */
export async function verifyVerdictState(secret: string, cookieValue: string): Promise<VerdictState | null> {
  const dot = cookieValue.indexOf('.');
  if (dot <= 0) return null;
  const payload = cookieValue.slice(0, dot);
  const sig = cookieValue.slice(dot + 1);
  if (!(await hmacVerify(secret, payload, sig))) return null;
  try {
    const state = JSON.parse(new TextDecoder().decode(b64urlDecode(payload))) as VerdictState;
    if (typeof state.v !== 'string' || typeof state.p !== 'number' || typeof state.ts !== 'number') return null;
    return state;
  } catch {
    return null;
  }
}
