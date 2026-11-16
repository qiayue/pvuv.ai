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
  pvuv overview   <site_id>  [--period ${PERIODS[3]}] [--compare previous]
  pvuv realtime   <site_id>  [--window 30]
  pvuv timeseries <site_id>  [--period 7d] [--metric pv] [--interval day]
  pvuv breakdown  <site_id>  --dim <dimension> [--period 7d] [--limit 20]
  pvuv quality    <site_id>  [--period 7d]
  pvuv alerts     <site_id>  [--period 7d]
  pvuv adguard    <site_id>  [--period 7d]
  pvuv edge       <site_id>  [--period 7d]
  pvuv crawlers   <site_id>  [--period 30d] [--limit 20]
  pvuv traffic    <site_id>  [--period 7d] [--min-score 30] [--limit 50]
  pvuv experiments  <site_id>  [--period 30d]
  pvuv experiment   <site_id>  --experiment <name> --goal <event> [--window-hours 48]
                               [--baseline <variant>] [--min-exposures 100] [--period 90d]
  pvuv events       <site_id>  [--period 30d]      (custom event inventory)
  pvuv ai-referrals <site_id>  [--period 30d] [--assistant chatgpt]

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
      return out(await api('/v1/sites'), (d) => table(d.sites.map((s) => ({
        ...s, first_search_crawl: s.first_search_crawl_at ? new Date(s.first_search_crawl_at).toISOString().slice(0, 10) : null,
      })), ['site_id', 'name', 'domains', 'timezone', 'first_search_crawl']));
    case 'overview':
      return out(await api(`/v1/sites/${needSite()}/overview`, { period, compare: flag('compare') }), (d) => {
        if (!d.compare) return pairs(d, ['period']);
        const rows = Object.entries(d.compare.delta).map(([metric, x]) => ({ metric, now: d[metric], previous: d.compare.values[metric], change: x.abs, pct: x.pct }));
        return `previous: ${d.compare.period.start} – ${d.compare.period.end}\n\n${table(rows)}`;
      });
    case 'realtime':
      return out(await api(`/v1/sites/${needSite()}/realtime`, { window: flag('window') }), (d) => pairs(d, ['minutes']));
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
    case 'edge':
      return out(await api(`/v1/sites/${needSite()}/edge`, { period }), (d) => {
        if (!d.available) return 'no edge data — a Cloudflare API token has not been configured for this deployment';
        return `${pairs(d.totals || {})}\n\ntop user agents\n`
          + table((d.agents || []).slice(0, 15).map((a) => ({ user_agent: a.user_agent, requests: a.requests })));
      });
    case 'crawlers':
      return out(await api(`/v1/sites/${needSite()}/crawlers`, { period: flag('period', '30d'), limit: flag('limit') }), (d) => {
        const day = (ms) => (ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : null);
        const srcs = `sources: beacon${d.sources?.edge?.available ? ' + cloudflare edge' : ' only (no Cloudflare edge data — non-JS crawlers are not counted)'}`;
        const engines = (d.engines || []).map((e) => ({
          engine: e.label, kind: e.kind, first_seen: day(e.first_seen_at), last_seen: day(e.last_seen_at),
          hits: e.hits, beacon: e.beacon_hits, edge: e.edge_hits, pages: e.pages,
        }));
        return `first search crawl: ${day(d.first_search_crawl_at) ?? 'none yet'}\n${srcs}\n\n${table(engines)}`
          + `\n\ntop crawled pages (beacon only)\n${table((d.top_pages?.pages || []).map((p) => ({ path: p.path, hits: p.hits, engines: Object.keys(p.engines).join(', ') })))}`;
      });
    case 'traffic':
      return out(await api(`/v1/sites/${needSite()}/traffic`, {
        period, min_score: flag('min-score', 30), limit: flag('limit'),
      }), (d) => table(d.rows, ['visitor_id', 'events', 'sessions', 'country', 'browser', 'os', 'bot_score', 'verdict']));
    case 'experiments':
      return out(await api(`/v1/sites/${needSite()}/experiments`, { period: flag('period', '30d') }), (d) =>
        table(d.experiments.flatMap((e) => e.variants.map((v) => ({ experiment: e.experiment, variant: v.variant, visitors: v.visitors, exposures: v.exposures,
          last_seen: new Date(v.last_seen).toISOString().slice(0, 16).replace('T', ' ') })))));
    case 'experiment': {
      const d = await api(`/v1/sites/${needSite()}/experiment`, {
        period: flag('period'), experiment: flag('experiment'), goal: flag('goal'), window_hours: flag('window-hours'),
        baseline: flag('baseline'), min_exposures: flag('min-exposures'),
      });
      return out(d, (x) => `${table(x.variants, ['variant', 'visitors', 'conversions', 'rate', 'p_best', 'p_beat_baseline', 'lift'])}\n\n`
        + `decision: ${x.decision.status}${x.decision.winner ? ` → ${x.decision.winner}` : ''}${x.decision.losers.length ? `  losers: ${x.decision.losers.join(', ')}` : ''}\n${x.decision.reason}`);
    }
    case 'events':
      return out(await api(`/v1/sites/${needSite()}/event_inventory`, { period: flag('period', '30d') }), (d) =>
        table(d.events.map((e) => ({ event: e.event, count: e.count, visitors: e.visitors, props: e.props.map((p) => p.key) }))));
    case 'ai-referrals':
      return out(await api(`/v1/sites/${needSite()}/ai_referrals`, { period: flag('period', '30d'), assistant: flag('assistant') }), (d) =>
        `${pairs(d.totals)}\n\n${table(d.assistants, ['label', 'sessions', 'visitors', 'pageviews', 'bounce_rate'])}`
        + `\n\ntop landing pages\n${table(d.landing_pages)}`);
    default:
      console.error(`unknown command: ${cmd}\n\n${USAGE}`);
      process.exit(2);
  }
}

main().catch((err) => { console.error(`error: ${err.message}`); process.exit(1); });
