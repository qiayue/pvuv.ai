/**
 * Daily population/batch analysis (PROJECT_PLAN.md §6.4–6.5) — M2.
 *
 * Finds "the same hand" behind many visitor_ids and closes the loop:
 *
 *   events (last day) ──┬─► Welford per-visitor interval stats → visitor_profiles
 *                       ├─► fingerprint clusters   (fp_hash shared by ≥N visitors)
 *                       ├─► /24 clusters           (one subnet ≥ share of a site's traffic)
 *                       ├─► cookie-reset detection (same fp+/24, one-shot visitor_ids)
 *                       ▼
 *                 cluster_flags (evidence, TTL)
 *                       ├─► KV BLOCKLIST  bl:fp:* / bl:ip24:*  → read back by /v and /in
 *                       └─► batch re-verdict of the window's events/sessions/profiles
 *                             (score_stage='batch') → affected daily rollups recomputed
 *
 * Data-correctness invariants:
 * - Every event is folded into the Welford stats EXACTLY once: the job reads
 *   events in (watermark, now−lag] and advances the watermark (instance_settings)
 *   only after the batch commits. Welford's parallel-merge needs the stored
 *   sample count (visitor_profiles.interval_n, migration 0007) to be exact.
 * - Re-verdict is idempotent: events/sessions are guarded by the
 *   BLOCKLIST_CLUSTER flag bit; profiles use MAX() semantics.
 * - All thresholds come from config (§21) — nothing tuned here.
 * - Safeguards (§6.4): bare-IP /24 clusters default to 'observe' only
 *   (share_bare_ip=false) — CGNAT/campus networks make raw IP evidence weak;
 *   fp-backed clusters block. Blocklist entries carry a TTL and decay.
 *
 * Behavior-sequence (path-signature) clustering and distribution tests are M3.
 */

import type { Env } from './index';
import { CONFIG } from '../../../shared/config.gen';
import { FLAG } from '../../../shared/flags';
import { monthSuffix, eventsTableName } from '../../../shared/events';
import { localYMD, localDaySpan, addDays } from '../../../shared/tz';
import { existingEventTables, rollupSiteDay } from './rollup';

const WATERMARK_KEY = 'batch_watermark_ts';
/** Ingest→queue→consumer settle lag before we consider events final. */
const SETTLE_LAG_MS = 5 * 60_000;
const DAY_MS = 86_400_000;

interface Cluster {
  id: string;
  type: 'fp' | 'ip24' | 'cookie_reset';
  siteId: string | null;          // null = cross-site/global
  members: number;
  sites: number;
  events: number;
  action: 'block' | 'observe';
  /** blocklist / re-verdict handles */
  fp?: string;
  ip24?: string;
}

export async function runDailyBatch(env: Env): Promise<void> {
  const db = env.DB;
  const now = Date.now();
  const end = now - SETTLE_LAG_MS;

  // window (watermark, end]: each event analyzed exactly once; cap the lookback
  // at 48h so a long outage doesn't make one run unbounded.
  const wm = await readWatermark(db);
  const start = Math.max(wm ?? end - DAY_MS, end - 2 * DAY_MS);
  if (end <= start) return;

  const existing = await existingEventTables(db);
  const tables = tablesFor(start, end, existing);
  if (tables.length === 0) {
    await writeWatermark(db, end);
    return;
  }
  const u = (cols: string, extra = '') => unionOver(tables, cols, start, end, extra);

  // ---- 1. Welford per-visitor interval stats + active hours + session counts
  await updateProfiles(db, u, start, end);

  // ---- 2–4. cluster detection ------------------------------------------------
  const P = CONFIG.population;
  const cap = P.max_clusters_per_run || 50;
  const clusters: Cluster[] = [
    ...(await fpClusters(db, u, P.fp_cluster_min_visitors, cap)),
    ...(await ip24Clusters(db, u, P.ip24_share_threshold, P.ip24_min_events, cap)),
    ...(await cookieResetClusters(db, u, P.cookie_reset_min_visitors, P.cookie_reset_epv_max, cap)),
  ];

  // ---- record evidence + write the KV blocklist (loops back to /v, /in) ------
  const ttlSec = Math.max(1, CONFIG.blocklist.default_ttl_days) * 86_400;
  const nowTs = Date.now();
  const flagStmts = clusters.map((c) => db.prepare(`
    INSERT OR REPLACE INTO cluster_flags (cluster_id, site_id, type, member_count, evidence, action, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    c.id, c.siteId, c.type, c.members,
    JSON.stringify({ members: c.members, sites: c.sites, events: c.events, window: { start, end }, fp: c.fp ?? null, ip24: c.ip24 ?? null }),
    c.action, nowTs, nowTs + ttlSec * 1000,
  ));
  if (flagStmts.length) await db.batch(flagStmts);

  for (const c of clusters) {
    if (c.action !== 'block') continue;
    const value = JSON.stringify({ cluster: c.id, members: c.members, at: nowTs });
    if (c.fp) await env.BLOCKLIST.put(`bl:fp:${c.fp}`, value, { expirationTtl: ttlSec });
    if (c.ip24 && !c.fp) await env.BLOCKLIST.put(`bl:ip24:${c.ip24}`, value, { expirationTtl: ttlSec });
  }

  // ---- 5. batch re-verdict of the window's events for blocking clusters ------
  // fp-backed clusters (fp + cookie_reset) are global → re-verdicted in ONE
  // pass over each table (IN-list), regardless of cluster count. Bare-IP /24
  // clusters (opt-in, rare) are site-scoped and handled individually.
  const blocking = clusters.filter((c) => c.action === 'block');
  const fps = [...new Set(blocking.filter((c) => c.fp).map((c) => c.fp!))];
  const ip24Only = blocking.filter((c) => !c.fp && c.ip24);
  const affectedSites = await reverdict(db, tables, start, end, fps, ip24Only);

  // ---- 6. mechanical-timing profiles: population-level escalation ------------
  await db.prepare(`
    UPDATE visitor_profiles SET verdict = 'suspect'
    WHERE interval_n >= ? AND interval_mean > 0 AND interval_cv IS NOT NULL
      AND interval_cv <= ? AND verdict = 'clean'
  `).bind(P.interval_min_n, P.interval_cv_bot_ceiling).run();

  // ---- 7. recompute the daily rollups the re-verdict touched -----------------
  await recomputeAffectedRollups(db, affectedSites, start, end, existing);

  await writeWatermark(db, end);
  console.log(`batch: window=${new Date(start).toISOString()}..${new Date(end).toISOString()} clusters=${clusters.length} (block=${clusters.filter((c) => c.action === 'block').length}) sites_reverdicted=${affectedSites.size}`);
}

// ---------------------------------------------------------------------------
// window / union helpers
// ---------------------------------------------------------------------------

function tablesFor(startTs: number, endTs: number, existing: Set<string>): string[] {
  const months = new Set([monthSuffix(startTs), monthSuffix(endTs - 1)]);
  return [...months].map(eventsTableName).filter((t) => existing.has(t)).sort();
}

interface Union { sql: string; binds: unknown[] }
function unionOver(tables: string[], cols: string, startTs: number, endTs: number, extra = ''): Union {
  const parts = tables.map((t) => `SELECT ${cols} FROM ${t} WHERE ts > ? AND ts <= ?${extra ? ` AND ${extra}` : ''}`);
  return { sql: `(${parts.join(' UNION ALL ')})`, binds: tables.flatMap(() => [startTs, endTs]) };
}

async function readWatermark(db: D1Database): Promise<number | null> {
  try {
    const r = await db.prepare('SELECT value FROM instance_settings WHERE key = ?').bind(WATERMARK_KEY).first<{ value: string }>();
    const n = r ? parseInt(r.value, 10) : NaN;
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}
async function writeWatermark(db: D1Database, ts: number): Promise<void> {
  await db.prepare(`
    INSERT INTO instance_settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).bind(WATERMARK_KEY, String(ts), Date.now()).run();
}

// ---------------------------------------------------------------------------
// 1. per-visitor profile stats (Welford merge, exact — §6.5)
// ---------------------------------------------------------------------------

async function updateProfiles(
  db: D1Database, u: (cols: string, extra?: string) => Union, startTs: number, endTs: number,
): Promise<void> {
  // Welford parallel-merge of each visitor's window interval stats into the
  // stored aggregate — a SINGLE set-based UPDATE...FROM (no per-visitor
  // statements, no rows streamed into the isolate). SET expressions read the
  // OLD visitor_profiles values (vp.*) and the window aggregate (w.*):
  //   N = n0+n1;  mean = (mean0·n0 + mean1·n1)/N;  M2 = m2_0 + m2_1 + δ²·n0·n1/N
  // Window stats in SQL: n intervals, mean, M2 = Σd² − n·mean² (≡ Welford's M2);
  // active-hours bitmask via SUM(DISTINCT 1<<hour) (== bitwise OR of the powers).
  const uv = u('site_id, visitor_id, ts');
  await db.prepare(`
    UPDATE visitor_profiles AS vp SET
      interval_m2 = CASE WHEN vp.interval_n + w.n > 0
        THEN COALESCE(vp.interval_m2, 0) + w.m2
             + (w.mean - COALESCE(vp.interval_mean, 0)) * (w.mean - COALESCE(vp.interval_mean, 0))
               * vp.interval_n * w.n / (vp.interval_n + w.n)
        ELSE vp.interval_m2 END,
      interval_mean = CASE WHEN vp.interval_n + w.n > 0
        THEN (COALESCE(vp.interval_mean, 0) * vp.interval_n + w.mean * w.n) / (vp.interval_n + w.n)
        ELSE vp.interval_mean END,
      interval_n = vp.interval_n + w.n,
      active_hours = COALESCE(vp.active_hours, 0) | w.hour_bits
    FROM (
      WITH ev AS (SELECT * FROM ${uv.sql}),
      iv AS (
        SELECT site_id, visitor_id,
               ts - LAG(ts) OVER (PARTITION BY site_id, visitor_id ORDER BY ts) AS d
        FROM ev
      ),
      hours AS (
        SELECT site_id, visitor_id,
               CAST(SUM(DISTINCT 1 << CAST((ts / 3600000) % 24 AS INTEGER)) AS INTEGER) AS hour_bits
        FROM ev GROUP BY site_id, visitor_id
      ),
      stats AS (
        SELECT site_id, visitor_id, COUNT(d) AS n, AVG(d) AS mean,
               MAX(SUM(d * d) - COUNT(d) * AVG(d) * AVG(d), 0) AS m2
        FROM iv WHERE d IS NOT NULL AND d >= 0
        GROUP BY site_id, visitor_id
      )
      SELECT h.site_id AS site_id, h.visitor_id AS visitor_id,
             COALESCE(s.n, 0) AS n, COALESCE(s.mean, 0) AS mean, COALESCE(s.m2, 0) AS m2, h.hour_bits AS hour_bits
      FROM hours h LEFT JOIN stats s ON s.site_id = h.site_id AND s.visitor_id = h.visitor_id
    ) AS w
    WHERE vp.site_id = w.site_id AND vp.visitor_id = w.visitor_id
  `).bind(...uv.binds).run();

  // derived CV in one pass (sqrt is available in D1's SQLite build)
  await db.prepare(`
    UPDATE visitor_profiles SET interval_cv =
      CASE WHEN interval_n > 0 AND COALESCE(interval_mean, 0) > 0
           THEN sqrt(MAX(interval_m2, 0) / interval_n) / interval_mean END
    WHERE interval_n > 0
  `).run();

  // sessions_count: sessions whose started_at falls in the window — each
  // session counted exactly once because started_at never changes.
  await db.prepare(`
    UPDATE visitor_profiles SET sessions_count = sessions_count + (
      SELECT COUNT(*) FROM sessions s
      WHERE s.site_id = visitor_profiles.site_id AND s.visitor_id = visitor_profiles.visitor_id
        AND s.started_at > ?1 AND s.started_at <= ?2
    )
    WHERE EXISTS (
      SELECT 1 FROM sessions s2
      WHERE s2.site_id = visitor_profiles.site_id AND s2.visitor_id = visitor_profiles.visitor_id
        AND s2.started_at > ?1 AND s2.started_at <= ?2
    )
  `).bind(startTs, endTs).run();
}

// ---------------------------------------------------------------------------
// 2. fingerprint clusters — one fingerprint behind many visitor_ids (§6.4)
// ---------------------------------------------------------------------------

async function fpClusters(
  db: D1Database, u: (cols: string, extra?: string) => Union, minVisitors: number, cap: number,
): Promise<Cluster[]> {
  const uv = u('fp_hash, visitor_id, site_id', 'fp_hash IS NOT NULL');
  const rows = await db.prepare(`
    SELECT fp_hash, COUNT(DISTINCT visitor_id) AS members, COUNT(DISTINCT site_id) AS sites, COUNT(*) AS events
    FROM ${uv.sql} GROUP BY fp_hash
    HAVING COUNT(DISTINCT visitor_id) >= ? ORDER BY members DESC LIMIT ?
  `).bind(...uv.binds, minVisitors, cap).all<{ fp_hash: string; members: number; sites: number; events: number }>();
  return rows.results.map((r) => ({
    id: `fp:${r.fp_hash}`, type: 'fp' as const, siteId: null,
    members: r.members, sites: r.sites, events: r.events,
    action: 'block' as const, fp: r.fp_hash,
  }));
}

// ---------------------------------------------------------------------------
// 3. /24 clusters — one subnet dominating a site's traffic (§6.4).
//    Bare-IP evidence is weak (CGNAT/campus) → 'observe' unless the deployer
//    opts in via [blocklist].share_bare_ip.
// ---------------------------------------------------------------------------

async function ip24Clusters(
  db: D1Database, u: (cols: string, extra?: string) => Union, shareMin: number, minEvents: number, cap: number,
): Promise<Cluster[]> {
  const uv = u('site_id, ip24_hash, visitor_id', "event = 'pageview' AND ip24_hash IS NOT NULL");
  const rows = await db.prepare(`
    WITH ev AS (SELECT * FROM ${uv.sql}),
    tot AS (SELECT site_id, COUNT(*) AS total FROM ev GROUP BY site_id)
    SELECT e.site_id, e.ip24_hash, COUNT(*) AS events, COUNT(DISTINCT e.visitor_id) AS members, t.total AS total
    FROM ev e JOIN tot t ON t.site_id = e.site_id
    GROUP BY e.site_id, e.ip24_hash, t.total
    HAVING COUNT(*) >= ? AND COUNT(*) * 1.0 / t.total >= ?
    ORDER BY events DESC LIMIT ?
  `).bind(...uv.binds, minEvents, shareMin, cap).all<{ site_id: string; ip24_hash: string; events: number; members: number; total: number }>();
  const action = CONFIG.blocklist.share_bare_ip ? 'block' as const : 'observe' as const;
  return rows.results.map((r) => ({
    id: `ip24:${r.site_id}:${r.ip24_hash}`, type: 'ip24' as const, siteId: r.site_id,
    members: r.members, sites: 1, events: r.events,
    action, ip24: r.ip24_hash,
  }));
}

// ---------------------------------------------------------------------------
// 4. cookie-reset farms — same fp + /24 cycling one-shot visitor_ids (§6.4).
//    fp+network+behavior evidence → strong enough to block.
// ---------------------------------------------------------------------------

async function cookieResetClusters(
  db: D1Database, u: (cols: string, extra?: string) => Union, minVisitors: number, epvMax: number, cap: number,
): Promise<Cluster[]> {
  const uv = u('fp_hash, ip24_hash, visitor_id, site_id', 'fp_hash IS NOT NULL AND ip24_hash IS NOT NULL');
  const rows = await db.prepare(`
    SELECT fp_hash, ip24_hash, COUNT(DISTINCT visitor_id) AS members, COUNT(*) AS events, COUNT(DISTINCT site_id) AS sites
    FROM ${uv.sql} GROUP BY fp_hash, ip24_hash
    HAVING COUNT(DISTINCT visitor_id) >= ?
       AND COUNT(*) * 1.0 / COUNT(DISTINCT visitor_id) <= ?
    ORDER BY members DESC LIMIT ?
  `).bind(...uv.binds, minVisitors, epvMax, cap).all<{ fp_hash: string; ip24_hash: string; members: number; events: number; sites: number }>();
  return rows.results.map((r) => ({
    id: `cr:${r.fp_hash}:${r.ip24_hash}`, type: 'cookie_reset' as const, siteId: null,
    members: r.members, sites: r.sites, events: r.events,
    action: 'block' as const, fp: r.fp_hash, ip24: r.ip24_hash,
  }));
}

// ---------------------------------------------------------------------------
// 5. batch re-verdict (§6.4 output): flag + rescore the window's events of a
//    blocking cluster; propagate to their sessions and member profiles.
//    Idempotent via the BLOCKLIST_CLUSTER flag bit / MAX() semantics.
// ---------------------------------------------------------------------------

async function reverdict(
  db: D1Database, tables: string[], startTs: number, endTs: number, fps: string[], ip24Clusters: Cluster[],
): Promise<Set<string>> {
  const flag = FLAG.BLOCKLIST_CLUSTER;
  const w = typeof CONFIG.weights.blocklist_cluster === 'number' ? CONFIG.weights.blocklist_cluster : 40;
  const { clean_max, suspect_max } = CONFIG.bands;
  const affected = new Set<string>();

  // shared verdict-recompute SET clause (SET RHS reads OLD values, so the band
  // CASE evaluates the new-score expression, not the assigned column).
  const setClause = `
    bot_flags = bot_flags | ${flag},
    bot_score = MIN(100, bot_score + ${w}),
    verdict   = CASE WHEN verdict = 'crawler' THEN verdict
                     WHEN MIN(100, bot_score + ${w}) > ${suspect_max} THEN 'bot'
                     WHEN MIN(100, bot_score + ${w}) > ${clean_max} THEN 'suspect'
                     ELSE verdict END`;
  const profileSet = (cond: string, binds: unknown[]) => db.prepare(`
    UPDATE visitor_profiles SET
      bot_score = MAX(bot_score, ${w}),
      verdict   = CASE WHEN verdict = 'crawler' THEN verdict
                       WHEN MAX(bot_score, ${w}) > ${suspect_max} THEN 'bot'
                       WHEN MAX(bot_score, ${w}) > ${clean_max} THEN 'suspect'
                       ELSE verdict END
    WHERE ${cond}`).bind(...binds);

  // helper: re-verdict events + their sessions for a WHERE predicate, per table
  const pass = async (pred: string, predBinds: unknown[]) => {
    for (const t of tables) {
      const s = await db.prepare(`SELECT DISTINCT site_id FROM ${t} WHERE ts > ? AND ts <= ? AND ${pred}`).bind(startTs, endTs, ...predBinds).all<{ site_id: string }>();
      s.results.forEach((r) => affected.add(r.site_id));
      if (s.results.length === 0) continue;
      await db.prepare(`UPDATE ${t} SET ${setClause}, score_stage = 'batch' WHERE ts > ? AND ts <= ? AND ${pred} AND (bot_flags & ${flag}) = 0 AND verdict != 'crawler'`).bind(startTs, endTs, ...predBinds).run();
      await db.prepare(`UPDATE sessions SET ${setClause} WHERE (bot_flags & ${flag}) = 0 AND session_id IN (SELECT DISTINCT session_id FROM ${t} WHERE ts > ? AND ts <= ? AND ${pred})`).bind(startTs, endTs, ...predBinds).run();
    }
  };

  // (1) fp-backed clusters (global, cross-site): ONE pass per table via IN-list
  if (fps.length) {
    const inC = fps.map(() => '?').join(',');
    await pass(`fp_hash IN (${inC})`, fps);
    await profileSet(`fp_hash IN (${inC})`, fps).run();
  }
  // (2) bare-IP /24 clusters (opt-in, rare): site-scoped, handled individually
  for (const c of ip24Clusters) {
    await pass('ip24_hash = ? AND site_id = ?', [c.ip24, c.siteId]);
    await profileSet('ip24_hash = ? AND site_id = ?', [c.ip24, c.siteId]).run();
  }
  return affected;
}

// ---------------------------------------------------------------------------
// 7. recompute the (site, local-day) rollups the re-verdict touched
// ---------------------------------------------------------------------------

async function recomputeAffectedRollups(
  db: D1Database, siteIds: Set<string>, startTs: number, endTs: number, existing: Set<string>,
): Promise<void> {
  if (siteIds.size === 0) return;
  const ids = [...siteIds];
  const rows = await db.prepare(
    `SELECT site_id, COALESCE(timezone, 'UTC') AS timezone FROM sites WHERE site_id IN (${ids.map(() => '?').join(',')})`,
  ).bind(...ids).all<{ site_id: string; timezone: string }>();

  for (const s of rows.results) {
    const tz = s.timezone || 'UTC';
    // every site-local calendar day overlapping the window (≤48h → ≤4 days)
    let d = localYMD(startTs, tz);
    const last = localYMD(endTs, tz);
    for (let i = 0; i < 5; i++) {
      const span = localDaySpan(tz, d.y, d.m0, d.d);
      await rollupSiteDay(db, s.site_id, span.day, span.startTs, span.endTs, existing);
      if (d.y === last.y && d.m0 === last.m0 && d.d === last.d) break;
      d = addDays(d.y, d.m0, d.d, 1);
    }
  }
}
