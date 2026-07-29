/**
 * Daily Cloudflare edge-request pull (PROJECT_PLAN.md §6.7) — OPTIONAL.
 *
 * Runs at the tail of the daily batch. If the deployer has not configured a
 * Cloudflare API token this is a single D1 read and an immediate return: the
 * feature is opt-in and its absence costs nothing.
 *
 * With a token, for each active site:
 *   1. match the site's domains to a zone the token can see
 *   2. for the last few LOCAL days, ask Cloudflare how many requests it served
 *   3. upsert into rollup_edge_daily / rollup_edge_agent_daily
 *
 * Days are the site's own local days (via localDaySpan), not UTC days, so the
 * edge counts sit on exactly the same day key as rollup_site_daily and the two
 * can be subtracted without a timezone correction.
 *
 * Failure policy: never fatal. One site's zone being unreadable must not stop
 * the others, and the whole job failing must not affect rollups, retention or
 * anomaly detection. The last outcome — including Cloudflare's own error text —
 * is written to instance_settings so the console can show the deployer WHY
 * nothing arrived instead of an empty panel.
 */

import type { Env } from './index';
import { localYMD, localDaySpan, addDays } from '../../../shared/tz';
import { listZones, zoneForDomains, edgeTotals, edgeAgents, MAX_AGENT_ROWS, type CfZone } from '../../../shared/cfedge';

export const CF_TOKEN_KEY = 'cf_api_token';
export const CF_STATUS_KEY = 'cf_edge_status';

/** Days re-pulled on every run. Cloudflare's analytics settle over minutes to
 *  hours, so yesterday alone would sometimes capture a partial figure; three
 *  days of idempotent re-writes make a late correction land on its own. */
const REFRESH_DAYS = 3;
/** Days pulled the first time a site is seen, so the panel is not empty for a
 *  week. Kept modest: retention on the adaptive dataset is plan-dependent and
 *  older days may simply come back as zero. */
const FIRST_RUN_DAYS = 14;
/** Ceiling on total Cloudflare queries per run — two per site-day. A deployment
 *  with many sites must not turn one cron invocation into a rate-limit event. */
const MAX_QUERIES = 300;

export interface EdgeStatus {
  ok: boolean;
  checked_at: number;
  zones?: number;
  sites_matched?: number;
  days_written?: number;
  /** Cloudflare's own message, verbatim — this is the actionable part. */
  error?: string;
}

async function writeStatus(db: D1Database, status: EdgeStatus): Promise<void> {
  try {
    await db.prepare(`
      INSERT INTO instance_settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).bind(CF_STATUS_KEY, JSON.stringify(status), Date.now()).run();
  } catch { /* settings table missing → nothing to report into */ }
}

export async function readCfToken(db: D1Database): Promise<string> {
  try {
    const r = await db.prepare('SELECT value FROM instance_settings WHERE key = ?')
      .bind(CF_TOKEN_KEY).first<{ value: string }>();
    return (r?.value ?? '').trim();
  } catch {
    return ''; // instance_settings not present yet → feature simply off
  }
}

/**
 * Verify a token and report what it can see. Shared with the console's "Test"
 * button so the deployer gets the same answer the cron would get.
 */
export async function verifyCfToken(token: string): Promise<{ zones: CfZone[] }> {
  return { zones: await listZones(token) };
}

export async function runEdgePull(env: Env): Promise<void> {
  const token = await readCfToken(env.DB);
  if (!token) return; // opt-in feature, not configured — nothing to do, nothing to report

  let zones: CfZone[];
  try {
    zones = await listZones(token);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error('edge: zone list failed', error);
    await writeStatus(env.DB, { ok: false, checked_at: Date.now(), error });
    return;
  }

  const sites = await env.DB.prepare(
    "SELECT site_id, allowed_domains, timezone FROM sites WHERE status = 'active'",
  ).all<{ site_id: string; allowed_domains: string; timezone: string }>();

  let queries = 0;
  let matched = 0;
  let written = 0;
  let firstError = '';

  for (const site of sites.results) {
    let domains: string[] = [];
    try { domains = JSON.parse(site.allowed_domains); } catch { /* malformed → no match */ }
    const zone = zoneForDomains(zones, Array.isArray(domains) ? domains : []);
    if (!zone) continue; // site isn't on a zone this token can see — expected, not an error
    matched++;

    const tz = site.timezone || 'UTC';
    // has this site been pulled before? if not, reach further back once
    const seen = await env.DB.prepare('SELECT 1 AS ok FROM rollup_edge_daily WHERE site_id = ? LIMIT 1')
      .bind(site.site_id).first<{ ok: number }>();
    const span = seen ? REFRESH_DAYS : FIRST_RUN_DAYS;

    const today = localYMD(Date.now(), tz);
    // start at yesterday: today is still accumulating and would store a partial
    // count that the next run has to correct anyway
    for (let back = 1; back <= span; back++) {
      if (queries + 2 > MAX_QUERIES) break;
      const ymd = addDays(today.y, today.m0, today.d, -back);
      const day = localDaySpan(tz, ymd.y, ymd.m0, ymd.d);
      try {
        queries += 2;
        const totals = await edgeTotals(token, zone.id, day.startTs, day.endTs);
        const agents = await edgeAgents(token, zone.id, day.startTs, day.endTs, MAX_AGENT_ROWS);

        const now = Date.now();
        const stmts = [
          env.DB.prepare(`
            INSERT INTO rollup_edge_daily (site_id, day, requests, html_requests, zone_tag, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(site_id, day) DO UPDATE SET
              requests = excluded.requests, html_requests = excluded.html_requests,
              zone_tag = excluded.zone_tag, updated_at = excluded.updated_at
          `).bind(site.site_id, day.day, totals.requests, totals.htmlRequests, zone.id, now),
          // replace rather than merge: a re-pull is the authoritative top-N for
          // that day, and merging would leave agents that dropped out of it
          env.DB.prepare('DELETE FROM rollup_edge_agent_daily WHERE site_id = ? AND day = ?')
            .bind(site.site_id, day.day),
          ...agents.map((a) => env.DB.prepare(`
            INSERT INTO rollup_edge_agent_daily (site_id, day, user_agent, requests) VALUES (?, ?, ?, ?)
            ON CONFLICT(site_id, day, user_agent) DO UPDATE SET requests = excluded.requests
          `).bind(site.site_id, day.day, a.userAgent, a.requests)),
        ];
        await env.DB.batch(stmts);
        written++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!firstError) firstError = msg;
        console.error(`edge: ${site.site_id} ${day.day} failed`, msg);
        break; // this zone is failing; don't spend the query budget re-proving it
      }
    }
  }

  await writeStatus(env.DB, {
    ok: !firstError,
    checked_at: Date.now(),
    zones: zones.length,
    sites_matched: matched,
    days_written: written,
    ...(firstError ? { error: firstError } : {}),
  });
  console.log(`edge: ${written} site-days from ${matched}/${sites.results.length} sites (${zones.length} zones)`);
}
