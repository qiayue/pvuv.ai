#!/usr/bin/env node
/**
 * pvuv.ai CLI (PROJECT_PLAN.md §10) — read a deployment's data from a terminal
 * or a script, so analytics can feed cron jobs, dashboards and pipelines without
 * a browser.
 *
 * Shares the API client and vocabularies with the MCP server (../mcp/tools.mjs)
 * so the two can never drift apart. Dependency-free, GET-only.
 *
 *   export PVUV_API_URL=https://api.example.com
 *   export PVUV_TOKEN=pvuv_…
 *   pvuv sites
 *   pvuv overview <site> --period 7d
 *   pvuv breakdown <site> --dim page --limit 10
 *   pvuv quality <site> --json
 */

import { api, PERIODS, DIMENSIONS, METRICS } from '../mcp/tools.mjs';

const argv = process.argv.slice(2);

function flag(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
const asJson = argv.includes('--json');
const positional = argv.filter((a, i) =>
  !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && flagTakesValue(argv[i - 1])));
function flagTakesValue(f) {
  return !['--json', '--help', '-h'].includes(f);
}

const USAGE = `pvuv — read-only client for a self-hosted pvuv.ai deployment

  pvuv sites
  pvuv overview   <site_id>  [--period ${PERIODS[3]}]
  pvuv realtime   <site_id>
  pvuv timeseries <site_id>  [--period 7d] [--metric pv] [--interval day]
  pvuv breakdown  <site_id>  --dim <dimension> [--period 7d] [--limit 20]
  pvuv quality    <site_id>  [--period 7d]
  pvuv alerts     <site_id>  [--period 7d]
  pvuv adguard    <site_id>  [--period 7d]
  pvuv traffic    <site_id>  [--period 7d] [--min-score 30] [--limit 50]

  --json    print the raw API response instead of a table

Environment:
  PVUV_API_URL   base URL of the api worker, e.g. https://api.example.com
  PVUV_TOKEN     personal API token (console → API tokens)

Periods:    ${PERIODS.join(' ')}
Dimensions: ${DIMENSIONS.join(' ')}
Metrics:    ${METRICS.join(' ')}`;

// ---------------------------------------------------------------------------
// tiny table renderer — right-aligns numbers, pads to the widest cell
// ---------------------------------------------------------------------------
const num = (v) => typeof v === 'number' && Number.isFinite(v);
function table(rows, columns) {
  if (!rows.length) return '(no rows)';
  const cols = columns || Object.keys(rows[0]);
  const body = rows.map((r) => cols.map((c) => format(r[c])));
  const w = cols.map((c, i) => Math.max(c.length, ...body.map((b) => b[i].length)));
  const line = (cells) => cells.map((s, i) => (num(rows[0][cols[i]]) ? s.padStart(w[i]) : s.padEnd(w[i]))).join('  ').trimEnd();
  return [line(cols), w.map((n) => '─'.repeat(n)).join('  '), ...body.map(line)].join('\n');
}
function format(v) {
  if (v === null || v === undefined) return '–';
  if (typeof v === 'number') return Number.isInteger(v) ? v.toLocaleString('en-US') : v.toFixed(4).replace(/0+$/, '');
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
function pairs(obj, skip = []) {
  return Object.entries(obj)
    .filter(([k, v]) => !skip.includes(k) && (v === null || typeof v !== 'object'))
    .map(([k, v]) => `${k.padEnd(20)} ${format(v)}`).join('\n');
}

function out(data, render) {
  if (asJson || !render) { console.log(JSON.stringify(data, null, 2)); return; }
  console.log(render(data));
}

function needSite() {
  const id = positional[1];
  if (!id) { console.error('error: a site_id is required (run `pvuv sites` to list them)'); process.exit(2); }
  return encodeURIComponent(id);
}

async function main() {
  const cmd = positional[0];
  if (!cmd || cmd === 'help' || argv.includes('-h') || argv.includes('--help')) { console.log(USAGE); return; }
  const period = flag('period', '7d');

  switch (cmd) {
    case 'sites':
      return out(await api('/v1/sites'), (d) => table(d.sites, ['site_id', 'name', 'domains', 'timezone']));
    case 'overview':
      return out(await api(`/v1/sites/${needSite()}/overview`, { period }), (d) => pairs(d, ['period']));
    case 'realtime':
      return out(await api(`/v1/sites/${needSite()}/realtime`), (d) => pairs(d, ['minutes']));
    case 'timeseries':
      return out(await api(`/v1/sites/${needSite()}/timeseries`, {
        period, metric: flag('metric', 'pv'), interval: flag('interval'),
      }), (d) => table(d.points, ['label', 'value', 'pv', 'invalid', 'status']));
    case 'breakdown': {
      const dim = flag('dim');
      if (!dim || dim === true) { console.error(`error: --dim is required (${DIMENSIONS.join(', ')})`); process.exit(2); }
      return out(await api(`/v1/sites/${needSite()}/breakdown`, { period, dim, limit: flag('limit') }),
        (d) => table(d.rows));
    }
    case 'quality':
      return out(await api(`/v1/sites/${needSite()}/quality`, { period }), (d) => {
        const flags = Object.entries(d.flags || {}).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
        return `${pairs(d.totals || {})}\n\nsignals that fired\n${table(flags.map(([signal, events]) => ({ signal, events })))}`;
      });
    case 'alerts':
      return out(await api(`/v1/sites/${needSite()}/alerts`, { period }), (d) => {
        const a = (d.alerts || []).map((x) => `[${x.severity}] ${x.title}: ${x.detail}`).join('\n');
        return `${pairs(d.stats || {})}\n\n${a || '(no alerts)'}`;
      });
    case 'adguard':
      return out(await api(`/v1/sites/${needSite()}/adguard`, { period }), (d) => {
        const tiers = Object.entries(d.tiers || {}).map(([tier, t]) => ({
          tier, blocked_pv: t.block, block_rate: t.block_rate, est_false_positive: t.fp_rate,
        }));
        return `mode: ${d.current_mode}   pageviews: ${format(d.pv)}\n\n${table(tiers)}`
          + `\n\nblock reasons\n${table((d.reasons || []).map((r) => ({ signal: r.flag, events: r.n })))}`;
      });
    case 'traffic':
      return out(await api(`/v1/sites/${needSite()}/traffic`, {
        period, min_score: flag('min-score', 30), limit: flag('limit'),
      }), (d) => table(d.rows, ['visitor_id', 'events', 'sessions', 'country', 'browser', 'os', 'bot_score', 'verdict']));
    default:
      console.error(`unknown command: ${cmd}\n\n${USAGE}`);
      process.exit(2);
  }
}

main().catch((err) => { console.error(`error: ${err.message}`); process.exit(1); });
