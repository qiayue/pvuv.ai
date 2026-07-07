/**
 * pvuv.ai consumer worker — INGEST_QUEUE consumer (PROJECT_PLAN.md §18.3).
 *
 * Batch-writes enriched+scored EventRows into monthly events_YYYYMM tables
 * (created on demand from the shared template) and incrementally updates
 * sessions / identities / visitor_profiles in the same D1 batch.
 *
 * Failure model (M1): any error retries the whole message batch (Queue
 * redelivery). Inserts are not idempotent, so a partially-committed batch
 * can duplicate events on retry — acceptable for M1, revisit with
 * idempotency keys if it shows up in practice.
 */

import {
  monthSuffix, eventsTableDDL, eventInsertSQL, eventRowValues,
  type EventRow,
} from '../../../shared/events';

export interface Env {
  DB: D1Database;
}

/** Bounce definition (§9.3, GA4-style inverse): engaged = 2nd pageview OR
 *  dwell ≥ 10s OR any custom event; bounce = not engaged. */
const ENGAGED_DWELL_MS = 10_000;

/** Months whose table+indexes this isolate has already ensured. */
const ensuredMonths = new Set<string>();

/** D1 batch() statement chunk size (defensive). */
const BATCH_CHUNK = 80;

export default {
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    const rows = batch.messages.map((m) => m.body).filter(isPlausibleRow);
    if (rows.length === 0) {
      batch.ackAll();
      return;
    }

    try {
      // 1. ensure monthly partitions exist
      const months = [...new Set(rows.map((r) => monthSuffix(r.ts)))];
      for (const suffix of months) {
        if (ensuredMonths.has(suffix)) continue;
        await env.DB.batch(eventsTableDDL(suffix).map((sql) => env.DB.prepare(sql)));
        ensuredMonths.add(suffix);
      }

      // 2. one D1 batch: event inserts + session/identity/profile upserts
      const stmts: D1PreparedStatement[] = [];
      for (const row of rows) {
        stmts.push(env.DB.prepare(eventInsertSQL(monthSuffix(row.ts))).bind(...bindable(eventRowValues(row))));
        stmts.push(sessionUpsert(env.DB, row));
        const identity = identityUpsert(env.DB, row);
        if (identity) stmts.push(identity);
        stmts.push(profileUpsert(env.DB, row));
      }
      for (let i = 0; i < stmts.length; i += BATCH_CHUNK) {
        await env.DB.batch(stmts.slice(i, i + BATCH_CHUNK));
      }

      batch.ackAll();
    } catch (err) {
      console.error('consumer batch failed', err);
      batch.retryAll();
    }
  },
} satisfies ExportedHandler<Env>;

function isPlausibleRow(row: unknown): row is EventRow {
  const r = row as EventRow;
  return !!r && typeof r.site_id === 'string' && typeof r.event === 'string'
    && typeof r.visitor_id === 'string' && typeof r.session_id === 'string'
    && typeof r.ts === 'number';
}

/** D1 bind() rejects undefined — normalize to null. */
function bindable(values: unknown[]): unknown[] {
  return values.map((v) => (v === undefined ? null : v));
}

// ---------------------------------------------------------------------------
// sessions: incremental upsert (§3, §9.2). Attribution/entry fields are set
// on first insert only; counters accumulate; verdict tracks the worst score.
// ---------------------------------------------------------------------------

function sessionUpsert(db: D1Database, row: EventRow): D1PreparedStatement {
  const isPageview = row.event === 'pageview' ? 1 : 0;
  const isCustom = row.event !== 'pageview' && row.event !== 'page_leave' && row.event !== 'outbound_click' ? 1 : 0;
  const duration = row.duration_ms ?? 0;

  return db.prepare(`
    INSERT INTO sessions (
      session_id, site_id, visitor_id, user_id,
      entry_page, exit_page, entry_host, pageviews, events_count, duration_ms,
      had_interaction, is_bounce,
      source, medium, campaign, referrer, country, device_type,
      bot_score, verdict, bot_flags, started_at, last_active_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?21, ?6, 1, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?19)
    ON CONFLICT(session_id) DO UPDATE SET
      user_id         = COALESCE(excluded.user_id, sessions.user_id),
      exit_page       = CASE WHEN ?6 = 1 THEN excluded.exit_page ELSE sessions.exit_page END,
      pageviews       = sessions.pageviews + ?6,
      events_count    = sessions.events_count + 1,
      duration_ms     = sessions.duration_ms + ?7,
      had_interaction = MAX(sessions.had_interaction, excluded.had_interaction),
      is_bounce       = CASE
                          WHEN sessions.pageviews + ?6 >= 2 THEN 0
                          WHEN sessions.duration_ms + ?7 >= ${ENGAGED_DWELL_MS} THEN 0
                          WHEN ?20 = 1 THEN 0
                          ELSE sessions.is_bounce
                        END,
      bot_score       = MAX(sessions.bot_score, excluded.bot_score),
      bot_flags       = sessions.bot_flags | excluded.bot_flags,
      verdict         = CASE WHEN excluded.bot_score >= sessions.bot_score
                             THEN excluded.verdict ELSE sessions.verdict END,
      last_active_at  = MAX(sessions.last_active_at, excluded.last_active_at)
  `).bind(
    row.session_id,                                   // 1
    row.site_id,                                      // 2
    row.visitor_id,                                   // 3
    row.user_id,                                      // 4
    row.path,                                         // 5 entry/exit page
    isPageview,                                       // 6
    duration,                                         // 7
    row.had_interaction,                              // 8
    isCustom || duration >= ENGAGED_DWELL_MS ? 0 : 1, // 9 initial is_bounce
    row.utm_source ?? row.ref_domain,                 // 10 source (utm first, else referrer domain)
    row.utm_medium,                                   // 11
    row.utm_campaign,                                 // 12
    row.referrer,                                     // 13
    row.country,                                      // 14
    row.device_type,                                  // 15
    row.bot_score,                                    // 16
    row.verdict,                                      // 17
    row.bot_flags,                                    // 18
    row.ts,                                           // 19 started_at / last_active_at
    isCustom,                                         // 20
    row.hostname,                                     // 21 entry_host (kept from first event)
  );
}

// ---------------------------------------------------------------------------
// identities: user ↔ visitor map, only when the event carries a user_id (§3)
// ---------------------------------------------------------------------------

function identityUpsert(db: D1Database, row: EventRow): D1PreparedStatement | null {
  if (!row.user_id) return null;
  return db.prepare(`
    INSERT INTO identities (site_id, user_id, visitor_id, traits, first_seen, last_seen)
    VALUES (?1, ?2, ?3, NULL, ?4, ?4)
    ON CONFLICT(site_id, user_id, visitor_id) DO UPDATE SET
      last_seen = MAX(identities.last_seen, excluded.last_seen)
  `).bind(row.site_id, row.user_id, row.visitor_id, row.ts);
}

// ---------------------------------------------------------------------------
// visitor_profiles: cheap incremental fields only. sessions_count and the
// Welford interval stats (interval_mean/m2/cv, active_hours) are maintained
// by the batch layer (§6.5, M2) — not double-counted here.
// ---------------------------------------------------------------------------

function profileUpsert(db: D1Database, row: EventRow): D1PreparedStatement {
  return db.prepare(`
    INSERT INTO visitor_profiles (
      site_id, visitor_id, events_count, sessions_count,
      fp_hash, ip24_hash, asn, bot_score, verdict, first_seen, last_seen
    ) VALUES (?1, ?2, 1, 0, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
    ON CONFLICT(site_id, visitor_id) DO UPDATE SET
      events_count = visitor_profiles.events_count + 1,
      fp_hash      = COALESCE(excluded.fp_hash, visitor_profiles.fp_hash),
      ip24_hash    = COALESCE(excluded.ip24_hash, visitor_profiles.ip24_hash),
      asn          = COALESCE(excluded.asn, visitor_profiles.asn),
      bot_score    = MAX(visitor_profiles.bot_score, excluded.bot_score),
      verdict      = CASE WHEN excluded.bot_score >= visitor_profiles.bot_score
                          THEN excluded.verdict ELSE visitor_profiles.verdict END,
      first_seen   = MIN(visitor_profiles.first_seen, excluded.first_seen),
      last_seen    = MAX(visitor_profiles.last_seen, excluded.last_seen)
  `).bind(
    row.site_id, row.visitor_id,
    row.fp_hash, row.ip24_hash, row.asn,
    row.bot_score, row.verdict, row.ts,
  );
}
