/**
 * pvuv.ai retention purge — daily cleanup of raw data past the retention window
 * (PROJECT_PLAN.md §16). Raw events are monthly-partitioned, so purging DROPS
 * whole events_YYYYMM partitions once the ENTIRE month precedes the cutoff —
 * this reclaims storage immediately with no expensive per-row deletes on a live
 * table. Sessions aren't partitioned, so old rows are deleted by started_at.
 * Aggregates (rollups, visitor_profiles, identities) persist on purpose: the
 * retention policy is "raw kept for drill-down; older → aggregates only".
 *
 * Window = CONFIG.retention.raw_events_days (§21 — no hardcoded number here).
 * 0 or negative means "keep forever" (no-op).
 */

import { CONFIG } from '../../../shared/config.gen';
import { monthSuffix } from '../../../shared/events';
import { existingEventTables } from './rollup';

const DAY_MS = 86_400_000;

export async function runRetentionPurge(env: { DB: D1Database }, now = Date.now()): Promise<void> {
  const days = CONFIG.retention.raw_events_days;
  if (!days || days <= 0) return; // keep-forever

  const cutoffTs = now - days * DAY_MS;
  const cutoffMonth = monthSuffix(cutoffTs); // 'YYYYMM' that contains the cutoff

  // 1. Drop event partitions whose whole month precedes the cutoff month. The
  //    cutoff's own month straddles the boundary, so it's kept intact — we
  //    retain up to ~1 extra month rather than row-delete from a live table.
  let dropped = 0;
  for (const name of await existingEventTables(env.DB)) {
    const suffix = name.slice('events_'.length);
    if (suffix.length === 6 && suffix < cutoffMonth) {
      try {
        // name comes from sqlite_master filtered to the events_YYYYMM pattern,
        // so it is not user-controlled — safe to interpolate (table names can't bind)
        await env.DB.prepare(`DROP TABLE IF EXISTS ${name}`).run();
        dropped++;
      } catch (err) {
        console.error(`retention: failed to drop ${name}`, err);
      }
    }
  }

  // 2. Sessions are not partitioned — delete rows older than the cutoff.
  let sessionsPurged = 0;
  try {
    const res = await env.DB.prepare('DELETE FROM sessions WHERE started_at < ?').bind(cutoffTs).run();
    sessionsPurged = res.meta?.changes ?? 0;
  } catch (err) {
    console.error('retention: failed to purge old sessions', err);
  }

  console.log(`retention: kept ${days}d; dropped ${dropped} event month(s), purged ${sessionsPurged} old session(s)`);
}
