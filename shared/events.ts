/**
 * Event wire format + persisted row shape + monthly-partition helpers.
 *
 * - IncomingEvent: what f.js POSTs to /in (PROJECT_PLAN.md §5)
 * - EventRow:      fully enriched+scored row, the Queue message payload,
 *                  matching events_YYYYMM columns (§9.2)
 * - eventsTableDDL / eventInsertSQL: the consumer creates next-month tables
 *   on demand from this template. KEEP IN SYNC with shared/schema.sql.
 */

import type { Verdict, ScoreStage, XPayload } from './flags';

// ---------------------------------------------------------------------------
// Wire format (client → /in). Content-Type: text/plain, single or array ≤10.
// ---------------------------------------------------------------------------

export interface IncomingEvent {
  /** site_id */
  s: string;
  /** event name: pageview / page_leave / outbound_click / custom */
  e: string;
  /** full page URL */
  u: string;
  /** referrer */
  r?: string;
  vid: string;
  sid: string;
  uid?: string;
  /** screen width/height */
  sw?: number;
  sh?: number;
  lang?: string;
  /** custom properties (revenue/currency reserved — §4.2) */
  p?: Record<string, unknown>;
  /** duration_ms (page_leave) */
  d?: number;
  /** scroll_depth 0–100 (page_leave) */
  sd?: number;
  /** had_interaction 0/1 */
  hi?: 0 | 1;
  /** authenticity signals, obfuscated (§4.4, shared/flags.ts XF) */
  x?: XPayload;
  /** first-touch attribution snapshot from _pv_ft (§3) */
  ft?: { s?: string; m?: string; c?: string; r?: string };
  /** Core Web Vitals snapshot — sent once per page load, on the first
   *  behavior carrier (page_pulse or page_leave, whichever comes first) */
  wv?: { lcp?: number; cls?: number; inp?: number; fcp?: number; ttfb?: number };
  /** JS error count since the last report (behavior carriers only) */
  er?: number;
  /** rage-click bursts since the last report */
  rg?: number;
  /** dead clicks since the last report */
  dc?: number;
  /** client unix ms */
  ts?: number;
}

/** SDK batches at most this many events per request (§5). */
export const MAX_BATCH_EVENTS = 10;
/** Server-side hard cap per request (defensive). */
export const MAX_REQUEST_EVENTS = 25;

// ---------------------------------------------------------------------------
// Persisted row (Queue payload; column order matches EVENT_COLUMNS)
// ---------------------------------------------------------------------------

export interface EventRow {
  /** stable dedup key (server-derived from the event tuple) — a UNIQUE index
   *  + INSERT OR IGNORE makes event writes exactly-once under queue redelivery */
  eid: string;
  site_id: string;
  event: string;
  visitor_id: string;
  session_id: string;
  user_id: string | null;
  url: string;
  hostname: string;
  path: string;
  referrer: string | null;
  ref_domain: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_term: string | null;
  utm_content: string | null;
  click_id: string | null;
  click_id_type: string | null;
  extra_params: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  browser: string | null;
  os: string | null;
  device_type: string | null;
  screen_w: number | null;
  screen_h: number | null;
  lang: string | null;
  ip_hash: string | null;
  ip24_hash: string | null;
  asn: number | null;
  asn_type: string | null;
  fp_hash: string | null;
  duration_ms: number | null;
  scroll_depth: number | null;
  had_interaction: number;
  revenue: number | null;
  revenue_usd: number | null;
  currency: string | null;
  props: string | null;
  ft_source: string | null;
  ft_medium: string | null;
  ft_campaign: string | null;
  ft_referrer: string | null;
  bot_score: number;
  verdict: Verdict;
  bot_flags: number;
  score_stage: ScoreStage;
  /** crawler category from the owner-imported bot directory (§6.6) — purely
   *  descriptive, never feeds scoring or the ad-guard decision */
  bot_category: string | null;
  /** Core Web Vitals (first behavior carrier of the initial load; NULL elsewhere) */
  lcp_ms: number | null;
  cls: number | null;
  inp_ms: number | null;
  fcp_ms: number | null;
  ttfb_ms: number | null;
  /** frustration/error deltas (behavior carriers only; NULL elsewhere) */
  err_count: number | null;
  rage_count: number | null;
  dead_count: number | null;
  ts: number;
  created_at: number;
}

export const EVENT_COLUMNS = [
  'eid',
  'site_id', 'event', 'visitor_id', 'session_id', 'user_id',
  'url', 'hostname', 'path', 'referrer', 'ref_domain',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'click_id', 'click_id_type', 'extra_params',
  'country', 'region', 'city',
  'browser', 'os', 'device_type',
  'screen_w', 'screen_h', 'lang',
  'ip_hash', 'ip24_hash', 'asn', 'asn_type', 'fp_hash',
  'duration_ms', 'scroll_depth', 'had_interaction',
  'revenue', 'revenue_usd', 'currency', 'props',
  'ft_source', 'ft_medium', 'ft_campaign', 'ft_referrer',
  'bot_score', 'verdict', 'bot_flags', 'score_stage', 'bot_category',
  'lcp_ms', 'cls', 'inp_ms', 'fcp_ms', 'ttfb_ms',
  'err_count', 'rage_count', 'dead_count',
  'ts', 'created_at',
] as const satisfies readonly (keyof EventRow)[];

// ---------------------------------------------------------------------------
// Conversions (§4.2): every event that isn't a lifecycle event is a custom
// "goal". Shared so consumer / rollup / query layer agree on the definition.
// ---------------------------------------------------------------------------

// page_pulse = the periodic behavior carrier (incremental dwell/scroll/click
// deltas, so data survives a lost leave beacon); form_start/form_submit are
// auto-collected — abandonment is DERIVED (starts − submits), never an event,
// so it can't be lost with the page. None of these are goals.
export const RESERVED_EVENTS = ['pageview', 'page_leave', 'page_pulse', 'outbound_click', 'identify', 'form_start', 'form_submit'] as const;
export function isConversion(event: string): boolean {
  return !(RESERVED_EVENTS as readonly string[]).includes(event);
}
/** SQL list literal, e.g. `'pageview','page_leave',…` — for `event NOT IN (…)`. */
export const RESERVED_EVENTS_SQL = RESERVED_EVENTS.map((e) => `'${e}'`).join(',');

// ---------------------------------------------------------------------------
// Monthly partitioning (§9.1): events_YYYYMM, UTC month of the event ts
// ---------------------------------------------------------------------------

export function monthSuffix(tsMs: number): string {
  const d = new Date(tsMs);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function eventsTableName(suffix: string): string {
  if (!/^\d{6}$/.test(suffix)) throw new Error(`bad month suffix: ${suffix}`);
  return `events_${suffix}`;
}

/**
 * DDL for one month partition — same template as shared/schema.sql
 * (which creates the initial month via migrations). IF NOT EXISTS makes it
 * safe to run on every consumer batch for an unseen month.
 */
/**
 * Index DDL for one month partition. Split out from eventsTableDDL so existing
 * partitions can be brought up to date with newly-added indexes without
 * re-issuing the CREATE TABLE (the consumer only ensures months it is actively
 * writing, so back-months would otherwise never gain a new index).
 * All IF NOT EXISTS → safe to re-run.
 */
export function eventsIndexDDL(suffix: string): string[] {
  const t = eventsTableName(suffix);
  return [
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_ev${suffix}_eid ON ${t}(eid)`,
    `CREATE INDEX IF NOT EXISTS idx_ev${suffix}_site_ts ON ${t}(site_id, ts)`,
    // covers the ubiquitous site_id + event='pageview' + ts-range scans
    `CREATE INDEX IF NOT EXISTS idx_ev${suffix}_site_ev_ts ON ${t}(site_id, event, ts)`,
    `CREATE INDEX IF NOT EXISTS idx_ev${suffix}_visitor ON ${t}(site_id, visitor_id)`,
    `CREATE INDEX IF NOT EXISTS idx_ev${suffix}_session ON ${t}(session_id)`,
    `CREATE INDEX IF NOT EXISTS idx_ev${suffix}_verdict ON ${t}(site_id, verdict, ts)`,
    `CREATE INDEX IF NOT EXISTS idx_ev${suffix}_path    ON ${t}(site_id, path)`,
    // crawler-category breakdown (0013)
    `CREATE INDEX IF NOT EXISTS idx_ev${suffix}_botcat ON ${t}(site_id, bot_category, ts)`,
  ];
}

/**
 * Columns added to the partition template AFTER the initial release.
 *
 * A migration can only ALTER the partitions that existed when it was written,
 * and the consumer reuses an existing month table as-is — so a deployer whose
 * current month table predates the migration would have every insert into it
 * fail with "no such column" and silently lose those events. Both the consumer
 * (before writing) and the hourly cron (for back-months) repair partitions from
 * this list, so a partition is never written to while structurally stale.
 *
 * Append here whenever a column is added to eventsTableDDL below.
 */
export const EVENT_LATE_COLUMNS: ReadonlyArray<{ name: string; ddl: string }> = [
  { name: 'bot_category', ddl: 'TEXT' }, // migration 0013
  // Core Web Vitals — migration 0016
  { name: 'lcp_ms', ddl: 'INTEGER' },
  { name: 'cls', ddl: 'REAL' },
  { name: 'inp_ms', ddl: 'INTEGER' },
  { name: 'fcp_ms', ddl: 'INTEGER' },
  { name: 'ttfb_ms', ddl: 'INTEGER' },
  // frustration/error signals — migration 0017
  { name: 'err_count', ddl: 'INTEGER' },
  { name: 'rage_count', ddl: 'INTEGER' },
  { name: 'dead_count', ddl: 'INTEGER' },
];

/** Minimal structural shape of what this helper needs from D1, so shared/ does
 *  not depend on the Workers global types. */
interface ColumnQueryable {
  prepare(sql: string): { all(): Promise<{ results: Array<{ name?: unknown }> }>; run(): Promise<unknown> };
}

/** Add any missing late columns to one partition. Idempotent: SQLite has no
 *  ADD COLUMN IF NOT EXISTS, so existing columns are detected first. */
export async function ensureEventColumns(db: ColumnQueryable, suffix: string): Promise<void> {
  const t = eventsTableName(suffix);
  const cols = await db.prepare(`PRAGMA table_info(${t})`).all();
  const have = new Set(cols.results.map((c) => String(c.name)));
  for (const col of EVENT_LATE_COLUMNS) {
    if (!have.has(col.name)) {
      await db.prepare(`ALTER TABLE ${t} ADD COLUMN ${col.name} ${col.ddl}`).run();
      console.log(`schema: added ${t}.${col.name}`);
    }
  }
}

export function eventsTableDDL(suffix: string): string[] {
  const t = eventsTableName(suffix);
  return [
    `CREATE TABLE IF NOT EXISTS ${t} (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      eid           TEXT,
      site_id       TEXT NOT NULL,
      event         TEXT NOT NULL,
      visitor_id    TEXT NOT NULL,
      session_id    TEXT NOT NULL,
      user_id       TEXT,
      url           TEXT NOT NULL,
      hostname      TEXT NOT NULL,
      path          TEXT NOT NULL,
      referrer      TEXT,
      ref_domain    TEXT,
      utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, utm_term TEXT, utm_content TEXT,
      click_id TEXT, click_id_type TEXT,
      extra_params TEXT,
      country TEXT, region TEXT, city TEXT,
      browser TEXT, os TEXT, device_type TEXT,
      screen_w INTEGER, screen_h INTEGER,
      lang TEXT,
      ip_hash TEXT, ip24_hash TEXT,
      asn INTEGER, asn_type TEXT,
      fp_hash TEXT,
      duration_ms INTEGER, scroll_depth INTEGER, had_interaction INTEGER DEFAULT 0,
      revenue REAL, revenue_usd REAL, currency TEXT,
      props TEXT,
      ft_source TEXT, ft_medium TEXT, ft_campaign TEXT, ft_referrer TEXT,
      bot_score INTEGER DEFAULT 0,
      verdict TEXT DEFAULT 'clean',
      bot_flags INTEGER DEFAULT 0,
      score_stage TEXT DEFAULT 'realtime',
      bot_category TEXT,
      lcp_ms INTEGER, cls REAL, inp_ms INTEGER, fcp_ms INTEGER, ttfb_ms INTEGER,
      err_count INTEGER, rage_count INTEGER, dead_count INTEGER,
      ts INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    ...eventsIndexDDL(suffix),
  ];
}

export function eventInsertSQL(suffix: string): string {
  const cols = EVENT_COLUMNS.join(', ');
  const marks = EVENT_COLUMNS.map(() => '?').join(', ');
  // OR IGNORE: a redelivered event (same eid) is a no-op, not a duplicate row
  return `INSERT OR IGNORE INTO ${eventsTableName(suffix)} (${cols}) VALUES (${marks})`;
}

export function eventRowValues(row: EventRow): unknown[] {
  return EVENT_COLUMNS.map((c) => row[c] ?? null);
}
