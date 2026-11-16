/**
 * D1 access for integrations: encrypted credentials, per-source sync status
 * (with quota backoff), property upserts that respect manual mappings, and
 * small settings. Shared by the console worker (connect / map / sync now) and
 * the cron worker (scheduled sync).
 */

import { encryptSecret, decryptSecret } from './crypto';
import type { GoogleClient } from './google';

export type Provider = 'google' | 'adsterra';
export type Source = 'adsense' | 'gsc' | 'adsterra' | 'ads_txt';
export const SOURCES: Source[] = ['adsense', 'gsc', 'adsterra', 'ads_txt'];
export const SOURCE_PROVIDER: Record<Source, Provider | null> = { adsense: 'google', gsc: 'google', adsterra: 'adsterra', ads_txt: null };

/** The env subset integrations need. Every field but DB is optional so the
 *  console and cron Env types both satisfy it; absence = "not configured". */
export interface ExtEnv {
  DB: D1Database;
  HMAC_KEY?: string;
  /** Optional dedicated OAuth client for integrations; falls back to the login client. */
  EXT_GOOGLE_CLIENT_ID?: string;
  EXT_GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
}

export function googleClient(env: ExtEnv): GoogleClient | null {
  const id = env.EXT_GOOGLE_CLIENT_ID || env.GOOGLE_CLIENT_ID;
  const secret = env.EXT_GOOGLE_CLIENT_ID ? env.EXT_GOOGLE_CLIENT_SECRET : env.GOOGLE_CLIENT_SECRET;
  return id && secret ? { clientId: id, clientSecret: secret } : null;
}

export interface GoogleCredential { refresh_token: string }
export interface AdsterraCredential { token: string }

export interface CredentialRow { provider: Provider; owner_id: string; account_label: string | null; scopes: string | null; created_at: number; updated_at: number }

export async function saveCredential(
  env: ExtEnv, provider: Provider, owner: string, value: GoogleCredential | AdsterraCredential,
  label: string | null, scopes: string | null, now = Date.now(),
): Promise<void> {
  if (!env.HMAC_KEY) throw new Error('HMAC_KEY is not set');
  const ct = await encryptSecret(env.HMAC_KEY, provider, value);
  await env.DB.prepare(`
    INSERT INTO ext_credentials (provider, owner_id, ciphertext, account_label, scopes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider) DO UPDATE SET owner_id = excluded.owner_id, ciphertext = excluded.ciphertext,
      account_label = excluded.account_label, scopes = excluded.scopes, updated_at = excluded.updated_at
  `).bind(provider, owner, ct, label, scopes, now, now).run();
}

/** Decrypted credential, or null when none is stored. Throws when one is
 *  stored but cannot be decrypted (HMAC_KEY rotated / missing). */
export async function loadCredential<T>(env: ExtEnv, provider: Provider): Promise<T | null> {
  const row = await env.DB.prepare('SELECT ciphertext FROM ext_credentials WHERE provider = ?')
    .bind(provider).first<{ ciphertext: string }>();
  if (!row) return null;
  if (!env.HMAC_KEY) throw new Error('HMAC_KEY is not set on this worker — cannot decrypt the stored credential');
  try {
    return await decryptSecret<T>(env.HMAC_KEY, provider, row.ciphertext);
  } catch {
    throw new Error('stored credential cannot be decrypted (was HMAC_KEY changed?) — reconnect');
  }
}

export async function credentialRows(db: D1Database): Promise<CredentialRow[]> {
  const r = await db.prepare('SELECT provider, owner_id, account_label, scopes, created_at, updated_at FROM ext_credentials')
    .all<CredentialRow>();
  return r.results;
}

export async function deleteCredential(db: D1Database, provider: Provider): Promise<void> {
  await db.prepare('DELETE FROM ext_credentials WHERE provider = ?').bind(provider).run();
  // a disconnected source has nothing to back off from
  const sources = SOURCES.filter((s) => SOURCE_PROVIDER[s] === provider);
  for (const s of sources) {
    await db.prepare('UPDATE ext_sync_status SET backoff_until = NULL, error_count = 0, last_error = NULL WHERE source = ?').bind(s).run();
  }
}

// ---------------------------------------------------------------------------
// sync status
// ---------------------------------------------------------------------------

export interface SyncStatus {
  source: Source; last_run_at: number | null; last_ok_at: number | null; last_error: string | null;
  error_count: number; backoff_until: number | null; stats: Record<string, unknown> | null;
}

export async function syncStatuses(db: D1Database): Promise<SyncStatus[]> {
  const r = await db.prepare('SELECT source, last_run_at, last_ok_at, last_error, error_count, backoff_until, stats FROM ext_sync_status')
    .all<Omit<SyncStatus, 'stats'> & { stats: string | null }>();
  return r.results.map((x) => {
    let stats: Record<string, unknown> | null = null;
    try { stats = x.stats ? JSON.parse(x.stats) : null; } catch { /* keep null */ }
    return { ...x, stats };
  });
}

export async function getStatus(db: D1Database, source: Source): Promise<SyncStatus | null> {
  return (await syncStatuses(db)).find((s) => s.source === source) ?? null;
}

const HOUR = 3600e3;

/** Record a run. `quota` errors back off exponentially (1 h, 2 h, 4 h … ≤ 24 h). */
export async function recordRun(
  db: D1Database, source: Source, now: number,
  outcome: { ok: true; stats?: Record<string, unknown> } | { ok: false; error: string; quota?: boolean; stats?: Record<string, unknown> },
): Promise<void> {
  const prev = await getStatus(db, source);
  if (outcome.ok) {
    await db.prepare(`
      INSERT INTO ext_sync_status (source, last_run_at, last_ok_at, last_error, error_count, backoff_until, stats)
      VALUES (?, ?, ?, NULL, 0, NULL, ?)
      ON CONFLICT(source) DO UPDATE SET last_run_at = excluded.last_run_at, last_ok_at = excluded.last_ok_at,
        last_error = NULL, error_count = 0, backoff_until = NULL, stats = excluded.stats
    `).bind(source, now, now, JSON.stringify(outcome.stats ?? prev?.stats ?? {})).run();
    return;
  }
  const count = (prev?.error_count ?? 0) + 1;
  const backoff = outcome.quota ? now + Math.min(2 ** (count - 1), 24) * HOUR : null;
  await db.prepare(`
    INSERT INTO ext_sync_status (source, last_run_at, last_ok_at, last_error, error_count, backoff_until, stats)
    VALUES (?, ?, NULL, ?, ?, ?, ?)
    ON CONFLICT(source) DO UPDATE SET last_run_at = excluded.last_run_at, last_error = excluded.last_error,
      error_count = excluded.error_count, backoff_until = excluded.backoff_until,
      stats = COALESCE(excluded.stats, ext_sync_status.stats)
  `).bind(source, now, outcome.error.slice(0, 500), count, backoff, outcome.stats ? JSON.stringify(outcome.stats) : null).run();
}

// ---------------------------------------------------------------------------
// properties + daily rows
// ---------------------------------------------------------------------------

export interface PropertyUpsert {
  source: Source; property_id: string; label: string; domain: string; site_id: string | null;
  state?: string | null; detail?: Record<string, unknown> | null; ads_txt?: string | null;
  indexed_pages?: number | null; error?: string | null;
  /** false = listing only, do not mark the property as refreshed (default true) */
  touch?: boolean;
}

/** Upsert a property. The auto-mapped site is applied only while the mapping
 *  is 'auto' — a manual override or 'ignored' always survives a re-sync. */
export function propertyUpsertStmt(db: D1Database, p: PropertyUpsert, now: number): D1PreparedStatement {
  return db.prepare(`
    INSERT INTO ext_properties (source, property_id, label, domain, site_id, mapping, state, ads_txt, indexed_pages, detail, error, checked_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'auto', ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source, property_id) DO UPDATE SET
      label = excluded.label, domain = excluded.domain,
      site_id = CASE WHEN ext_properties.mapping = 'auto' THEN excluded.site_id ELSE ext_properties.site_id END,
      state = COALESCE(excluded.state, ext_properties.state),
      ads_txt = COALESCE(excluded.ads_txt, ext_properties.ads_txt),
      indexed_pages = COALESCE(excluded.indexed_pages, ext_properties.indexed_pages),
      detail = COALESCE(excluded.detail, ext_properties.detail),
      error = excluded.error,
      checked_at = CASE WHEN excluded.error IS NULL AND excluded.checked_at IS NOT NULL THEN excluded.checked_at ELSE ext_properties.checked_at END,
      updated_at = excluded.updated_at
  `).bind(
    p.source, p.property_id, p.label, p.domain, p.site_id, p.state ?? null, p.ads_txt ?? null,
    p.indexed_pages ?? null, p.detail ? JSON.stringify(p.detail) : null, p.error ?? null,
    p.error || p.touch === false ? null : now, now,
  );
}

export interface PropertyRow {
  source: Source; property_id: string; label: string | null; domain: string | null; site_id: string | null;
  mapping: 'auto' | 'manual' | 'ignored'; state: string | null; ads_txt: string | null; indexed_pages: number | null;
  detail: string | null; error: string | null; checked_at: number | null; updated_at: number | null;
}

export async function properties(db: D1Database, source?: Source): Promise<PropertyRow[]> {
  const r = source
    ? await db.prepare('SELECT * FROM ext_properties WHERE source = ? ORDER BY label').bind(source).all<PropertyRow>()
    : await db.prepare('SELECT * FROM ext_properties ORDER BY source, label').all<PropertyRow>();
  return r.results;
}

export interface DailyUpsert {
  source: Source; property_id: string; day: string; site_id: string | null;
  impressions: number; clicks: number; pageviews?: number | null;
  revenue?: number | null; currency?: string | null; revenue_usd?: number | null; position?: number | null;
}

/** Idempotent: a day re-pulled replaces its previous figures. */
export function dailyUpsertStmt(db: D1Database, d: DailyUpsert, now: number): D1PreparedStatement {
  return db.prepare(`
    INSERT INTO ext_daily (source, property_id, day, site_id, impressions, clicks, pageviews, revenue, currency, revenue_usd, position, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source, property_id, day) DO UPDATE SET
      site_id = excluded.site_id, impressions = excluded.impressions, clicks = excluded.clicks,
      pageviews = excluded.pageviews, revenue = excluded.revenue, currency = excluded.currency,
      revenue_usd = excluded.revenue_usd, position = excluded.position, updated_at = excluded.updated_at
  `).bind(
    d.source, d.property_id, d.day, d.site_id, d.impressions, d.clicks, d.pageviews ?? null,
    d.revenue ?? null, d.currency ?? null, d.revenue_usd ?? null, d.position ?? null, now,
  );
}

/** Set a property's mapping and re-stamp its daily rows so totals move with it. */
export async function setMapping(
  db: D1Database, source: Source, propertyId: string, mode: 'auto' | 'manual' | 'ignored', siteId: string | null,
): Promise<boolean> {
  const sid = mode === 'ignored' ? null : siteId;
  const r = await db.prepare('UPDATE ext_properties SET mapping = ?, site_id = ?, updated_at = ? WHERE source = ? AND property_id = ?')
    .bind(mode, sid, Date.now(), source, propertyId).run();
  if (!(r.meta.changes ?? 0)) return false;
  await db.prepare('UPDATE ext_daily SET site_id = ? WHERE source = ? AND property_id = ?').bind(sid, source, propertyId).run();
  return true;
}

/** Run D1 statements in chunks (D1 batches are capped). */
export async function runBatched(db: D1Database, stmts: D1PreparedStatement[], size = 50): Promise<void> {
  for (let i = 0; i < stmts.length; i += size) await db.batch(stmts.slice(i, i + size));
}

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

export const NO_REVENUE_MIN_UV_KEY = 'ext_no_revenue_min_uv';
export const NO_REVENUE_MIN_UV_DEFAULT = 200;

export async function noRevenueMinUv(db: D1Database): Promise<number> {
  try {
    const r = await db.prepare('SELECT value FROM instance_settings WHERE key = ?').bind(NO_REVENUE_MIN_UV_KEY).first<{ value: string }>();
    const n = parseInt(r?.value ?? '', 10);
    return Number.isFinite(n) && n > 0 ? n : NO_REVENUE_MIN_UV_DEFAULT;
  } catch {
    return NO_REVENUE_MIN_UV_DEFAULT;
  }
}
