/**
 * Site provisioning shared by the console (`POST /api/sites`) and the api
 * worker (`POST /v1/sites`, `PATCH /v1/sites/:id`). The two paths used to carry
 * their own copies of domain parsing, validation and the KV write-through and
 * had drifted apart; everything that decides what a site row looks like lives
 * here now so they cannot drift again.
 *
 *   - normalizeDomain   one parser for every hostname an owner types or posts
 *   - resolveSettings   timezone / engaged / ad-guard / adclient validation,
 *                       with template defaults underneath explicit values
 *   - insertSite        the INSERT (optionally race-safe deduped per owner +
 *                       domain) plus the KV write-through ingest reads
 *   - ensureFunnel      find-or-create a saved funnel by name
 *   - buildSnippet      the embed <script> tag, same format the console shows
 */

import { generateSiteId } from './ids';
import { isValidTimezone } from './tz';

// The slice of D1 / KV used here, typed structurally: shared/ is also compiled
// by the SDK's tsconfig, which has no Workers types. D1Database and
// KVNamespace satisfy these.
interface Stmt {
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}
type D1Database = { prepare(sql: string): { bind(...values: unknown[]): Stmt } };
type KVNamespace = { put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> };

export const ADGUARD_MODES = new Set(['off', 'loose', 'balanced', 'strict']);
/** Statuses a site can be put in. Ingest only accepts 'active'; anything else
 *  (the default for an archived site) stops collection without deleting data. */
export const SITE_STATUSES = new Set(['active', 'archived']);
export const ADCLIENT_RE = /^ca-pub-\d{6,20}$/;
/** Longest accepted funnel step value (a path or an event name). */
export const MAX_STEP_LENGTH = 512;

const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

/** Normalize one user-supplied domain to the bare lowercase hostname stored in
 *  `allowed_domains`: scheme, credentials, port, path, query and a trailing dot
 *  are dropped, and a Unicode name is converted to its IDNA `xn--` form (the
 *  hostname a browser sends in Origin). Returns null when what is left is not
 *  a plausible public hostname — IP literals included. `localhost` is accepted
 *  so a local `wrangler dev` setup can still register a site. */
export function normalizeDomain(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let s = raw.trim().toLowerCase();
  if (!s || s.length > 2048) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = 'http://' + s;
  let host: string;
  try { host = new URL(s).hostname; } catch { return null; }
  host = host.replace(/\.$/, '');
  if (host === 'localhost') return host;
  return HOST_RE.test(host) ? host : null;
}

/** Normalize a list, dropping duplicates. `invalid` lists what was rejected so
 *  each caller can decide between "skip it" (console) and "refuse" (api). */
export function normalizeDomains(raw: unknown): { domains: string[]; invalid: string[] } {
  const domains: string[] = [];
  const invalid: string[] = [];
  for (const d of Array.isArray(raw) ? raw : []) {
    const n = normalizeDomain(d);
    if (!n) { invalid.push(String(d)); continue; }
    if (!domains.includes(n)) domains.push(n);
  }
  return { domains, invalid };
}

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

export interface SiteSettings {
  timezone: string;
  engaged_seconds: number;
  adguard_mode: string;
  adclient: string | null;
}

/** Optional values a template carries; null = "not set, use the default". */
export interface SettingsDefaults {
  timezone?: string | null;
  engaged_seconds?: number | null;
  adguard_mode?: string | null;
  adclient?: string | null;
}

/** GA4 engagement dwell threshold: 1–300s, rounded. */
export function clampEngaged(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(Math.max(Math.round(n), 1), 300) : null;
}

/** Resolve a new site's settings: an explicit value in `body` wins, then the
 *  template, then the built-in default (owner timezone, 15s, ad-guard off, no
 *  adclient). The rules are the console's: IANA timezone (rejected when
 *  invalid), engaged clamped to 1–300, ad-guard mode from ADGUARD_MODES,
 *  adclient matching ca-pub-…. With `strict` an unknown ad-guard mode or a
 *  malformed adclient is an error; without it (the console form's historical
 *  behaviour) they quietly fall back to off / none. */
export function resolveSettings(
  body: Record<string, unknown>, template: SettingsDefaults | null, ownerTimezone: string, strict: boolean,
): { settings: SiteSettings } | { error: string } {
  const t = template ?? {};

  let timezone = typeof body.timezone === 'string' ? body.timezone.trim() : '';
  if (!timezone) timezone = t.timezone || ownerTimezone || 'UTC';
  if (!isValidTimezone(timezone)) return { error: `invalid timezone: ${timezone}` };

  let engaged = body.engaged_seconds !== undefined && body.engaged_seconds !== null ? clampEngaged(body.engaged_seconds) : null;
  if (engaged === null && strict && body.engaged_seconds !== undefined && body.engaged_seconds !== null) {
    return { error: 'engaged_seconds must be a number' };
  }
  if (engaged === null) engaged = t.engaged_seconds ?? 15;

  let mode: string;
  if (body.adguard_mode !== undefined && body.adguard_mode !== null && body.adguard_mode !== '') {
    if (typeof body.adguard_mode === 'string' && ADGUARD_MODES.has(body.adguard_mode)) mode = body.adguard_mode;
    else if (strict) return { error: 'invalid adguard_mode (off, loose, balanced, strict)' };
    else mode = 'off';
  } else mode = t.adguard_mode && ADGUARD_MODES.has(t.adguard_mode) ? t.adguard_mode : 'off';

  let adclient: string | null;
  if (body.adclient === undefined) adclient = t.adclient ?? null;
  else if (body.adclient === null || body.adclient === '') adclient = null; // explicit clear
  else if (typeof body.adclient === 'string' && ADCLIENT_RE.test(body.adclient.trim())) adclient = body.adclient.trim();
  else if (strict) return { error: 'invalid adclient (expected ca-pub-…)' };
  else adclient = null;

  return { settings: { timezone, engaged_seconds: engaged, adguard_mode: mode, adclient } };
}

// ---------------------------------------------------------------------------
// insert + KV write-through
// ---------------------------------------------------------------------------

export interface SiteRecord extends SiteSettings {
  site_id: string;
  name: string;
  domains: string[];
  status: string;
  shadow_until: number | null;
  created_at: number;
}

const SITE_COLUMNS = 'site_id, name, allowed_domains, adguard_mode, adclient, timezone, engaged_seconds, status, shadow_until, created_at';
type SiteRow = { site_id: string; name: string; allowed_domains: string; adguard_mode: string | null; adclient: string | null;
  timezone: string | null; engaged_seconds: number | null; status: string | null; shadow_until: number | null; created_at: number };

function toRecord(r: SiteRow): SiteRecord {
  let domains: string[] = [];
  try { const d = JSON.parse(r.allowed_domains); if (Array.isArray(d)) domains = d; } catch { /* malformed → none */ }
  return {
    site_id: r.site_id, name: r.name, domains, status: r.status || 'active',
    timezone: r.timezone || 'UTC', engaged_seconds: r.engaged_seconds ?? 15,
    adguard_mode: r.adguard_mode || 'off', adclient: r.adclient, shadow_until: r.shadow_until, created_at: r.created_at,
  };
}

export async function getSite(db: D1Database, siteId: string): Promise<(SiteRecord & { owner_id: string }) | null> {
  const r = await db.prepare(`SELECT owner_id, ${SITE_COLUMNS} FROM sites WHERE site_id = ?`).bind(siteId)
    .first<SiteRow & { owner_id: string }>();
  return r ? { ...toRecord(r), owner_id: r.owner_id } : null;
}

/** The owner's active site that already lists any of `domains`, if one exists
 *  (optionally ignoring one site — the one being edited). */
export async function findActiveSiteByDomain(db: D1Database, owner: string, domains: string[], exceptSiteId = ''): Promise<SiteRecord | null> {
  const r = await db.prepare(`SELECT ${SITE_COLUMNS} FROM sites WHERE owner_id = ? AND status = 'active' AND site_id != ?
      AND EXISTS (SELECT 1 FROM json_each(allowed_domains) WHERE value IN (SELECT value FROM json_each(?))) ORDER BY created_at LIMIT 1`)
    .bind(owner, exceptSiteId, JSON.stringify(domains)).first<SiteRow>();
  return r ? toRecord(r) : null;
}

/** Write-through so ingest sees a new site immediately (§5 whitelist). The
 *  shape must match the ingest worker's SiteConfig. */
export async function writeSiteConfig(kv: KVNamespace, s: SiteRecord): Promise<void> {
  await kv.put(`site:${s.site_id}`, JSON.stringify({
    site_id: s.site_id,
    allowed_domains: s.domains,
    adguard_mode: s.adguard_mode,
    adclient: s.adclient,
    status: s.status,
    shadow_until: s.shadow_until,
  }), { expirationTtl: 300 });
}

/** Insert a new site and write it through to KV.
 *
 *  With `dedupe`, the owner's active site already holding any of `domains` is
 *  returned instead (`created: false`). The existence check is repeated inside
 *  the INSERT itself (`INSERT … SELECT … WHERE NOT EXISTS`), so concurrent
 *  retries of the same request still produce exactly one row. Without
 *  `dedupe` (the console form) a site is always created. */
export async function insertSite(
  db: D1Database, kv: KVNamespace, owner: string,
  input: { name: string; domains: string[] } & SiteSettings,
  opts: { dedupe: boolean; shadowDays: number },
): Promise<{ created: boolean; site: SiteRecord }> {
  if (opts.dedupe) {
    const existing = await findActiveSiteByDomain(db, owner, input.domains);
    if (existing) return { created: false, site: existing };
  }
  // shadow mode (§7): new sites record-only for the first shadow_days before
  // ads are actually blocked. shadow_until = when enforcement begins.
  const createdAt = Date.now();
  const site: SiteRecord = {
    site_id: generateSiteId(), name: input.name, domains: input.domains, status: 'active',
    timezone: input.timezone, engaged_seconds: input.engaged_seconds, adguard_mode: input.adguard_mode, adclient: input.adclient,
    shadow_until: createdAt + Math.max(0, opts.shadowDays) * 86_400_000, created_at: createdAt,
  };
  const values = [site.site_id, site.name, owner, JSON.stringify(site.domains), site.adguard_mode, site.adclient,
    site.timezone, site.engaged_seconds, site.shadow_until, site.created_at];
  const cols = 'site_id, name, owner_id, allowed_domains, adguard_mode, adclient, timezone, engaged_seconds, shadow_until, created_at';
  if (opts.dedupe) {
    const res = await db.prepare(`INSERT INTO sites (${cols})
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM sites WHERE owner_id = ? AND status = 'active'
        AND EXISTS (SELECT 1 FROM json_each(allowed_domains) WHERE value IN (SELECT value FROM json_each(?))))`)
      .bind(...values, owner, JSON.stringify(site.domains)).run();
    if (!res.meta.changes) {
      // lost the race to a concurrent identical request — hand back the winner
      const winner = await findActiveSiteByDomain(db, owner, input.domains);
      if (!winner) throw new SiteError(409, 'site creation conflicted; retry');
      return { created: false, site: winner };
    }
  } else {
    await db.prepare(`INSERT INTO sites (${cols}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(...values).run();
  }
  await writeSiteConfig(kv, site);
  return { created: true, site };
}

export class SiteError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

// ---------------------------------------------------------------------------
// funnels
// ---------------------------------------------------------------------------

export interface Step { type: 'page' | 'event'; value: string }

/** Validate funnel steps for a WRITE: page/event steps with a non-empty value
 *  of at most MAX_STEP_LENGTH chars, capped at 8. Anything else is dropped;
 *  callers then require at least 2. (Reads keep the lenient parser — a stored
 *  row must never break a query.) */
export function validateSteps(raw: unknown): Step[] {
  if (!Array.isArray(raw)) return [];
  const out: Step[] = [];
  for (const s of raw) {
    if (!s || typeof s !== 'object') continue;
    const { type, value } = s as Record<string, unknown>;
    if ((type !== 'page' && type !== 'event') || typeof value !== 'string') continue;
    const v = value.trim();
    if (!v || v.length > MAX_STEP_LENGTH) continue;
    out.push({ type, value: v });
    if (out.length === 8) break;
  }
  return out;
}

export function funnelName(raw: unknown): string {
  return (typeof raw === 'string' ? raw.trim().slice(0, 60) : '') || 'Funnel';
}

/** Find-or-create a saved funnel by name on one site. An existing funnel of
 *  that name is returned as is (`created: false`); when its steps differ they
 *  are replaced and `updated: true` says so. The insert re-checks the name
 *  inside the statement, so concurrent retries create one funnel, not two. */
export async function ensureFunnel(db: D1Database, siteId: string, name: string, steps: Step[]): Promise<{
  funnel_id: string; name: string; steps: Step[]; created: boolean; updated: boolean; updated_at: number;
}> {
  const find = () => db.prepare('SELECT funnel_id, steps, updated_at FROM funnels WHERE site_id = ? AND name = ? ORDER BY created_at LIMIT 1')
    .bind(siteId, name).first<{ funnel_id: string; steps: string; updated_at: number }>();
  const stepsJson = JSON.stringify(steps);
  let existing = await find();
  if (!existing) {
    const id = generateSiteId(), now = Date.now();
    const res = await db.prepare(`INSERT INTO funnels (site_id, funnel_id, name, steps, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM funnels WHERE site_id = ? AND name = ?)`)
      .bind(siteId, id, name, stepsJson, now, now, siteId, name).run();
    if (res.meta.changes) return { funnel_id: id, name, steps, created: true, updated: false, updated_at: now };
    existing = await find();
    if (!existing) throw new SiteError(409, 'funnel creation conflicted; retry');
  }
  if (existing.steps === stepsJson) {
    return { funnel_id: existing.funnel_id, name, steps, created: false, updated: false, updated_at: existing.updated_at };
  }
  const now = Date.now();
  await db.prepare('UPDATE funnels SET steps = ?, updated_at = ? WHERE site_id = ? AND funnel_id = ?')
    .bind(stepsJson, now, siteId, existing.funnel_id).run();
  return { funnel_id: existing.funnel_id, name, steps, created: false, updated: true, updated_at: now };
}

// ---------------------------------------------------------------------------
// templates (migration 0023)
// ---------------------------------------------------------------------------

export interface TemplateFunnel { name: string; steps: Step[] }
export interface SiteTemplate {
  template_id: string;
  name: string;
  timezone: string | null;
  engaged_seconds: number | null;
  adguard_mode: string | null;
  adclient: string | null;
  funnels: TemplateFunnel[];
  created_at: number;
  updated_at: number;
}
type TemplateRow = Omit<SiteTemplate, 'funnels'> & { funnels: string };

function toTemplate(r: TemplateRow): SiteTemplate {
  let funnels: TemplateFunnel[] = [];
  try {
    const arr = JSON.parse(r.funnels);
    if (Array.isArray(arr)) {
      funnels = arr.map((f) => ({ name: funnelName(f?.name), steps: validateSteps(f?.steps) })).filter((f) => f.steps.length >= 2);
    }
  } catch { /* malformed → no default funnels */ }
  return { ...r, funnels };
}

const TEMPLATE_COLUMNS = 'template_id, name, timezone, engaged_seconds, adguard_mode, adclient, funnels, created_at, updated_at';

export async function listTemplates(db: D1Database, owner: string): Promise<SiteTemplate[]> {
  const rows = await db.prepare(`SELECT ${TEMPLATE_COLUMNS} FROM site_templates WHERE owner_id = ? ORDER BY name`)
    .bind(owner).all<TemplateRow>();
  return rows.results.map(toTemplate);
}

/** Look a template up by id, else by (case-insensitive) name — integrations
 *  usually know the name they configured, not the generated id. */
export async function findTemplate(db: D1Database, owner: string, ref: string): Promise<SiteTemplate | null> {
  const r = await db.prepare(`SELECT ${TEMPLATE_COLUMNS} FROM site_templates WHERE owner_id = ? AND (template_id = ? OR name = ? COLLATE NOCASE)
      ORDER BY (template_id = ?) DESC LIMIT 1`).bind(owner, ref, ref, ref).first<TemplateRow>();
  return r ? toTemplate(r) : null;
}

/** Validate a template body (console CRUD). Settings use the same rules as
 *  site creation, but every field is optional — an unset one means "use the
 *  default when the site is created". Invalid values are errors here, not
 *  silently dropped: a template is applied blind, many times. */
export function validateTemplate(body: Record<string, unknown>): { template: Omit<SiteTemplate, 'template_id' | 'created_at' | 'updated_at'> } | { error: string } {
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 60) : '';
  if (!name) return { error: 'template name required' };
  const blank = (v: unknown) => v === undefined || v === null || v === '';

  let timezone: string | null = null;
  if (!blank(body.timezone)) {
    timezone = String(body.timezone).trim();
    if (!isValidTimezone(timezone)) return { error: `invalid timezone: ${timezone}` };
  }
  let engaged: number | null = null;
  if (!blank(body.engaged_seconds)) {
    engaged = clampEngaged(body.engaged_seconds);
    if (engaged === null) return { error: 'engaged_seconds must be a number' };
  }
  let mode: string | null = null;
  if (!blank(body.adguard_mode)) {
    if (typeof body.adguard_mode !== 'string' || !ADGUARD_MODES.has(body.adguard_mode)) return { error: 'invalid adguard_mode (off, loose, balanced, strict)' };
    mode = body.adguard_mode;
  }
  let adclient: string | null = null;
  if (!blank(body.adclient)) {
    adclient = String(body.adclient).trim();
    if (!ADCLIENT_RE.test(adclient)) return { error: 'invalid adclient (expected ca-pub-…)' };
  }
  const funnels: TemplateFunnel[] = [];
  const rawFunnels = body.funnels ?? [];
  if (!Array.isArray(rawFunnels) || rawFunnels.length > 10) return { error: 'funnels must be a list of at most 10 {name, steps}' };
  for (const f of rawFunnels) {
    const fname = funnelName((f as Record<string, unknown>)?.name);
    const steps = validateSteps((f as Record<string, unknown>)?.steps);
    if (steps.length < 2) return { error: `funnel "${fname}" needs 2–8 steps with a value (max ${MAX_STEP_LENGTH} chars)` };
    if (funnels.some((x) => x.name === fname)) return { error: `duplicate funnel name: ${fname}` };
    funnels.push({ name: fname, steps });
  }
  return { template: { name, timezone, engaged_seconds: engaged, adguard_mode: mode, adclient, funnels } };
}

// ---------------------------------------------------------------------------
// embed snippet
// ---------------------------------------------------------------------------

/** The embed tag for a site — byte-for-byte the format the console shows after
 *  creating one (sites.html): f.js from the console origin, `data-api` at the
 *  ingest host, ad-guard attributes only when they apply. */
export function buildSnippet(sdkOrigin: string, ingestHost: string, s: Pick<SiteRecord, 'site_id' | 'adguard_mode' | 'adclient'>): string {
  const attrs = [`data-site="${s.site_id}"`, `data-api="https://${ingestHost}"`];
  if (s.adguard_mode !== 'off') attrs.push(`data-adguard="${s.adguard_mode}"`);
  if (s.adclient) attrs.push(`data-adclient="${s.adclient}"`);
  return `<script defer src="${sdkOrigin}/f.js"\n        ${attrs.join('\n        ')}></script>`;
}
