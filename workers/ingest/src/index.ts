/**
 * pvuv.ai ingest worker — in.pvuv.ai
 *
 *   POST /in — event ingest (PROJECT_PLAN.md §5): whitelist validation +
 *              server-side enrichment + realtime first-pass scoring + enqueue.
 *              Hot path: minimal and fast; heavy analysis runs downstream.
 *   POST /v  — fast ad-load verdict (§8) — step 5.
 */

import { enrichEvent, parseUA, isChromiumUA, isHeadlessUA, hashIP, fingerprintHash, type RequestContext } from './enrich';
import { scoreRealtime } from './score';
import { classifyAsn } from '../../../shared/asn';
import { matchBot, type BotEntry } from '../../../shared/botdir';
import { hmacSign, signVerdictState, verifyVerdictState, type VerdictState } from '../../../shared/ids';
import type { XPayload, Verdict } from '../../../shared/flags';
import {
  MAX_REQUEST_EVENTS, type IncomingEvent, type EventRow,
} from '../../../shared/events';

/**
 * Owner-imported crawler directory (§6.6), cached per isolate. Stored in KV by
 * the console on import; a miss just means "no directory imported", in which
 * case events carry no category and nothing else changes.
 *
 * Cached in module scope so the common case costs no I/O at all: one KV read
 * per isolate per TTL, not one per request. A failure is cached as an empty
 * list for the same TTL so a KV outage can't turn into a read storm.
 */
const BOTDIR_KV_KEY = 'botdir:v1';
const BOTDIR_TTL_MS = 10 * 60 * 1000;
let botDirCache: { entries: BotEntry[]; at: number } | null = null;

async function botDirectory(env: Env): Promise<BotEntry[]> {
  const now = Date.now();
  if (botDirCache && now - botDirCache.at < BOTDIR_TTL_MS) return botDirCache.entries;
  let entries: BotEntry[] = [];
  try {
    entries = (await env.SITE_CONFIG.get<BotEntry[]>(BOTDIR_KV_KEY, 'json')) ?? [];
  } catch (err) {
    console.error('botdir load failed', err);
  }
  botDirCache = { entries, at: now };
  return entries;
}

export interface Env {
  DB: D1Database;
  BLOCKLIST: KVNamespace;
  SITE_CONFIG: KVNamespace;
  INGEST_QUEUE: Queue<EventRow>;
  /** Secret via `wrangler secret put HMAC_KEY` — never in any file. */
  HMAC_KEY: string;
  /** Optional (§12): shared secret with a first-party reverse proxy. When a
   *  request carries x-pv-proxy matching this, its forwarded client-context
   *  headers (real IP/ASN/geo/tz) are trusted instead of the proxy-hop's own. */
  PROXY_TOKEN?: string;
}

interface ClientCtx { cf: IncomingRequestCfProperties | undefined; ip: string | null; }

/** Real client context, or — for requests from an authenticated first-party
 *  reverse proxy (§12) — the context the proxy forwards, so scoring
 *  (IP/ASN/geo/timezone) stays accurate across the proxy hop. Forwarded values
 *  are trusted ONLY when x-pv-proxy matches the PROXY_TOKEN secret; otherwise a
 *  direct client could spoof its IP. */
function resolveClient(request: Request, env: Env): ClientCtx {
  const realCf = (request as Request & { cf?: IncomingRequestCfProperties }).cf;
  const realIp = request.headers.get('cf-connecting-ip');
  if (env.PROXY_TOKEN && request.headers.get('x-pv-proxy') === env.PROXY_TOKEN) {
    const h = (k: string) => request.headers.get(k) || undefined;
    const asn = h('x-pv-asn');
    const cf = {
      asn: asn ? parseInt(asn, 10) : undefined,
      asOrganization: h('x-pv-asorg'),
      timezone: h('x-pv-tz'),
      country: h('x-pv-country'),
      region: h('x-pv-region'),
      city: h('x-pv-city'),
    } as unknown as IncomingRequestCfProperties;
    return { cf, ip: h('x-pv-ip') ?? realIp };
  }
  return { cf: realCf, ip: realIp };
}

const MAX_BODY_BYTES = 64 * 1024;
const MAX_VERDICT_BYTES = 8 * 1024;
/** KV cache TTL for site config (console write-through keeps it fresh). */
const SITE_CACHE_TTL_S = 300;
/** Short negative-cache TTL so bogus site_ids don't re-hit D1 every request. */
const SITE_MISS_TTL_S = 60;

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
      return handleVerdict(request, env);
    }

    return respond(404, 'not found');
  },
} satisfies ExportedHandler<Env>;

// ---------------------------------------------------------------------------
// POST /in
// ---------------------------------------------------------------------------

async function handleIngest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // Refuse to run with a missing secret rather than silently hashing with a
  // degenerate key (`wrangler secret put HMAC_KEY` is a deploy prerequisite).
  if (!env.HMAC_KEY) {
    console.error('HMAC_KEY secret is not set');
    return respond(500);
  }

  // fast reject on the advertised length, then enforce on the real body — a
  // client can lie about or omit Content-Length (chunked), so the header check
  // alone is not a real cap
  const len = parseInt(request.headers.get('content-length') ?? '0', 10);
  if (len > MAX_BODY_BYTES) return respond(413);
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return respond(413);

  let events: IncomingEvent[];
  try {
    const parsed: unknown = JSON.parse(text);
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
  const valid: { ev: IncomingEvent; allowed: string[] }[] = [];
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
    valid.push({ ev, allowed: site.allowed_domains });
  }
  if (valid.length === 0) return respond(204);

  // --- shared request context (direct, or forwarded by a first-party proxy §12) ---
  const { cf, ip: clientIp } = resolveClient(request, env);
  const reqCtx: RequestContext = {
    cf,
    ua: request.headers.get('user-agent'),
    ip: clientIp,
    now: Date.now(),
  };
  const uaInfo = parseUA(reqCtx.ua);
  const chromiumUA = isChromiumUA(reqCtx.ua);
  // crawler category, by precedence:
  //   1. platform-verified (request.cf.verifiedBotCategory — Cloudflare checked
  //      the IP ranges, available on all plans)
  //   2. self-declared AI agent (Web Bot Auth Signature-Agent header, or an
  //      official user-triggered agent UA like ChatGPT-User / Claude-User)
  //   3. the owner-imported UA directory (§6.6)
  // Directory categories stay descriptive-only for scoring; 1 and 2 DO affect
  // the verdict below — a verified/declared non-human is 'crawler'-class
  // (separate bucket, excluded from clean counts), because the declaration is
  // trustworthy in the direction that matters: nobody spoofs their way INTO
  // being counted as a bot.
  const declaredAgent = isDeclaredAgent(request, reqCtx.ua);
  const verifiedCategory = verifiedBotCategory(cf);
  const botCategory = verifiedCategory
    ?? (declaredAgent ? 'ai_agent_declared' : null)
    ?? matchBot(reqCtx.ua, await botDirectory(env))?.category ?? null;
  const asnType = classifyAsn(typeof cf?.asn === 'number' ? cf.asn : undefined, cf?.asOrganization);
  // transport fingerprint: one keyed hash per request (see migration 0018)
  const tlsFp = await transportFingerprint(env.HMAC_KEY, cf);

  // --- KV blocklist check (§6.2 0x0200): once per request, by ip24 + fp ---
  const { ip24_hash } = await hashIP(env.HMAC_KEY, reqCtx.ip);
  // fp material must match enrichEvent's exactly, so blocklist keys written
  // against stored fp_hash values actually match here.
  const fpEvent = valid.find((v) => v.ev.x?.x7)?.ev;
  const fpForBlocklist = fpEvent
    ? await fingerprintHash(env.HMAC_KEY, fpEvent.x!.x7, reqCtx.ua, fpEvent.sw, fpEvent.sh, fpEvent.lang)
    : null;
  const blocklisted = await isBlocklisted(env.BLOCKLIST, ip24_hash, fpForBlocklist);

  // --- enrich + score each event ---
  const rows: EventRow[] = [];
  for (const { ev, allowed } of valid) {
    const row = await enrichEvent(ev, reqCtx, env.HMAC_KEY, allowed);
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
      headlessUA: isHeadlessUA(reqCtx.ua),
      blocklisted,
      referrer: typeof ev.r === 'string' ? ev.r : undefined,
      httpProtocol: cf?.httpProtocol,
    });
    // platform-verified bot / self-declared agent → crawler-class verdict
    // (unless already scored bot); keeps them out of clean counts and visible
    // in the crawler-category breakdown
    if ((verifiedCategory || declaredAgent) && scored.verdict !== 'bot') scored.verdict = 'crawler';
    rows.push({ ...row, ...scored, bot_category: botCategory, tls_fp: tlsFp });
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
// POST /v — fast ad-load verdict (§8): everything edge-local (KV + request
// context, no per-request D1 on the happy path), target <80ms. The signed
// _pv_v state carried by the client stacks behavioral evidence across pages
// (§7.1 progressive verdict): a bot verdict is sticky, page count and
// interaction accumulate.
// ---------------------------------------------------------------------------

interface VerdictRequest {
  s: string;
  vid?: string;
  sid?: string;
  /** authenticity signals, same obfuscated shape as /in */
  x?: XPayload;
  /** screen + language — part of the fingerprint material (must match /in) */
  sw?: number;
  sh?: number;
  lang?: string;
  /** whether human interaction has occurred on this page (0/1) */
  i?: 0 | 1;
  /** navigation referrer (document.referrer) — for forged-search detection at the gate */
  r?: string;
  /** current _pv_v cookie value (cookies don't cross origins, so it rides the body) */
  state?: string;
}

async function handleVerdict(request: Request, env: Env): Promise<Response> {
  if (!env.HMAC_KEY) {
    console.error('HMAC_KEY secret is not set');
    return respond(500);
  }

  const text = await request.text();
  if (text.length > MAX_VERDICT_BYTES) return respond(413);

  let body: VerdictRequest;
  try {
    body = JSON.parse(text) as VerdictRequest;
  } catch {
    return respond(400, 'bad json');
  }
  if (!body || typeof body.s !== 'string') return respond(400, 'bad request');

  // Unknown/inactive site or origin mismatch → fail-open for ads (§7.4:
  // never cost the owner revenue on plumbing problems) but issue no state.
  const site = await getSiteConfig(env, body.s);
  const originHost = requestOriginHost(request);
  if (!site || site.status !== 'active' || !originHost || !domainAllowed(originHost, site.allowed_domains)) {
    return json({ v: 'clean', ok: 1 });
  }

  const prior: VerdictState | null = body.state
    ? await verifyVerdictState(env.HMAC_KEY, body.state)
    : null;

  const { cf, ip } = resolveClient(request, env);
  const ua = request.headers.get('user-agent');
  const uaInfo = parseUA(ua);
  const asnType = classifyAsn(typeof cf?.asn === 'number' ? cf.asn : undefined, cf?.asOrganization);

  const { ip24_hash } = await hashIP(env.HMAC_KEY, ip);
  const fp = body.x?.x7
    ? await fingerprintHash(env.HMAC_KEY, body.x.x7, ua, body.sw, body.sh, body.lang)
    : null;
  const blocklisted = await isBlocklisted(env.BLOCKLIST, ip24_hash, fp);

  const interacted = body.i === 1 || prior?.i === 1;
  const scored = scoreRealtime({
    x: body.x,
    asnType,
    isCrawler: uaInfo.isCrawler,
    chromiumUA: isChromiumUA(ua),
    headers: request.headers,
    ipTimezone: cf?.timezone,
    os: uaInfo.os,
    deviceType: uaInfo.device_type,
    hadInteraction: interacted,
    isPageLeave: false,
    headlessUA: isHeadlessUA(ua),
    blocklisted,
    referrer: typeof body.r === 'string' ? body.r : undefined,
    httpProtocol: cf?.httpProtocol,
  });
  // self-declared agents / platform-verified bots never see ads (crawler-class)
  if ((isDeclaredAgent(request, ua) || verifiedBotCategory(cf)) && scored.verdict !== 'bot') {
    scored.verdict = 'crawler';
  }

  // progressive stacking: once judged bot, stay bot for this state chain (§7.3)
  let verdict: Verdict = scored.verdict;
  if (prior && (prior.v === 'bot' || prior.v === 'crawler') && verdict !== 'bot') {
    verdict = prior.v;
  }

  const newState: VerdictState = {
    v: verdict,
    p: (prior?.p ?? 0) + 1,
    i: interacted ? 1 : 0,
    ts: Date.now(),
  };
  const state = await signVerdictState(env.HMAC_KEY, newState);

  // Shadow mode (§7): while a new site is inside its record-only window, ads
  // ALWAYS load (ok:1) no matter the verdict — the verdict is still computed and
  // recorded (via /in) so the owner can backtest "at this tier, X% would block"
  // before enforcement begins. `shadow:1` lets the SDK/telemetry know.
  if (site.shadow_until && Date.now() < site.shadow_until) {
    return json({ v: verdict, ok: 1, shadow: 1, m: site.adguard_mode, state });
  }

  // ok=1 → load now; suspect → client requires stronger interaction evidence
  // (§7.4); bot/crawler → never (verified crawlers get the page, not the ads).
  // `m` carries the site's current tier so the console can switch modes (§7.5)
  // and the SDK applies it without the site having to re-embed the snippet.
  return json({ v: verdict, ok: verdict === 'clean' ? 1 : 0, m: site.adguard_mode, state });
}

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { ...CORS_HEADERS, 'content-type': 'application/json' },
  });
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
  /** record-only (ads always load) until this instant; null/absent = enforce now */
  shadow_until: number | null;
}

async function getSiteConfig(env: Env, siteId: string): Promise<SiteConfig | null> {
  if (!/^[A-Za-z0-9]{4,16}$/.test(siteId)) return null;
  const key = `site:${siteId}`;

  const cached = await env.SITE_CONFIG.get<SiteConfig & { __miss?: true }>(key, 'json');
  if (cached) return cached.__miss ? null : cached;

  const row = await env.DB
    .prepare('SELECT site_id, allowed_domains, adguard_mode, adclient, status, shadow_until FROM sites WHERE site_id = ?')
    .bind(siteId)
    .first<{ site_id: string; allowed_domains: string; adguard_mode: string; adclient: string | null; status: string; shadow_until: number | null }>();
  if (!row) {
    // negative-cache the miss briefly so an unauthenticated flood of distinct
    // bogus site_ids can't re-query D1 on every request
    await env.SITE_CONFIG.put(key, JSON.stringify({ __miss: true }), { expirationTtl: SITE_MISS_TTL_S });
    return null;
  }

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
    shadow_until: row.shadow_until ?? null,
  };
  await env.SITE_CONFIG.put(key, JSON.stringify(config), { expirationTtl: SITE_CACHE_TTL_S });
  return config;
}

/** Host matches an allowed domain exactly or as a subdomain (§3 multi-subdomain). */
export function domainAllowed(host: string, allowed: string[]): boolean {
  const h = host.toLowerCase();
  return allowed.some((d) => h === d || h.endsWith(`.${d}`));
}

// ---------------------------------------------------------------------------
// Transport fingerprint + declared-automation detection (T0, research §3/§6)
// ---------------------------------------------------------------------------

/** JA4-INSPIRED, OWN IMPLEMENTATION (the JA4+ suite is FoxIO-licensed; this
 *  neither implements nor claims it). Keyed hash over the request.cf TLS/HTTP
 *  facts — stable per client stack, unobtainable from JS, so it survives IP
 *  rotation and UA spoofing. Null when the fields aren't populated (e.g. plain
 *  HTTP in local dev). */
async function transportFingerprint(secret: string, cf: IncomingRequestCfProperties | undefined): Promise<string | null> {
  if (!cf) return null;
  const c = cf as unknown as Record<string, unknown>;
  const parts = [c.tlsVersion, c.tlsCipher, c.tlsClientExtensionsSha1, c.tlsClientHelloLength, c.httpProtocol]
    .map((v) => (v == null ? '' : String(v)));
  if (parts.every((p) => p === '')) return null;
  return (await hmacSign(secret, `tlsfp|${parts.join('|')}`)).slice(0, 20);
}

/** Official user-triggered AI-agent UA tokens (crawler-style training/index
 *  bots are already caught by CRAWLER_RE). Conservative list — a browser-based
 *  agent with a plain Chrome UA is NOT detectable here (that's the behavioral
 *  layer's job, T1). */
const AGENT_UA_RE = /chatgpt-user|oai-searchbot|claude-user|perplexity-user|comet\//i;

/** Self-declared automation: a Web Bot Auth signature header (RFC 9421 +
 *  Signature-Agent, the Cloudflare/IETF signed-agents scheme) or an official
 *  agent UA. Presence alone is enough to classify — spoofing INTO the bot
 *  bucket gains an attacker nothing (cryptographic verification of the
 *  signature against the agent registry is the T1 follow-up). */
function isDeclaredAgent(request: Request, ua: string | null): boolean {
  if (request.headers.get('signature-agent')) return true;
  return !!ua && AGENT_UA_RE.test(ua);
}

/** Map request.cf.verifiedBotCategory (all plans) onto the crawler-category
 *  slugs the dashboard already renders (§6.6 directory categories). */
function verifiedBotCategory(cf: IncomingRequestCfProperties | undefined): string | null {
  const raw = (cf as unknown as { verifiedBotCategory?: unknown } | undefined)?.verifiedBotCategory;
  if (typeof raw !== 'string' || raw === '') return null;
  const c = raw.toLowerCase();
  if (c.includes('agent') || c.includes('assistant')) return 'ai_assistant';
  if (c.includes('ai') && (c.includes('train') || c.includes('crawl'))) return 'ai_training';
  if (c.includes('ai') && c.includes('search')) return 'ai_search';
  if (c.includes('search')) return 'search';
  if (c.includes('optimiz') || c.includes('seo')) return 'seo';
  if (c.includes('advertis') || c.includes('marketing')) return 'advertising';
  if (c.includes('monitor') || c.includes('analytics') || c.includes('webhook')) return 'monitoring';
  if (c.includes('security')) return 'security';
  if (c.includes('archiv')) return 'archive';
  if (c.includes('social')) return 'social';
  if (c.includes('preview')) return 'page_preview';
  if (c.includes('academic') || c.includes('research')) return 'academic';
  if (c.includes('accessibility')) return 'accessibility';
  if (c.includes('aggregat') || c.includes('feed')) return 'aggregator';
  return c.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32) || null;
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
