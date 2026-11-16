/**
 * Encryption at rest for integration credentials (Google refresh token,
 * Adsterra API token).
 *
 * AES-256-GCM with a key derived from the deployment's existing HMAC_KEY secret
 * via HKDF-SHA-256 (fixed salt + purpose-specific info), so no extra secret has
 * to be provisioned and the derived key is useless for anything else. Each
 * value is bound to its provider name as additional authenticated data: a
 * ciphertext copied from the `adsterra` row into the `google` row fails to
 * decrypt instead of being used as the wrong credential.
 *
 * Format: `v1.<iv b64url>.<ciphertext+tag b64url>`. WebCrypto only.
 *
 * Rotating HMAC_KEY makes stored credentials undecryptable — the console then
 * shows "reconnect" (decrypt fails closed, never returns garbage).
 */

const SALT = new TextEncoder().encode('pvuv.ai/ext-credentials/v1');
const INFO = new TextEncoder().encode('aes-gcm-256 credential encryption');

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveKey(secret: string): Promise<CryptoKey> {
  if (!secret) throw new Error('HMAC_KEY is not set');
  const ikm = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: SALT, info: INFO },
    ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

/** Encrypt a JSON-serializable value, bound to `aad` (the provider name). */
export async function encryptSecret(secret: string, aad: string, value: unknown): Promise<string> {
  const key = await deriveKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(aad) },
    key, new TextEncoder().encode(JSON.stringify(value)),
  );
  return `v1.${b64url(iv)}.${b64url(new Uint8Array(ct))}`;
}

/** Decrypt; throws on any tampering, wrong key or wrong `aad`. */
export async function decryptSecret<T = unknown>(secret: string, aad: string, blob: string): Promise<T> {
  const parts = blob.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') throw new Error('unknown credential format');
  const key = await deriveKey(secret);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64urlDecode(parts[1]), additionalData: new TextEncoder().encode(aad) },
    key, b64urlDecode(parts[2]),
  );
  return JSON.parse(new TextDecoder().decode(pt)) as T;
}
