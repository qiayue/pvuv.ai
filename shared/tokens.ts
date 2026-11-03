/**
 * Personal API tokens (PROJECT_PLAN.md §10) — shared by the console (which
 * mints and revokes them) and the API worker (which authenticates with them).
 *
 * Design notes:
 *  - The plaintext is generated from the CSPRNG and shown to the owner exactly
 *    once. Only HMAC(HMAC_KEY, plaintext) is stored, so a database leak does not
 *    hand over working credentials.
 *  - Lookup is BY the hash, so authentication is a single indexed point read and
 *    involves no string comparison of secrets in application code.
 *  - The `pvuv_` prefix makes tokens recognisable to secret scanners (GitHub
 *    push protection and similar) if one is ever committed by accident.
 */

import { hmacSign } from './ids';

export const TOKEN_PREFIX = 'pvuv_';
/** Bytes of entropy behind each token (→ 43 base64url chars). */
const TOKEN_BYTES = 32;
/** How much of the plaintext is stored for display, after the prefix. */
const DISPLAY_CHARS = 6;

export interface ApiToken {
  token_id: string;
  owner_id: string;
  name: string;
  prefix: string;
  site_id: string | null;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Mint a new token. Returns the plaintext (show once, never stored) plus the
 *  row fields to persist. */
export async function createToken(hmacKey: string, ownerId: string, name: string, siteId: string | null): Promise<{
  plaintext: string;
  row: { token_id: string; owner_id: string; name: string; token_hash: string; prefix: string; site_id: string | null; created_at: number };
}> {
  const secret = b64url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
  const plaintext = TOKEN_PREFIX + secret;
  const token_hash = await hashToken(hmacKey, plaintext);
  return {
    plaintext,
    row: {
      token_id: b64url(crypto.getRandomValues(new Uint8Array(9))),
      owner_id: ownerId,
      name: name.slice(0, 60) || 'token',
      token_hash,
      prefix: TOKEN_PREFIX + secret.slice(0, DISPLAY_CHARS),
      site_id: siteId,
      created_at: Date.now(),
    },
  };
}

export function hashToken(hmacKey: string, plaintext: string): Promise<string> {
  return hmacSign(hmacKey, `apitoken:${plaintext}`);
}

/** Extract a bearer token from the request, accepting the conventional header
 *  plus an `X-API-Key` alias (simpler for curl / spreadsheet / no-code tools). */
export function bearerFrom(request: Request): string | null {
  const auth = request.headers.get('authorization');
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim() || null;
  const alt = request.headers.get('x-api-key');
  return alt?.trim() || null;
}

export function looksLikeApiToken(token: string): boolean {
  return token.startsWith(TOKEN_PREFIX);
}
