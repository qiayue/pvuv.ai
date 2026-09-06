/**
 * pvuv.ai retention purge — daily cleanup of raw data past the retention window
 * (PROJECT_PLAN.md §16). Four passes, each bounded so a large backlog is worked
 * off over a few nights rather than in one cron invocation:
 *
 *   1. raw partitions   — DROP whole events_YYYYMM tables once the entire
 *                         month precedes raw_events_days (reclaims the table
 *                         and its indexes at once, no per-row work).
 *   2. pulse rows       — page_pulse is the periodic behavior carrier; the
 *                         hourly rollup has consumed it within the hour and
 *                         the journey timeline only needs it for recent
 *                         visits. Trimmed after pulse_events_days.
 *   3. bot rows         — events judged bot/crawler are already counted in
 *                         every rollup; their raw rows are drill-down only.
 *                         On bot-heavy sites they are most of the table, so
 *                         they go after bot_events_days.
 *   4. sessions / idle profiles — not partitioned; deleted by age.
 *
 * Window sizes come from CONFIG.retention (§21 — nothing hardcoded here).
 * 0 / negative / missing means "keep forever" for that pass.
 *
 * Row-trim passes delete in fixed-size batches (rowid IN (… LIMIT n)) because
 * D1 has no DELETE … LIMIT and a single unbounded DELETE on a multi-million
 * row table can exceed the per-query time budget.
 */

import { CONFIG } from '../../../shared/config.gen';
import { monthSuffix } from '../../../shared/events';
import { existingEventTables } from './rollup';

const DAY_MS = 86_400_000;
const BATCH = 5000;           // rows per DELETE
const MAX_BATCHES = 40;       // per table per pass per run (≈200k rows)

export interface RetentionSummary {
  raw_events_days: number; pulse_events_days: number; bot_events_days: number; profiles_idle_days: number;
  dropped_partitions: string[];
  pulse_rows_deleted: number;
  bot_rows_deleted: number;
  sessions_deleted: number;
  profiles_deleted: number;
  /** a row-trim pass hit its batch cap and will continue next run */
  more_pending: boolean;
  errors: string[];
}

function windowDays(key: 'raw_events_days' | 'pulse_events_days' | 'bot_events_days' | 'profiles_idle_days'): number {
  const v = (CONFIG.retention as Record<string, unknown>)[key];
  return typeof v === 'number' && v > 0 ? v : 0;
}

/** Batched DELETE by rowid; returns rows deleted and whether the cap was hit. */
async function trimRows(db: D1Database, table: string, where: string, binds: unknown[]): Promise<{ n: number; capped: boolean }> {
  let n = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const res = await db.prepare(
      `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${where} LIMIT ${BATCH})`,
    ).bind(...binds).run();
    const c = res.meta?.changes ?? 0;
    n += c;
    if (c < BATCH) return { n, capped: false };
  }
  return { n, capped: true };
}

export async function runRetentionPurge(env: { DB: D1Database }, now = Date.now()): Promise<RetentionSummary> {
  const s: RetentionSummary = {
    raw_events_days: windowDays('raw_events_days'),
    pulse_events_days: windowDays('pulse_events_days'),
    bot_events_days: windowDays('bot_events_days'),
    profiles_idle_days: windowDays('profiles_idle_days'),
    dropped_partitions: [], pulse_rows_deleted: 0, bot_rows_deleted: 0,
    sessions_deleted: 0, profiles_deleted: 0, more_pending: false, errors: [],
  };
  const tables = [...await existingEventTables(env.DB)].sort();

  // 1. whole-month partitions past the raw window
  if (s.raw_events_days) {
    const cutoffMonth = monthSuffix(now - s.raw_events_days * DAY_MS);
    for (const name of tables) {
      const suffix = name.slice('events_'.length);
      if (suffix < cutoffMonth) {
        try {
          // name comes from sqlite_master filtered to the events_YYYYMM pattern —
          // not user-controlled, safe to interpolate (table names can't bind)
          await env.DB.prepare(`DROP TABLE IF EXISTS ${name}`).run();
          s.dropped_partitions.push(name);
        } catch (err) { s.errors.push(`drop ${name}: ${String(err)}`); }
      }
    }
  }
  const live = tables.filter((t) => !s.dropped_partitions.includes(t));

  // 2./3. row trims inside the live partitions. Only partitions that can
  //       contain rows older than the cutoff are touched (month <= cutoff month).
  const trim = async (days: number, where: string, tally: 'pulse_rows_deleted' | 'bot_rows_deleted') => {
    if (!days) return;
    const cutoff = now - days * DAY_MS;
    const cutoffMonth = monthSuffix(cutoff);
    for (const name of live) {
      if (name.slice('events_'.length) > cutoffMonth) continue;
      try {
        const r = await trimRows(env.DB, name, `${where} AND ts < ?`, [cutoff]);
        s[tally] += r.n;
        if (r.capped) s.more_pending = true;
      } catch (err) { s.errors.push(`trim ${tally} ${name}: ${String(err)}`); }
    }
  };
  await trim(s.pulse_events_days, "event = 'page_pulse'", 'pulse_rows_deleted');
  await trim(s.bot_events_days, "verdict IN ('bot','crawler')", 'bot_rows_deleted');

  // 4. sessions by started_at (raw window); visitor profiles idle past their own window
  if (s.raw_events_days) {
    try {
      const r = await trimRows(env.DB, 'sessions', 'started_at < ?', [now - s.raw_events_days * DAY_MS]);
      s.sessions_deleted = r.n; if (r.capped) s.more_pending = true;
    } catch (err) { s.errors.push(`sessions: ${String(err)}`); }
  }
  if (s.profiles_idle_days) {
    try {
      const r = await trimRows(env.DB, 'visitor_profiles', 'last_seen < ?', [now - s.profiles_idle_days * DAY_MS]);
      s.profiles_deleted = r.n; if (r.capped) s.more_pending = true;
    } catch (err) { s.errors.push(`profiles: ${String(err)}`); }
  }

  console.log(`retention: dropped ${s.dropped_partitions.length} partition(s); trimmed pulse=${s.pulse_rows_deleted} bot=${s.bot_rows_deleted} sessions=${s.sessions_deleted} profiles=${s.profiles_deleted}${s.more_pending ? ' (more pending)' : ''}${s.errors.length ? `; errors: ${s.errors.join(' | ')}` : ''}`);
  return s;
}

// ---------------------------------------------------------------------------
// Storage report — what the console's "Storage & retention" panel shows.
// Row counts per partition plus a size ESTIMATE from measured per-row
// footprints (table + its 8 indexes); the exact number is `wrangler d1 info`.
// ---------------------------------------------------------------------------

/** Measured on the local reference dataset: bytes per row including indexes. */
export const ROW_BYTES = { event: 780, session: 370, profile: 275 } as const;

export interface StorageReport {
  partitions: Array<{ table: string; rows: number; pulse_rows: number; bot_rows: number; est_mb: number }>;
  sessions: number; profiles: number;
  total_events: number; est_total_mb: number;
  retention: { raw_events_days: number; pulse_events_days: number; bot_events_days: number; profiles_idle_days: number };
}

export async function storageReport(db: D1Database): Promise<StorageReport> {
  const tables = [...await existingEventTables(db)].sort();
  const partitions: StorageReport['partitions'] = [];
  let total = 0;
  for (const table of tables) {
    const r = await db.prepare(`
      SELECT COUNT(*) AS n,
             COALESCE(SUM(event = 'page_pulse'), 0) AS pulse,
             COALESCE(SUM(verdict IN ('bot','crawler')), 0) AS bot
      FROM ${table}`).first<{ n: number; pulse: number; bot: number }>();
    const n = r?.n ?? 0; total += n;
    partitions.push({ table, rows: n, pulse_rows: r?.pulse ?? 0, bot_rows: r?.bot ?? 0, est_mb: +(n * ROW_BYTES.event / 1048576).toFixed(1) });
  }
  const sessions = (await db.prepare('SELECT COUNT(*) AS n FROM sessions').first<{ n: number }>())?.n ?? 0;
  const profiles = (await db.prepare('SELECT COUNT(*) AS n FROM visitor_profiles').first<{ n: number }>())?.n ?? 0;
  const est = total * ROW_BYTES.event + sessions * ROW_BYTES.session + profiles * ROW_BYTES.profile;
  return {
    partitions, sessions, profiles, total_events: total, est_total_mb: +(est / 1048576).toFixed(1),
    retention: {
      raw_events_days: windowDays('raw_events_days'), pulse_events_days: windowDays('pulse_events_days'),
      bot_events_days: windowDays('bot_events_days'), profiles_idle_days: windowDays('profiles_idle_days'),
    },
  };
}
