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
import { localYMD, addDays, dayStr } from '../../../shared/tz';

const ANOMALY_DEFAULTS = {
  baseline_days: 14, min_days: 5, spike_ratio: 3.0, drop_ratio: 0.34,
  min_pv: 100, min_source_uv: 30, invalid_jump: 0.15,
};

interface SiteDay { day: string; pv: number; uv: number; bot_count: number; suspect_count: number }
interface Finding { dimension: string; baseline: number; actual: number; deviation: number; evidence: string }

const mean = (a: number[]): number => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const mk = (dimension: string, kind: 'spike' | 'drop', baseline: number, actual: number, deviation: number, message: string): Finding =>
  ({ dimension, baseline, actual, deviation, evidence: JSON.stringify({ kind, message }) });

export async function runAnomalyDetection(env: { DB: D1Database }, now = Date.now()): Promise<void> {
  const C = { ...ANOMALY_DEFAULTS, ...(CONFIG.anomaly ?? {}) };
  const db = env.DB;
  const sites = await db.prepare(
    "SELECT site_id, COALESCE(timezone, 'UTC') AS tz FROM sites WHERE status = 'active'",
  ).all<{ site_id: string; tz: string }>();

  let flagged = 0;
  for (const site of sites.results) {
    flagged += await analyzeSite(db, site.site_id, site.tz, now, C);
  }
  console.log(`anomaly: scanned ${sites.results.length} site(s), flagged ${flagged}`);
}

async function analyzeSite(
  db: D1Database, siteId: string, tz: string, now: number, C: typeof ANOMALY_DEFAULTS,
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

  // idempotent: replace yesterday's reports for this site
  await db.prepare('DELETE FROM anomaly_reports WHERE site_id = ? AND day = ?').bind(siteId, yday).run();
  if (findings.length === 0) return 0;
  await db.batch(findings.map((f) => db.prepare(
    `INSERT INTO anomaly_reports (site_id, day, dimension, baseline, actual, deviation, evidence, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
  ).bind(siteId, yday, f.dimension, f.baseline, f.actual, f.deviation, f.evidence, now)));
  return findings.length;
}
