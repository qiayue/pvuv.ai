/**
 * pvuv.ai baseline anomaly detection (daily Cron) — PROJECT_PLAN.md §6.4, M3.
 *
 * Compares YESTERDAY (the most recent fully-rolled-up local day) against a
 * trailing per-day baseline built from the rollups, and writes anomaly_reports
 * for large deviations. Unlike the live "unreasonable data" alerts (which test
 * the current snapshot against fixed thresholds), this catches TRENDS: a
 * traffic spike/drop, an invalid-share jump, or a single source surging vs its
 * own recent norm (e.g. "Google traffic 3× the 14-day average").
 *
 * Idempotent per day: yesterday's prior reports are cleared before re-inserting,
 * so a re-run replaces rather than duplicates. Thresholds come from
 * CONFIG.anomaly (§21) with in-code defaults as a fallback.
 */

import { CONFIG } from '../../../shared/config.gen';
import { localYMD, localDaySpan, addDays, dayStr } from '../../../shared/tz';
import { monthSuffix, eventsTableName } from '../../../shared/events';
import { existingEventTables } from './rollup';

const ANOMALY_DEFAULTS = {
  baseline_days: 14, min_days: 5, spike_ratio: 3.0, drop_ratio: 0.34,
  min_pv: 100, min_source_uv: 30, invalid_jump: 0.15,
};

const DIST_DEFAULTS = {
  min_pv: 200, min_baseline_pv: 600, top_share_jump: 0.25, top_share_floor: 0.45, screen_bucket_px: 100,
};

interface SiteDay { day: string; pv: number; uv: number; bot_count: number; suspect_count: number }
interface Finding { dimension: string; baseline: number; actual: number; deviation: number; evidence: string }
interface TopRow { top_sig: string; top: number; total: number }

const mean = (a: number[]): number => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const mk = (dimension: string, kind: 'spike' | 'drop' | 'concentration', baseline: number, actual: number, deviation: number, message: string): Finding =>
  ({ dimension, baseline, actual, deviation, evidence: JSON.stringify({ kind, message }) });

export async function runAnomalyDetection(env: { DB: D1Database }, now = Date.now()): Promise<void> {
  const C = { ...ANOMALY_DEFAULTS, ...(CONFIG.anomaly ?? {}) };
  const D = { ...DIST_DEFAULTS, ...(CONFIG.distribution ?? {}) };
  const db = env.DB;
  const existing = await existingEventTables(db);
  const sites = await db.prepare(
    "SELECT site_id, COALESCE(timezone, 'UTC') AS tz FROM sites WHERE status = 'active'",
  ).all<{ site_id: string; tz: string }>();

  let flagged = 0;
  for (const site of sites.results) {
    flagged += await analyzeSite(db, site.site_id, site.tz, now, C, D, existing);
  }
  console.log(`anomaly: scanned ${sites.results.length} site(s), flagged ${flagged}`);
}

async function analyzeSite(
  db: D1Database, siteId: string, tz: string, now: number,
  C: typeof ANOMALY_DEFAULTS, D: typeof DIST_DEFAULTS, existing: Set<string>,
): Promise<number> {
  const today = localYMD(now, tz);
  const y = addDays(today.y, today.m0, today.d, -1);            // yesterday (complete)
  const yday = dayStr(y.y, y.m0, y.d);
  const b = addDays(y.y, y.m0, y.d, -C.baseline_days);          // window start
  const baseStart = dayStr(b.y, b.m0, b.d);

  const findings: Finding[] = [];

  // --- site-level: pageviews, invalid share ---
  const siteRows = (await db.prepare(
    `SELECT day, pv, uv, bot_count, suspect_count
     FROM rollup_site_daily WHERE site_id = ? AND day BETWEEN ? AND ? ORDER BY day`,
  ).bind(siteId, baseStart, yday).all<SiteDay>()).results;

  const target = siteRows.find((r) => r.day === yday);
  const base = siteRows.filter((r) => r.day !== yday);

  if (target && base.length >= C.min_days) {
    const pvBase = mean(base.map((r) => r.pv));
    if (pvBase >= C.min_pv && target.pv > 0) {
      const dev = target.pv / pvBase;
      if (dev >= C.spike_ratio) {
        findings.push(mk('pageviews', 'spike', pvBase, target.pv, dev,
          `Pageviews ${dev.toFixed(1)}× the ${base.length}-day average (${Math.round(pvBase)} → ${target.pv})`));
      } else if (dev <= C.drop_ratio) {
        findings.push(mk('pageviews', 'drop', pvBase, target.pv, dev,
          `Pageviews fell to ${Math.round(dev * 100)}% of the ${base.length}-day average (${Math.round(pvBase)} → ${target.pv})`));
      }
    }
    const shareOf = (r: SiteDay) => (r.pv ? (r.bot_count + r.suspect_count) / r.pv : 0);
    const invBase = mean(base.map(shareOf));
    const invNow = shareOf(target);
    if (target.pv >= C.min_pv && invNow - invBase >= C.invalid_jump) {
      findings.push(mk('invalid_share', 'spike', invBase, invNow, invBase ? invNow / invBase : 0,
        `Invalid traffic ${Math.round(invNow * 100)}% of pageviews vs ${Math.round(invBase * 100)}% baseline`));
    }
  }

  // --- per-source: a single source surging vs its own recent norm ---
  const srcRows = (await db.prepare(
    `SELECT day, COALESCE(source, '(direct)') AS source, uv
     FROM rollup_source_daily WHERE site_id = ? AND day BETWEEN ? AND ?`,
  ).bind(siteId, baseStart, yday).all<{ day: string; source: string; uv: number }>()).results;

  const bySource = new Map<string, { base: number[]; today: number }>();
  for (const r of srcRows) {
    let g = bySource.get(r.source);
    if (!g) { g = { base: [], today: 0 }; bySource.set(r.source, g); }
    if (r.day === yday) g.today += r.uv; else g.base.push(r.uv);
  }
  for (const [source, g] of bySource) {
    if (source === '(direct)' || g.base.length < C.min_days) continue; // direct surges are usually benign
    const bmean = mean(g.base);
    if (bmean >= C.min_source_uv && g.today > 0) {
      const dev = g.today / bmean;
      if (dev >= C.spike_ratio) {
        findings.push(mk(`source:${source}`, 'spike', bmean, g.today, dev,
          `Traffic from “${source}” ${dev.toFixed(1)}× its ${g.base.length}-day average (${Math.round(bmean)} → ${g.today} visitors)`));
      }
    }
  }

  // --- distribution-shape: clean-traffic concentration jump vs baseline (§6.4) ---
  // A farm whose hits each pass as "clean" still collapses the clean traffic
  // onto one device profile / landing page. Compare yesterday's top-value share
  // against the baseline window's; flag a JUMP (so a site that is legitimately
  // concentrated stays quiet — only a change trips it).
  const ys = localDaySpan(tz, y.y, y.m0, y.d);                 // yesterday span
  const bStart = localDaySpan(tz, b.y, b.m0, b.d).startTs;      // baseline window start
  const tables = tablesForSpan(bStart, ys.endTs, existing);
  if (tables.length) {
    const bkt = Math.max(1, Math.round(D.screen_bucket_px));
    const devToday = await deviceTop(db, tables, siteId, ys.startTs, ys.endTs, bkt);
    const devBase = await deviceTop(db, tables, siteId, bStart, ys.startTs, bkt);
    const f1 = concentrationFinding('device', 'Clean traffic collapsed onto one device profile', 'pageviews', devToday, devBase, D);
    if (f1) findings.push(f1);
  }
  const entToday = await entryTop(db, siteId, ys.startTs, ys.endTs);
  const entBase = await entryTop(db, siteId, bStart, ys.startTs);
  const f2 = concentrationFinding('entry_page', 'Clean visits concentrated on one landing page', 'sessions', entToday, entBase, D);
  if (f2) findings.push(f2);

  // idempotent: replace yesterday's reports for this site
  await db.prepare('DELETE FROM anomaly_reports WHERE site_id = ? AND day = ?').bind(siteId, yday).run();
  if (findings.length === 0) return 0;
  await db.batch(findings.map((f) => db.prepare(
    `INSERT INTO anomaly_reports (site_id, day, dimension, baseline, actual, deviation, evidence, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
  ).bind(siteId, yday, f.dimension, f.baseline, f.actual, f.deviation, f.evidence, now)));
  return findings.length;
}

// ---------------------------------------------------------------------------
// distribution-shape helpers (§6.4)
// ---------------------------------------------------------------------------

/** Monthly event partitions covering a UTC [start, end) span that exist. */
function tablesForSpan(startTs: number, endTs: number, existing: Set<string>): string[] {
  const months = new Set([monthSuffix(startTs), monthSuffix(endTs - 1)]);
  return [...months].map(eventsTableName).filter((t) => existing.has(t)).sort();
}

/** Top device signature (browser|os|screen-width bucket) among CLEAN pageviews
 *  in the span, with its count and the total — one row, or null if no data. */
async function deviceTop(
  db: D1Database, tables: string[], siteId: string, startTs: number, endTs: number, bucket: number,
): Promise<TopRow | null> {
  if (tables.length === 0) return null;
  const sig = `COALESCE(browser,'?')||'|'||COALESCE(os,'?')||'|'||CAST(COALESCE(screen_w,0)/${bucket} AS INT)`;
  const parts = tables.map((t) =>
    `SELECT ${sig} AS sig FROM ${t} WHERE site_id = ? AND event = 'pageview' AND verdict = 'clean' AND ts >= ? AND ts < ?`);
  const binds = tables.flatMap(() => [siteId, startTs, endTs]);
  return db.prepare(`
    WITH e AS (${parts.join(' UNION ALL ')}), g AS (SELECT sig, COUNT(*) AS c FROM e GROUP BY sig)
    SELECT sig AS top_sig, c AS top, (SELECT SUM(c) FROM g) AS total FROM g ORDER BY c DESC LIMIT 1
  `).bind(...binds).first<TopRow>();
}

/** Top entry page among CLEAN sessions in the span. */
async function entryTop(db: D1Database, siteId: string, startTs: number, endTs: number): Promise<TopRow | null> {
  return db.prepare(`
    WITH g AS (
      SELECT COALESCE(entry_page, '?') AS sig, COUNT(*) AS c FROM sessions
      WHERE site_id = ? AND started_at >= ? AND started_at < ? AND verdict = 'clean' GROUP BY sig
    )
    SELECT sig AS top_sig, c AS top, (SELECT SUM(c) FROM g) AS total FROM g ORDER BY c DESC LIMIT 1
  `).bind(siteId, startTs, endTs).first<TopRow>();
}

/** Build a finding when yesterday's top-value share is both high in absolute
 *  terms and much higher than the baseline's — a concentration jump. */
function concentrationFinding(
  dim: string, label: string, unit: string,
  today: TopRow | null, base: TopRow | null, D: typeof DIST_DEFAULTS,
): Finding | null {
  if (!today || !base || !today.total || !base.total) return null;
  if (today.total < D.min_pv || base.total < D.min_baseline_pv) return null;
  const tShare = today.top / today.total;
  const bShare = base.top / base.total;
  if (tShare < D.top_share_floor || tShare - bShare < D.top_share_jump) return null;
  return mk(`dist:${dim}`, 'concentration', bShare, tShare, bShare ? tShare / bShare : 0,
    `${label}: “${today.top_sig}” is ${Math.round(tShare * 100)}% of clean ${unit} vs ${Math.round(bShare * 100)}% baseline`);
}
