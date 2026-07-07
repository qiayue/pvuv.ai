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
  'bot_score', 'verdict', 'bot_flags', 'score_stage',
  'ts', 'created_at',
] as const satisfies readonly (keyof EventRow)[];

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
      ts INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_ev${suffix}_eid ON ${t}(eid)`,
    `CREATE INDEX IF NOT EXISTS idx_ev${suffix}_site_ts ON ${t}(site_id, ts)`,
    `CREATE INDEX IF NOT EXISTS idx_ev${suffix}_visitor ON ${t}(site_id, visitor_id)`,
    `CREATE INDEX IF NOT EXISTS idx_ev${suffix}_session ON ${t}(session_id)`,
    `CREATE INDEX IF NOT EXISTS idx_ev${suffix}_verdict ON ${t}(site_id, verdict, ts)`,
    `CREATE INDEX IF NOT EXISTS idx_ev${suffix}_path    ON ${t}(site_id, path)`,
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
