/**
 * Site labels for the portfolio console (docs/design/portfolio-ui.md §3.2).
 *
 * Storage: `site_labels(site_id PK, starred INTEGER DEFAULT 0, tags TEXT
 * DEFAULT '[]', notes TEXT, updated_at)` — created by migration 0026.
 * The overview reads it; the write side lives here so the console worker
 * (session cookie) and the api worker (write tokens) share one implementation:
 *
 *   POST /api/sites/bulk, POST /v1/sites/bulk
 *     {site_ids: [...], action: star|unstar|tag|untag|archive|restore|adguard, value?}
 *   PUT  /api/sites/:id/labels, PUT /v1/sites/:id/labels
 *     {starred?, tags?, notes?}
 *
 * Besides the user's own tags, every site carries an automatic cohort tag
 * `launch:YYYY-Www` (ISO week of its creation, in the owner's timezone),
 * computed at read time and never stored.
 */

import { localYMD, weekdayMon0, addDays } from './tz';
import { ADGUARD_MODES, findActiveSiteByDomain } from './sites';

// The slice of D1 / KV used here, typed structurally: shared/ is also compiled
// by the SDK's tsconfig, which has no Workers types. D1Database satisfies it.
interface Stmt {
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}
type D1PreparedStatement = Stmt;
type D1Database = { prepare(sql: string): { bind(...values: unknown[]): Stmt }; batch(stmts: Stmt[]): Promise<unknown> };

export const MAX_TAGS = 20;
export const MAX_TAG_LENGTH = 32;
export const MAX_NOTES_LENGTH = 2000;
export const MAX_BULK_SITES = 500;
/** reserved for computed tags (the launch cohort); users cannot set it */
export const RESERVED_TAG_PREFIX = 'launch:';
export const BULK_ACTIONS = new Set(['star', 'unstar', 'tag', 'untag', 'archive', 'restore', 'adguard']);
const SITE_ID_RE = /^[A-Za-z0-9]{4,16}$/;

/** Automatic cohort tag: `launch:YYYY-Www`, the ISO-8601 week (Monday start,
 *  week 1 holds the year's first Thursday) of `created_at` in `tz`. */
export function cohortTag(created_at: number, tz: string): string {
  let ymd;
  try { ymd = localYMD(created_at, tz || 'UTC'); } catch { ymd = localYMD(created_at, 'UTC'); }
  // shift to the Thursday of this ISO week; its year is the ISO year
  const thu = addDays(ymd.y, ymd.m0, ymd.d, 3 - weekdayMon0(ymd.y, ymd.m0, ymd.d));
  const jan1 = Date.UTC(thu.y, 0, 1);
  const week = Math.floor((Date.UTC(thu.y, thu.m0, thu.d) - jan1) / 86400e3 / 7) + 1;
  return `launch:${thu.y}-W${String(week).padStart(2, '0')}`;
}

/** Normalise one user tag: NFC, control chars stripped, whitespace collapsed,
 *  trimmed, at most MAX_TAG_LENGTH characters. Returns null when nothing
 *  usable is left or the tag uses the reserved computed prefix. */
export function normalizeTag(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  let s = raw.normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  const chars = Array.from(s);
  if (chars.length > MAX_TAG_LENGTH) s = chars.slice(0, MAX_TAG_LENGTH).join('').trim();
  if (s.toLowerCase().startsWith(RESERVED_TAG_PREFIX)) return null;
  return s;
}

/** Normalise a tag list: each tag normalised, case-insensitive duplicates
 *  dropped (first spelling kept). Errors when the list is not a list, holds an
 *  invalid tag or exceeds MAX_TAGS. */
export function normalizeTags(raw: unknown): { tags: string[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: 'tags must be a list' };
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of raw) {
    const n = normalizeTag(t);
    if (!n) return { error: `invalid tag (1–${MAX_TAG_LENGTH} characters, not starting with "${RESERVED_TAG_PREFIX}")` };
    const k = n.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k); out.push(n);
  }
  if (out.length > MAX_TAGS) return { error: `at most ${MAX_TAGS} tags per site` };
  return { tags: out };
}

/** Parse a stored tags column defensively (malformed → []). */
export function parseStoredTags(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; } catch { return []; }
}

export interface SiteLabels { site_id: string; starred: boolean; tags: string[]; notes: string | null; updated_at: number | null }

export class LabelError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

type Kv = { delete(key: string): Promise<void> };

function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/** Sites from `ids` that `owner` holds (chunked IN, D1 caps bound params). */
async function ownedSites(db: D1Database, owner: string, ids: string[]):
  Promise<Map<string, { site_id: string; status: string; allowed_domains: string }>> {
  const out = new Map<string, { site_id: string; status: string; allowed_domains: string }>();
  for (const part of chunks(ids, 90)) {
    const rows = await db.prepare(`SELECT site_id, status, allowed_domains FROM sites WHERE owner_id = ? AND site_id IN (${part.map(() => '?').join(',')})`)
      .bind(owner, ...part).all<{ site_id: string; status: string | null; allowed_domains: string }>();
    for (const r of rows.results) out.set(r.site_id, { ...r, status: r.status || 'active' });
  }
  return out;
}

async function storedLabels(db: D1Database, ids: string[]): Promise<Map<string, { starred: number; tags: string; notes: string | null }>> {
  const out = new Map<string, { starred: number; tags: string; notes: string | null }>();
  for (const part of chunks(ids, 90)) {
    const rows = await db.prepare(`SELECT site_id, starred, tags, notes FROM site_labels WHERE site_id IN (${part.map(() => '?').join(',')})`)
      .bind(...part).all<{ site_id: string; starred: number; tags: string; notes: string | null }>();
    for (const r of rows.results) out.set(r.site_id, r);
  }
  return out;
}

const UPSERT_LABELS = `INSERT INTO site_labels (site_id, starred, tags, notes, updated_at) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(site_id) DO UPDATE SET starred = excluded.starred, tags = excluded.tags, notes = excluded.notes, updated_at = excluded.updated_at`;

async function runAll(db: D1Database, stmts: D1PreparedStatement[]): Promise<void> {
  for (const part of chunks(stmts, 50)) if (part.length) await db.batch(part);
}

export interface BulkResult {
  ok: true; action: string; updated: number;
  /** sites left unchanged, with why: restore → domain owned by another active
   *  site; tag → already at MAX_TAGS */
  skipped: { site_id: string; reason: 'domain_conflict' | 'tag_limit'; conflict_site_id?: string }[];
}

/** Validate and apply a bulk action for `owner`. All-or-nothing on ownership:
 *  a single site id the owner does not hold rejects the whole request (403),
 *  so a script can never half-apply against a mistyped list. */
export async function applyBulk(db: D1Database, kv: Kv, owner: string, body: unknown): Promise<BulkResult> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new LabelError(400, 'bad json');
  const b = body as Record<string, unknown>;
  const action = String(b.action ?? '');
  if (!BULK_ACTIONS.has(action)) throw new LabelError(400, `action must be one of ${[...BULK_ACTIONS].join(', ')}`);
  if (!Array.isArray(b.site_ids) || b.site_ids.length === 0) throw new LabelError(400, 'site_ids must be a non-empty list');
  if (b.site_ids.length > MAX_BULK_SITES) throw new LabelError(400, `at most ${MAX_BULK_SITES} sites per request`);
  if (!b.site_ids.every((x) => typeof x === 'string' && SITE_ID_RE.test(x))) throw new LabelError(400, 'invalid site id');
  const ids = [...new Set(b.site_ids as string[])];

  let tag: string | null = null;
  let mode = '';
  if (action === 'tag' || action === 'untag') {
    tag = normalizeTag(b.value);
    if (!tag) throw new LabelError(400, `value must be a tag (1–${MAX_TAG_LENGTH} characters, not starting with "${RESERVED_TAG_PREFIX}")`);
  }
  if (action === 'adguard') {
    mode = String(b.value ?? '');
    if (!ADGUARD_MODES.has(mode)) throw new LabelError(400, `value must be one of ${[...ADGUARD_MODES].join(', ')}`);
  }

  const owned = await ownedSites(db, owner, ids);
  if (owned.size !== ids.length) throw new LabelError(403, 'not your site');

  const now = Date.now();
  const skipped: BulkResult['skipped'] = [];
  const stmts: D1PreparedStatement[] = [];
  const invalidate: string[] = [];

  if (action === 'star' || action === 'unstar' || action === 'tag' || action === 'untag') {
    const prev = await storedLabels(db, ids);
    for (const id of ids) {
      const p = prev.get(id);
      let starred = p?.starred ? 1 : 0;
      let tags = parseStoredTags(p?.tags);
      if (action === 'star') starred = 1;
      else if (action === 'unstar') starred = 0;
      else if (action === 'tag') {
        if (tags.some((t) => t.toLowerCase() === tag!.toLowerCase())) continue; // already tagged
        if (tags.length >= MAX_TAGS) { skipped.push({ site_id: id, reason: 'tag_limit' }); continue; }
        tags = [...tags, tag!];
      } else {
        const next = tags.filter((t) => t.toLowerCase() !== tag!.toLowerCase());
        if (next.length === tags.length) continue;
        tags = next;
      }
      stmts.push(db.prepare(UPSERT_LABELS).bind(id, starred, JSON.stringify(tags), p?.notes ?? null, now));
    }
  } else if (action === 'archive') {
    for (const id of ids) {
      if (owned.get(id)!.status === 'archived') continue;
      stmts.push(db.prepare("UPDATE sites SET status = 'archived' WHERE site_id = ? AND owner_id = ?").bind(id, owner));
      invalidate.push(id);
    }
  } else if (action === 'restore') {
    // a domain may belong to only one active site per owner (see updateSite):
    // restoring one whose domain was since reused would break POST /v1/sites'
    // dedupe, so those are skipped and reported rather than restored
    const claimed = new Map<string, string>(); // domains restored in this request
    for (const id of ids) {
      const s = owned.get(id)!;
      if (s.status === 'active') continue;
      let domains: string[] = [];
      try { const d = JSON.parse(s.allowed_domains); if (Array.isArray(d)) domains = d; } catch { /* none */ }
      const clash = await findActiveSiteByDomain(db, owner, domains, id);
      const inBatch = domains.map((d) => claimed.get(d)).find(Boolean);
      if (clash || inBatch) {
        skipped.push({ site_id: id, reason: 'domain_conflict', conflict_site_id: clash?.site_id ?? inBatch });
        continue;
      }
      for (const d of domains) claimed.set(d, id);
      stmts.push(db.prepare("UPDATE sites SET status = 'active' WHERE site_id = ? AND owner_id = ?").bind(id, owner));
      invalidate.push(id);
    }
  } else if (action === 'adguard') {
    for (const id of ids) {
      stmts.push(db.prepare('UPDATE sites SET adguard_mode = ? WHERE site_id = ? AND owner_id = ?').bind(mode, id, owner));
      invalidate.push(id);
    }
  }

  await runAll(db, stmts);
  // ingest / the ad gate cache site:<id> for minutes — drop it so status and
  // ad-guard changes apply on the next event instead of after the TTL
  await Promise.all(invalidate.map((id) => kv.delete(`site:${id}`)));
  return { ok: true, action, updated: stmts.length, skipped };
}

/** PUT labels for one site: any of starred (bool), tags (full replacement
 *  list), notes (string | null). Absent keys keep their stored value. */
export async function putLabels(db: D1Database, owner: string, siteId: string, body: unknown): Promise<SiteLabels> {
  if (!SITE_ID_RE.test(siteId)) throw new LabelError(400, 'invalid site id');
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new LabelError(400, 'bad json');
  const b = body as Record<string, unknown>;
  const owned = await ownedSites(db, owner, [siteId]);
  if (!owned.has(siteId)) throw new LabelError(403, 'not your site');
  const prev = (await storedLabels(db, [siteId])).get(siteId);
  let starred = prev?.starred ? 1 : 0;
  let tags = parseStoredTags(prev?.tags);
  let notes = prev?.notes ?? null;
  if (b.starred !== undefined) {
    if (typeof b.starred !== 'boolean') throw new LabelError(400, 'starred must be true or false');
    starred = b.starred ? 1 : 0;
  }
  if (b.tags !== undefined) {
    const t = normalizeTags(b.tags);
    if ('error' in t) throw new LabelError(400, t.error);
    tags = t.tags;
  }
  if (b.notes !== undefined) {
    if (b.notes !== null && typeof b.notes !== 'string') throw new LabelError(400, 'notes must be a string or null');
    const n = typeof b.notes === 'string' ? b.notes.trim() : '';
    if (Array.from(n).length > MAX_NOTES_LENGTH) throw new LabelError(400, `notes: at most ${MAX_NOTES_LENGTH} characters`);
    notes = n || null;
  }
  const now = Date.now();
  await db.prepare(UPSERT_LABELS).bind(siteId, starred, JSON.stringify(tags), notes, now).run();
  return { site_id: siteId, starred: !!starred, tags, notes, updated_at: now };
}
