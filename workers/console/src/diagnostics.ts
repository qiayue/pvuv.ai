/**
 * Deployment self-check (console → /health.html).
 *
 * Server-side probes the console can run against its own bindings (D1, KV,
 * config, secrets) plus a helper that confirms a browser-sent test event made
 * it all the way through ingest → Queue → consumer → D1. The queue/consumer/
 * ingest workers have no route into the console, so the end-to-end path is
 * exercised from the browser (health.html) and confirmed via probeEvent here.
 */

import { CONFIG } from '../../../shared/config.gen';
import { monthSuffix, eventsTableName } from '../../../shared/events';

export type CheckStatus = 'ok' | 'warn' | 'fail';
export interface Check {
  key: string;
  label: string;
  status: CheckStatus;
  detail: string;
  /** when failing/warning: how to fix */
  fix?: string;
}

interface DiagEnv {
  DB: D1Database;
  SITE_CONFIG: KVNamespace;
  HMAC_KEY?: string;
  ADMIN_EMAILS?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
}

const REQUIRED_TABLES = [
  'users', 'sites', 'sessions', 'identities', 'visitor_profiles',
  'rollup_page_daily', 'rollup_source_daily', 'rollup_site_daily',
  'cluster_flags', 'anomaly_reports', 'ai_reports', 'instance_settings',
];

export async function runDiagnostics(env: DiagEnv): Promise<Check[]> {
  const checks: Check[] = [];

  // 1. database connectivity
  let dbOk = false;
  try {
    await env.DB.prepare('SELECT 1').first();
    dbOk = true;
    checks.push({ key: 'db', label: 'Database (D1) reachable', status: 'ok', detail: 'connected' });
  } catch (e) {
    checks.push({
      key: 'db', label: 'Database (D1) reachable', status: 'fail',
      detail: String(e), fix: 'Check the DB binding / database_id in workers/console/wrangler.toml.',
    });
  }

  // 2. schema / migrations
  if (dbOk) {
    try {
      const rows = await env.DB
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all<{ name: string }>();
      const present = new Set(rows.results.map((r) => r.name));
      const missing = REQUIRED_TABLES.filter((t) => !present.has(t));
      if (missing.length === 0) {
        checks.push({ key: 'schema', label: 'Schema & migrations applied', status: 'ok', detail: `${REQUIRED_TABLES.length} tables present` });
      } else {
        checks.push({
          key: 'schema', label: 'Schema & migrations applied', status: 'fail',
          detail: `missing tables: ${missing.join(', ')}`,
          fix: 'Run `npm run db:migrate:remote` (applies migrations/ to your D1).',
        });
      }
      // latest-migration marker: sites.timezone (0004) on the always-present
      // sites table
      try {
        await env.DB.prepare('SELECT timezone FROM sites LIMIT 1').first();
      } catch {
        checks.push({
          key: 'migration_latest', label: 'Latest migrations applied', status: 'warn',
          detail: 'sites.timezone missing',
          fix: 'Run `npm run db:migrate:remote` to apply the newest migrations.',
        });
      }
    } catch (e) {
      checks.push({ key: 'schema', label: 'Schema & migrations applied', status: 'fail', detail: String(e) });
    }
  }

  // 3. secrets / vars present (presence only — never their values)
  const secretRows: Array<[string, unknown, string]> = [
    ['HMAC_KEY (secret)', env.HMAC_KEY, 'wrangler secret put HMAC_KEY -c workers/console/wrangler.toml (same value on ingest + api)'],
    ['ADMIN_EMAILS (var)', env.ADMIN_EMAILS, 'set [vars] ADMIN_EMAILS in workers/console/wrangler.toml (comma-separated)'],
  ];
  for (const [label, val, fix] of secretRows) {
    checks.push(val
      ? { key: `secret:${label}`, label, status: 'ok', detail: 'set' }
      : { key: `secret:${label}`, label, status: 'fail', detail: 'not set', fix });
  }

  // login providers: at least one OAuth provider must be configured, or nobody
  // can sign in (there is no password login)
  const googleOk = !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
  const githubOk = !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
  checks.push(googleOk || githubOk
    ? { key: 'oauth', label: 'Login provider configured', status: 'ok', detail: `${[googleOk && 'Google', githubOk && 'GitHub'].filter(Boolean).join(' + ')} ready` }
    : { key: 'oauth', label: 'Login provider configured', status: 'fail', detail: 'no OAuth provider set — nobody can sign in',
        fix: 'Configure Google and/or GitHub OAuth (client id var + secret). See DEPLOY.md.' });

  // 4. scoring config loaded and sane
  try {
    const b = CONFIG.bands;
    const weightCount = Object.keys(CONFIG.weights).length;
    if (b.clean_max < b.suspect_max && weightCount >= 10) {
      checks.push({ key: 'config', label: 'Scoring config loaded', status: 'ok', detail: `bands ${b.clean_max}/${b.suspect_max}, ${weightCount} weights` });
    } else {
      checks.push({ key: 'config', label: 'Scoring config loaded', status: 'warn', detail: 'config present but values look off', fix: 'Review config.local.toml / config.example.toml and re-run `npm run config:gen`.' });
    }
  } catch (e) {
    checks.push({ key: 'config', label: 'Scoring config loaded', status: 'fail', detail: String(e) });
  }

  // 5. KV SITE_CONFIG round-trip
  try {
    const probeKey = '__diag_probe';
    await env.SITE_CONFIG.put(probeKey, 'ok', { expirationTtl: 60 });
    const got = await env.SITE_CONFIG.get(probeKey);
    await env.SITE_CONFIG.delete(probeKey);
    checks.push(got === 'ok'
      ? { key: 'kv', label: 'KV (SITE_CONFIG) read/write', status: 'ok', detail: 'round-trip ok' }
      : { key: 'kv', label: 'KV (SITE_CONFIG) read/write', status: 'fail', detail: 'value did not round-trip', fix: 'Check the SITE_CONFIG KV binding id.' });
  } catch (e) {
    checks.push({ key: 'kv', label: 'KV (SITE_CONFIG) read/write', status: 'fail', detail: String(e), fix: 'Create the SITE_CONFIG namespace and set its id in wrangler.toml.' });
  }

  // 6. data-flow status (informational)
  if (dbOk) {
    try {
      const sites = await env.DB.prepare('SELECT COUNT(*) AS n FROM sites').first<{ n: number }>();
      checks.push({ key: 'sites', label: 'Registered sites', status: 'ok', detail: `${sites?.n ?? 0} site(s)` });
    } catch { /* table checked above */ }
    try {
      const roll = await env.DB.prepare('SELECT COUNT(*) AS n FROM rollup_site_daily').first<{ n: number }>();
      const n = roll?.n ?? 0;
      checks.push(n > 0
        ? { key: 'rollup', label: 'Hourly rollup has run', status: 'ok', detail: `${n} day/site rollup row(s)` }
        : { key: 'rollup', label: 'Hourly rollup has run', status: 'warn', detail: 'no rollup rows yet', fix: 'Rollups run at :05 each hour; wait for the next run, or confirm the cron worker is deployed.' });
    } catch { /* table checked above */ }
  }

  return checks;
}

/**
 * Look for a browser-sent self-test event by its marker visitor_id in the
 * current + previous month partitions. Returns the enriched/scored row if the
 * whole ingest→queue→consumer→D1 path worked.
 */
export async function probeEvent(
  env: DiagEnv, siteId: string, vid: string, now: number,
): Promise<{ found: boolean; row?: Record<string, unknown> }> {
  const suffixes = [monthSuffix(now), monthSuffix(now - 3 * 86400e3)];
  for (const suffix of [...new Set(suffixes)]) {
    try {
      const row = await env.DB.prepare(`
        SELECT event, path, country, browser, os, device_type, asn_type,
               bot_score, verdict, bot_flags, score_stage, ts
        FROM ${eventsTableName(suffix)}
        WHERE site_id = ? AND visitor_id = ? ORDER BY id DESC LIMIT 1
      `).bind(siteId, vid).first<Record<string, unknown>>();
      if (row) return { found: true, row };
    } catch {
      /* table for that month doesn't exist yet — keep looking */
    }
  }
  return { found: false };
}
