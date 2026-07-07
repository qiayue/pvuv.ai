/**
 * pvuv.ai ingest worker — in.pvuv.ai
 *
 *   POST /in — event ingest (PROJECT_PLAN.md §5): whitelist validation +
 *              server-side enrichment + realtime first-pass scoring + enqueue.
 *              Hot path: minimal and fast; heavy analysis runs downstream.
 *   POST /v  — fast ad-load verdict (§8) — step 5.
 */

import { enrichEvent, parseUA, isChromiumUA, hashIP, fingerprintHash, type RequestContext } from './enrich';
import { scoreRealtime } from './score';
import { classifyAsn } from '../../../shared/asn';
import {
  MAX_REQUEST_EVENTS, type IncomingEvent, type EventRow,
} from '../../../shared/events';

export interface Env {
  DB: D1Database;
  BLOCKLIST: KVNamespace;
  SITE_CONFIG: KVNamespace;
  INGEST_QUEUE: Queue<EventRow>;
  /** Secret via `wrangler secret put HMAC_KEY` — never in any file. */
  HMAC_KEY: string;
}

const MAX_BODY_BYTES = 64 * 1024;
/** KV cache TTL for site config (console write-through keeps it fresh). */
const SITE_CACHE_TTL_S = 300;

// CORS: text/plain POSTs are "simple requests" (no preflight, §5); headers
// below cover diagnostics and any future preflighted call.
const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
};

function respond(status: number, body: string | null = null): Response {
  return new Response(body, { status, headers: CORS_HEADERS });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return respond(204);

    if (request.method === 'POST' && url.pathname === '/in') {
      return handleIngest(request, env, ctx);
    }

    if (request.method === 'POST' && url.pathname === '/v') {
      // TODO(step 5): edge-local fast verdict (<80ms), signed _pv_v state.
      return respond(501, 'not implemented');
    }

    return respond(404, 'not found');
  },
} satisfies ExportedHandler<Env>;

// ---------------------------------------------------------------------------
// POST /in
// ---------------------------------------------------------------------------

async function handleIngest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const len = parseInt(request.headers.get('content-length') ?? '0', 10);
  if (len > MAX_BODY_BYTES) return respond(413);

  let events: IncomingEvent[];
  try {
    const parsed: unknown = JSON.parse(await request.text());
    events = Array.isArray(parsed) ? (parsed as IncomingEvent[]) : [parsed as IncomingEvent];
  } catch {
    return respond(400, 'bad json');
  }
  if (events.length === 0) return respond(204);
  if (events.length > MAX_REQUEST_EVENTS) events = events.slice(0, MAX_REQUEST_EVENTS);

  // --- whitelist validation (§5): Origin/Referer host vs allowed_domains ---
  const originHost = requestOriginHost(request);
  if (!originHost) return respond(403, 'no origin');

  const siteCache = new Map<string, SiteConfig | null>();
  const valid: IncomingEvent[] = [];
  for (const ev of events) {
    if (!ev || typeof ev.s !== 'string' || typeof ev.e !== 'string' || typeof ev.u !== 'string'
      || typeof ev.vid !== 'string' || typeof ev.sid !== 'string') continue;
    let site = siteCache.get(ev.s);
    if (site === undefined) {
      site = await getSiteConfig(env, ev.s);
      siteCache.set(ev.s, site);
    }
    if (!site || site.status !== 'active') continue;
    if (!domainAllowed(originHost, site.allowed_domains)) continue; // drop on mismatch (§5)
    valid.push(ev);
  }
  if (valid.length === 0) return respond(204);

  // --- shared request context ---
  const cf = (request as Request & { cf?: IncomingRequestCfProperties }).cf;
  const reqCtx: RequestContext = {
    cf,
    ua: request.headers.get('user-agent'),
    ip: request.headers.get('cf-connecting-ip'),
    now: Date.now(),
  };
  const uaInfo = parseUA(reqCtx.ua);
  const chromiumUA = isChromiumUA(reqCtx.ua);
  const asnType = classifyAsn(typeof cf?.asn === 'number' ? cf.asn : undefined, cf?.asOrganization);

  // --- KV blocklist check (§6.2 0x0200): once per request, by ip24 + fp ---
  const { ip24_hash } = await hashIP(env.HMAC_KEY, reqCtx.ip);
  const firstCanvas = valid.find((e) => e.x?.x7)?.x;
  const fpForBlocklist = firstCanvas
    ? await fingerprintHash(env.HMAC_KEY, firstCanvas.x7, reqCtx.ua, valid[0].sw, valid[0].sh, valid[0].lang)
    : null;
  const blocklisted = await isBlocklisted(env.BLOCKLIST, ip24_hash, fpForBlocklist);

  // --- enrich + score each event ---
  const rows: EventRow[] = [];
  for (const ev of valid) {
    const row = await enrichEvent(ev, reqCtx, env.HMAC_KEY);
    if (!row) continue;
    const scored = scoreRealtime({
      x: ev.x,
      asnType,
      isCrawler: uaInfo.isCrawler,
      chromiumUA,
      headers: request.headers,
      ipTimezone: cf?.timezone,
      os: uaInfo.os,
      deviceType: uaInfo.device_type,
      hadInteraction: ev.hi === 1,
      isPageLeave: ev.e === 'page_leave',
      blocklisted,
    });
    rows.push({ ...row, ...scored });
  }
  if (rows.length === 0) return respond(204);

  try {
    await env.INGEST_QUEUE.sendBatch(rows.map((body) => ({ body })));
  } catch (err) {
    console.error('queue send failed', err);
    return respond(503);
  }
  return respond(204);
}

// ---------------------------------------------------------------------------
// Site config: KV read-through cache over D1 (console write-through, step 5)
// ---------------------------------------------------------------------------

export interface SiteConfig {
  site_id: string;
  allowed_domains: string[];
  adguard_mode: string;
  adclient: string | null;
  status: string;
}

async function getSiteConfig(env: Env, siteId: string): Promise<SiteConfig | null> {
  if (!/^[A-Za-z0-9]{4,16}$/.test(siteId)) return null;
  const key = `site:${siteId}`;

  const cached = await env.SITE_CONFIG.get<SiteConfig>(key, 'json');
  if (cached) return cached;

  const row = await env.DB
    .prepare('SELECT site_id, allowed_domains, adguard_mode, adclient, status FROM sites WHERE site_id = ?')
    .bind(siteId)
    .first<{ site_id: string; allowed_domains: string; adguard_mode: string; adclient: string | null; status: string }>();
  if (!row) return null;

  let allowed: string[];
  try {
    allowed = JSON.parse(row.allowed_domains) as string[];
  } catch {
    return null;
  }
  const config: SiteConfig = {
    site_id: row.site_id,
    allowed_domains: allowed.map((d) => d.toLowerCase()),
    adguard_mode: row.adguard_mode,
    adclient: row.adclient,
    status: row.status,
  };
  await env.SITE_CONFIG.put(key, JSON.stringify(config), { expirationTtl: SITE_CACHE_TTL_S });
  return config;
}

/** Host matches an allowed domain exactly or as a subdomain (§3 multi-subdomain). */
export function domainAllowed(host: string, allowed: string[]): boolean {
  const h = host.toLowerCase();
  return allowed.some((d) => h === d || h.endsWith(`.${d}`));
}

function requestOriginHost(request: Request): string | null {
  for (const header of ['origin', 'referer']) {
    const v = request.headers.get(header);
    if (!v) continue;
    try {
      return new URL(v).hostname.toLowerCase();
    } catch {
      /* fall through */
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Blocklist: KV keys written by the daily population job (M2, §6.4);
// checked here so confirmed clusters affect realtime scoring immediately.
// ---------------------------------------------------------------------------

async function isBlocklisted(kv: KVNamespace, ip24: string | null, fp: string | null): Promise<boolean> {
  const checks: Promise<string | null>[] = [];
  if (ip24) checks.push(kv.get(`bl:ip24:${ip24}`));
  if (fp) checks.push(kv.get(`bl:fp:${fp}`));
  if (checks.length === 0) return false;
  const results = await Promise.all(checks);
  return results.some((r) => r !== null);
}
