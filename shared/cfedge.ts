/**
 * Cloudflare edge-request client (PROJECT_PLAN.md §6.7) — OPTIONAL feature.
 *
 * Why this exists
 * ---------------
 * The JS beacon can only see requests that reached a real browser and executed
 * JavaScript. An AI crawler, a scraper or a feed reader fetches the HTML and
 * leaves; it never runs a script, so it is invisible to /in by construction —
 * no amount of scoring can recover a request that was never reported.
 *
 * Cloudflare, sitting in front of the origin, saw every one of them. If the
 * deployer supplies a read-only API token we can ask for those counts and
 * compare:
 *
 *     edge HTML requests   12,480   ← what Cloudflare served
 *     browser pageviews     2,773   ← what the beacon reported
 *     gap                   9,707   ← fetched HTML, never ran JS
 *
 * with the gap broken down by user agent.
 *
 * Scope and non-goals
 * -------------------
 * - Read-only. Nothing here writes to the deployer's Cloudflare account.
 * - Purely descriptive. Edge counts never feed scoring, verdicts, or the
 *   ad-guard decision — they are a different population (requests, not
 *   visitors) and mixing the two would corrupt every rate we compute.
 * - Optional. With no token configured, none of this runs and the product
 *   behaves exactly as it did before.
 *
 * Dataset: `httpRequestsAdaptiveGroups`, which is available on ALL Cloudflare
 * plans (unlike Logpush/Logpull, which are Enterprise-only).
 *
 * Errors are surfaced VERBATIM. Cloudflare's GraphQL schema is not versioned
 * and field availability varies by plan, so a wrong assumption here has to be
 * visible in the console rather than swallowed into a generic failure.
 */

const CF_API = 'https://api.cloudflare.com/client/v4';
const CF_GRAPHQL = `${CF_API}/graphql`;

/** Ceiling on user-agent rows stored per site-day. Keeps one pathological day
 *  (agent strings are effectively unbounded cardinality) from filling D1. */
export const MAX_AGENT_ROWS = 60;

export class CfEdgeError extends Error {
  constructor(message: string, public status = 502) {
    super(message);
    this.name = 'CfEdgeError';
  }
}

export interface CfZone {
  id: string;
  name: string;
}

/** Read the first part of an upstream error body, for a message a human can act
 *  on ("Authentication error", "unknown field") instead of a bare status. */
async function upstreamText(res: Response): Promise<string> {
  let body = '';
  try { body = (await res.text()).slice(0, 400); } catch { /* ignore */ }
  return body || res.statusText || `HTTP ${res.status}`;
}

/**
 * Zones the token can see. Requires the token to carry `Zone → Zone: Read`;
 * without it Cloudflare answers 403 and we say so plainly.
 */
export async function listZones(token: string): Promise<CfZone[]> {
  const out: CfZone[] = [];
  // one page is enough for any realistic self-hosted deployment; the loop is
  // here so a large account doesn't silently lose its later zones
  for (let page = 1; page <= 5; page++) {
    const res = await fetch(`${CF_API}/zones?per_page=50&page=${page}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new CfEdgeError(`Cloudflare /zones: ${await upstreamText(res)}`, res.status);
    const data = (await res.json()) as {
      success?: boolean;
      errors?: Array<{ message?: string }>;
      result?: Array<{ id?: string; name?: string }>;
      result_info?: { total_pages?: number };
    };
    if (data.success === false) {
      throw new CfEdgeError(`Cloudflare /zones: ${data.errors?.[0]?.message ?? 'request rejected'}`, 403);
    }
    for (const z of data.result ?? []) {
      if (z.id && z.name) out.push({ id: z.id, name: z.name.toLowerCase() });
    }
    if (page >= (data.result_info?.total_pages ?? 1)) break;
  }
  return out;
}

/**
 * The zone serving a site's domains. Longest suffix wins, so a deployment that
 * has both `example.com` and `blog.example.com` as separate zones attributes a
 * `blog.example.com` site to the more specific one.
 */
export function zoneForDomains(zones: CfZone[], domains: string[]): CfZone | null {
  let best: CfZone | null = null;
  for (const raw of domains) {
    const d = String(raw).trim().toLowerCase().replace(/^\*\./, '');
    if (!d) continue;
    for (const z of zones) {
      if (d === z.name || d.endsWith(`.${z.name}`)) {
        if (!best || z.name.length > best.name.length) best = z;
      }
    }
  }
  return best;
}

/** POST a GraphQL document, returning `data.viewer.zones[0]` or throwing with
 *  Cloudflare's own message (which is what tells you a field name is wrong). */
async function graphql(token: string, query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(CF_GRAPHQL, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new CfEdgeError(`Cloudflare GraphQL: ${await upstreamText(res)}`, res.status);
  const body = (await res.json()) as {
    errors?: Array<{ message?: string }>;
    data?: { viewer?: { zones?: Array<Record<string, unknown>> } };
  };
  // GraphQL reports failures inside a 200 response, so status alone is not a
  // success signal
  if (body.errors?.length) {
    throw new CfEdgeError(`Cloudflare GraphQL: ${body.errors.map((e) => e.message ?? '?').join('; ')}`);
  }
  const zone = body.data?.viewer?.zones?.[0];
  // an empty zones array means the token cannot read analytics for this zone,
  // which is a permissions problem and must not look like "zero traffic"
  if (!zone) throw new CfEdgeError('Cloudflare GraphQL returned no zone — the token may lack Analytics:Read for it');
  return zone;
}

// `requestSource: "eyeball"` excludes Worker subrequests, so the count is
// requests that actually arrived from the internet — the population a pageview
// belongs to. Time bounds are ISO instants (not calendar dates) so the window
// can be the SITE'S local day rather than a UTC one.
const TOTALS_QUERY = `
query Totals($zoneTag: string!, $since: Time!, $until: Time!) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
      all: httpRequestsAdaptiveGroups(
        limit: 1
        filter: { datetime_geq: $since, datetime_lt: $until, requestSource: "eyeball" }
      ) { count }
      html: httpRequestsAdaptiveGroups(
        limit: 1
        filter: { datetime_geq: $since, datetime_lt: $until, requestSource: "eyeball", edgeResponseContentTypeName: "html" }
      ) { count }
    }
  }
}`;

const AGENTS_QUERY = `
query Agents($zoneTag: string!, $since: Time!, $until: Time!, $limit: Int!) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
      httpRequestsAdaptiveGroups(
        limit: $limit
        filter: { datetime_geq: $since, datetime_lt: $until, requestSource: "eyeball", edgeResponseContentTypeName: "html" }
        orderBy: [count_DESC]
      ) {
        count
        dimensions { userAgent }
      }
    }
  }
}`;

const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

export interface EdgeTotals {
  requests: number;
  htmlRequests: number;
}

/** Request counts for one [startTs, endTs) window — normally a site's local day. */
export async function edgeTotals(token: string, zoneTag: string, startTs: number, endTs: number): Promise<EdgeTotals> {
  const zone = await graphql(token, TOTALS_QUERY, { zoneTag, since: iso(startTs), until: iso(endTs) });
  const count = (g: unknown): number => {
    const rows = Array.isArray(g) ? (g as Array<{ count?: number }>) : [];
    return rows.reduce((n, r) => n + (Number(r.count) || 0), 0);
  };
  return { requests: count(zone.all), htmlRequests: count(zone.html) };
}

export interface EdgeAgent {
  userAgent: string;
  requests: number;
}

/** Top user agents behind the window's HTML requests. */
export async function edgeAgents(token: string, zoneTag: string, startTs: number, endTs: number, limit = MAX_AGENT_ROWS): Promise<EdgeAgent[]> {
  const zone = await graphql(token, AGENTS_QUERY, {
    zoneTag, since: iso(startTs), until: iso(endTs), limit: Math.min(Math.max(limit, 1), MAX_AGENT_ROWS),
  });
  const rows = Array.isArray(zone.httpRequestsAdaptiveGroups)
    ? (zone.httpRequestsAdaptiveGroups as Array<{ count?: number; dimensions?: { userAgent?: string } }>)
    : [];
  return rows
    .map((r) => ({
      // agent strings are attacker-controlled and unbounded; cap before storing
      userAgent: String(r.dimensions?.userAgent ?? '').slice(0, 300) || '(unknown)',
      requests: Number(r.count) || 0,
    }))
    .filter((r) => r.requests > 0);
}
