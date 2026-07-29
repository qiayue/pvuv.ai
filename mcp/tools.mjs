/**
 * Tool definitions + the shared API client for the MCP server and the CLI.
 *
 * Both surfaces expose the same read-only endpoints, so the schemas, the
 * period/dimension vocabularies and the result formatting live here once. The
 * CLI imports `api()` and the same constants rather than restating them.
 */

export const PROTOCOL_VERSION = '2024-11-05';
export const SERVER_INFO = { name: 'pvuv.ai', version: '1.0.0' };

export const PERIODS = [
  '24h', 'today', 'yesterday', '7d', '30d', '90d',
  'this_week', 'last_week', 'this_month', 'last_month', 'this_year',
];
export const DIMENSIONS = [
  'page', 'entry_page', 'exit_page', 'source', 'referrer', 'country', 'region', 'city',
  'browser', 'os', 'device', 'size', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'ft_source', 'ft_medium', 'ft_campaign', 'goal', 'bot_category',
];
export const METRICS = [
  'pv', 'uv', 'sessions', 'bounce_rate', 'bounce_rate_single', 'avg_duration_ms', 'visit_duration_ms',
];

export function requireConfig() {
  if (!process.env.PVUV_API_URL) throw new Error('PVUV_API_URL is not set (e.g. https://api.example.com)');
  if (!process.env.PVUV_TOKEN) throw new Error('PVUV_TOKEN is not set (create one in the console → API tokens)');
}

/** GET a v1 endpoint and return parsed JSON. Errors carry the server's message
 *  so a wrong token or site id explains itself instead of surfacing as a 401. */
export async function api(path, params = {}) {
  requireConfig();
  const base = process.env.PVUV_API_URL.replace(/\/+$/, '');
  const url = new URL(base + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${process.env.PVUV_TOKEN}`, accept: 'application/json' },
  });
  const body = await res.text();
  let data;
  try { data = JSON.parse(body); } catch { data = null; }
  if (!res.ok) {
    const msg = data?.error || body.slice(0, 200) || res.statusText;
    throw new Error(`${res.status} ${msg}`);
  }
  return data;
}

const siteArg = { site_id: { type: 'string', description: 'Site id from list_sites' } };
const periodArg = {
  period: { type: 'string', enum: PERIODS, description: 'Date range (default 7d)' },
};

export const TOOLS = [
  {
    name: 'list_sites',
    description: 'List the sites this token can read, with their ids, domains and timezone. Call this first — every other tool needs a site_id.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_overview',
    description: 'Headline metrics for a period: pageviews, visitors, sessions, both bounce-rate definitions, engaged time, visit duration, and the split of pageviews across clean / suspect / bot / crawler verdicts.',
    inputSchema: { type: 'object', properties: { ...siteArg, ...periodArg }, required: ['site_id'] },
  },
  {
    name: 'get_realtime',
    description: 'Visitors active in the last 30 minutes, with pageviews and a per-minute sparkline. Always live, independent of any period.',
    inputSchema: { type: 'object', properties: { ...siteArg }, required: ['site_id'] },
  },
  {
    name: 'get_timeseries',
    description: 'A metric over time, bucketed by minute/hour/day/week/month. Each bucket also reports its pageviews and how many were invalid (bot or suspect), which shows whether bad traffic was a short burst or spread across the period.',
    inputSchema: {
      type: 'object',
      properties: {
        ...siteArg, ...periodArg,
        metric: { type: 'string', enum: METRICS, description: 'Default pv' },
        interval: { type: 'string', enum: ['minute', 'hour', 'day', 'week', 'month'], description: 'Bucket size' },
      },
      required: ['site_id'],
    },
  },
  {
    name: 'get_breakdown',
    description: 'Top values for one dimension (pages, sources, countries, browsers, crawler categories, …) with pageviews, clean pageviews and visitors.',
    inputSchema: {
      type: 'object',
      properties: {
        ...siteArg, ...periodArg,
        dimension: { type: 'string', enum: DIMENSIONS, description: 'Which dimension to group by' },
        limit: { type: 'number', description: 'Rows to return (default 20, max 1000)' },
      },
      required: ['site_id', 'dimension'],
    },
  },
  {
    name: 'get_traffic_quality',
    description: 'Invalid-traffic breakdown: verdict totals plus which bot-detection signals fired and how often. Use this to explain WHY traffic was judged invalid.',
    inputSchema: { type: 'object', properties: { ...siteArg, ...periodArg }, required: ['site_id'] },
  },
  {
    name: 'get_alerts',
    description: 'Rule-based "this data looks wrong" checks (invalid-traffic share, datacenter share, no-interaction visits, forged search referrals), with each ratio and the threshold it is measured against.',
    inputSchema: { type: 'object', properties: { ...siteArg, ...periodArg }, required: ['site_id'] },
  },
  {
    name: 'get_ad_protection',
    description: 'Ad-protection impact estimate: for each tier (loose/balanced/strict) the pageviews it would block, the block rate and an estimated false-positive rate, plus the top block reasons and blocked sources.',
    inputSchema: { type: 'object', properties: { ...siteArg, ...periodArg }, required: ['site_id'] },
  },
  {
    name: 'get_edge_requests',
    description: 'Requests Cloudflare served for the site next to the pageviews the tracking script reported, plus the top user agents. The gap is HTML that was fetched without ever running JavaScript — AI crawlers, scrapers, feed readers — which no other tool here can see. Returns available:false when the deployer has not configured a Cloudflare API token.',
    inputSchema: { type: 'object', properties: { ...siteArg, ...periodArg }, required: ['site_id'] },
  },
  {
    name: 'get_suspicious_visitors',
    description: 'Individual high-scoring visitors with their bot score, verdict and the evidence flags that fired. Use for drill-down after get_traffic_quality.',
    inputSchema: {
      type: 'object',
      properties: {
        ...siteArg, ...periodArg,
        min_score: { type: 'number', description: 'Minimum bot score (default 30)' },
        limit: { type: 'number', description: 'Rows (default 50)' },
      },
      required: ['site_id'],
    },
  },
];

const P = (a) => a.period || '7d';

export async function callTool(name, a) {
  switch (name) {
    case 'list_sites': {
      const d = await api('/v1/sites');
      if (!d.sites?.length) return 'No sites found for this token.';
      return d.sites.map((s) =>
        `${s.site_id}  ${s.name}  [${(s.domains || []).join(', ')}]  tz=${s.timezone}`).join('\n');
    }
    case 'get_overview':
      return fmt(await api(`/v1/sites/${sid(a)}/overview`, { period: P(a) }));
    case 'get_realtime':
      return fmt(await api(`/v1/sites/${sid(a)}/realtime`));
    case 'get_timeseries':
      return fmt(await api(`/v1/sites/${sid(a)}/timeseries`, {
        period: P(a), metric: a.metric || 'pv', interval: a.interval,
      }));
    case 'get_breakdown':
      return fmt(await api(`/v1/sites/${sid(a)}/breakdown`, {
        period: P(a), dim: a.dimension, limit: a.limit,
      }));
    case 'get_traffic_quality':
      return fmt(await api(`/v1/sites/${sid(a)}/quality`, { period: P(a) }));
    case 'get_alerts':
      return fmt(await api(`/v1/sites/${sid(a)}/alerts`, { period: P(a) }));
    case 'get_ad_protection':
      return fmt(await api(`/v1/sites/${sid(a)}/adguard`, { period: P(a) }));
    case 'get_edge_requests':
      return fmt(await api(`/v1/sites/${sid(a)}/edge`, { period: P(a) }));
    case 'get_suspicious_visitors':
      return fmt(await api(`/v1/sites/${sid(a)}/traffic`, {
        period: P(a), min_score: a.min_score ?? 30, limit: a.limit,
      }));
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

function sid(a) {
  if (!a.site_id) throw new Error('site_id is required — call list_sites first');
  return encodeURIComponent(a.site_id);
}

/** JSON is the most faithful thing to hand a model: it keeps field names and
 *  exact numbers, which a prose summary would blur. */
function fmt(data) {
  return JSON.stringify(data, null, 2);
}
