/**
 * Server-side enrichment — PROJECT_PLAN.md §5.
 *
 * Everything here is derived server-side (anti-forgery): geo from request.cf,
 * ASN → asn_type, UA parse, IP → keyed truncated hash + /24 segment hash,
 * URL → UTM / click_id columns + extra_params. The client never supplies
 * these fields.
 */

import type { IncomingEvent, EventRow } from '../../../shared/events';
import { classifyAsn, type AsnType } from '../../../shared/asn';
import { hmacSign } from '../../../shared/ids';

// ---------------------------------------------------------------------------
// UA parsing (deliberately small — coarse buckets are enough for analytics;
// crawler UAs are matched for separate classification, §6.6)
// ---------------------------------------------------------------------------

export interface UAInfo {
  browser: string;
  os: string;
  device_type: 'desktop' | 'mobile' | 'tablet' | 'bot';
  isCrawler: boolean;
}

const CRAWLER_RE =
  /googlebot|mediapartners-google|adsbot|bingbot|slurp|duckduckbot|baiduspider|yandexbot|applebot|petalbot|bytespider|semrushbot|ahrefsbot|mj12bot|dotbot|facebookexternalhit|twitterbot|linkedinbot|telegrambot|whatsapp|gptbot|claudebot|ccbot|amazonbot/i;

export function parseUA(ua: string | null): UAInfo {
  const s = ua ?? '';
  if (!s || CRAWLER_RE.test(s)) {
    return { browser: s ? 'crawler' : 'unknown', os: 'unknown', device_type: 'bot', isCrawler: !!s };
  }

  let os = 'unknown';
  if (/windows nt/i.test(s)) os = 'Windows';
  else if (/android/i.test(s)) os = 'Android';
  else if (/iphone|ipad|ipod/i.test(s)) os = 'iOS';
  else if (/mac os x|macintosh/i.test(s)) os = 'macOS';
  else if (/cros/i.test(s)) os = 'ChromeOS';
  else if (/linux/i.test(s)) os = 'Linux';

  let browser = 'other';
  if (/edg(e|a|ios)?\//i.test(s)) browser = 'Edge';
  else if (/opr\/|opera/i.test(s)) browser = 'Opera';
  else if (/samsungbrowser\//i.test(s)) browser = 'Samsung Internet';
  else if (/firefox\/|fxios\//i.test(s)) browser = 'Firefox';
  else if (/crios\//i.test(s)) browser = 'Chrome';
  else if (/chrome\//i.test(s)) browser = 'Chrome';
  else if (/safari\//i.test(s) && /version\//i.test(s)) browser = 'Safari';

  let device_type: UAInfo['device_type'] = 'desktop';
  if (/ipad|tablet|(android(?!.*mobile))/i.test(s)) device_type = 'tablet';
  else if (/mobi|iphone|ipod|android/i.test(s)) device_type = 'mobile';

  return { browser, os, device_type, isCrawler: false };
}

/** Is this a Chromium-family browser expected to send Sec-CH-UA? */
export function isChromiumUA(ua: string | null): boolean {
  if (!ua) return false;
  const m = ua.match(/Chrome\/(\d+)/);
  return !!m && parseInt(m[1], 10) >= 90;
}

// ---------------------------------------------------------------------------
// URL parsing: UTM + click ids as dedicated columns, rest → extra_params (§5)
// ---------------------------------------------------------------------------

const CLICK_ID_PARAMS = ['gclid', 'fbclid', 'ttclid', 'msclkid', 'ref'] as const;
const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'] as const;
const MAX_EXTRA_PARAMS_LEN = 2048;

export interface UrlInfo {
  hostname: string;
  path: string;
  utm: Record<(typeof UTM_KEYS)[number], string | null>;
  click_id: string | null;
  click_id_type: string | null;
  extra_params: string | null;
}

export function parseEventUrl(raw: string): UrlInfo | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const utm = {
    utm_source: null, utm_medium: null, utm_campaign: null, utm_term: null, utm_content: null,
  } as UrlInfo['utm'];
  let click_id: string | null = null;
  let click_id_type: string | null = null;
  const extras: Record<string, string> = {};

  for (const [k, v] of url.searchParams) {
    const key = k.toLowerCase();
    if ((UTM_KEYS as readonly string[]).includes(key)) {
      utm[key as (typeof UTM_KEYS)[number]] ??= v.slice(0, 255);
    } else if ((CLICK_ID_PARAMS as readonly string[]).includes(key)) {
      if (!click_id) {
        click_id = v.slice(0, 255);
        click_id_type = key;
      }
    } else {
      extras[key] = v.slice(0, 255);
    }
  }

  let extra_params: string | null = null;
  if (Object.keys(extras).length > 0) {
    const s = JSON.stringify(extras);
    // drop rather than slice — a truncated JSON string is invalid and would
    // break any later parse (each value is already individually capped at 255)
    extra_params = s.length <= MAX_EXTRA_PARAMS_LEN ? s : null;
  }

  return {
    hostname: url.hostname.toLowerCase(),
    path: url.pathname || '/',
    utm,
    click_id,
    click_id_type,
    extra_params,
  };
}

export function refDomain(referrer: string | undefined): string | null {
  if (!referrer) return null;
  try {
    return new URL(referrer).hostname.toLowerCase();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Privacy-preserving hashes (§5, §16): IP stored ONLY as keyed truncated
// hashes; fingerprint stored ONLY as a keyed hash. Keyed with HMAC_KEY
// (Workers Secret) so hashes are deployment-local and non-reversible.
// ---------------------------------------------------------------------------

const HASH_LEN = 24;

export async function hashIP(secret: string, ip: string | null): Promise<{ ip_hash: string | null; ip24_hash: string | null }> {
  if (!ip) return { ip_hash: null, ip24_hash: null };
  const segment = ipSegment(ip);
  const [ip_hash, ip24_hash] = await Promise.all([
    hmacSign(secret, `ip|${ip}`).then((h) => h.slice(0, HASH_LEN)),
    segment ? hmacSign(secret, `ip24|${segment}`).then((h) => h.slice(0, HASH_LEN)) : Promise.resolve(null),
  ]);
  return { ip_hash, ip24_hash };
}

/** IPv4 → /24; IPv6 → /48-ish (first 3 groups). */
export function ipSegment(ip: string): string | null {
  if (ip.includes(':')) {
    const groups = ip.split(':').slice(0, 3).join(':');
    return groups ? `${groups}::/48` : null;
  }
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
}

/** Fingerprint hash from canvas hash + coarse env (only the hash persists, §15). */
export async function fingerprintHash(
  secret: string,
  canvasHash: string | undefined,
  ua: string | null,
  sw: number | undefined,
  sh: number | undefined,
  lang: string | undefined,
): Promise<string | null> {
  if (!canvasHash) return null;
  const material = `fp|${canvasHash}|${ua ?? ''}|${sw ?? 0}x${sh ?? 0}|${lang ?? ''}`;
  return (await hmacSign(secret, material)).slice(0, HASH_LEN);
}

// ---------------------------------------------------------------------------
// Full enrichment: IncomingEvent + request context → EventRow (score fields
// defaulted; score.ts fills them)
// ---------------------------------------------------------------------------

/** Coerce an optional client-supplied field to a bounded string, or null.
 *  Guards against forged non-string values (e.g. `"r": 5`) whose `.slice`
 *  would otherwise throw and 500 the whole batch. */
function str(v: unknown, max: number): string | null {
  if (v === undefined || v === null || v === '') return null;
  return String(v).slice(0, max);
}

const MAX_PROPS_LEN = 4096;
/** Client ts is trusted only within this window around server time (§5 anti-forgery). */
const TS_TOLERANCE_MS = 10 * 60 * 1000;

export interface RequestContext {
  cf: IncomingRequestCfProperties | undefined;
  ua: string | null;
  ip: string | null;
  now: number;
}

export async function enrichEvent(
  ev: IncomingEvent,
  ctx: RequestContext,
  secret: string,
): Promise<EventRow | null> {
  const urlInfo = parseEventUrl(ev.u);
  if (!urlInfo) return null;

  const uaInfo = parseUA(ctx.ua);
  const cf = ctx.cf;
  const asn = typeof cf?.asn === 'number' ? cf.asn : null;
  const asnType: AsnType = classifyAsn(asn ?? undefined, cf?.asOrganization);

  const { ip_hash, ip24_hash } = await hashIP(secret, ctx.ip);
  const fp_hash = await fingerprintHash(secret, ev.x?.x7, ctx.ua, ev.sw, ev.sh, ev.lang);

  let ts = typeof ev.ts === 'number' ? ev.ts : ctx.now;
  if (Math.abs(ts - ctx.now) > TS_TOLERANCE_MS) ts = ctx.now;

  // stable dedup key: derived only from the event's own identity fields, so a
  // redelivered copy hashes identically and INSERT OR IGNORE drops it. Two
  // genuinely distinct events differ in at least one of these.
  const eid = (await hmacSign(secret, `eid|${ev.s}|${ev.vid}|${ev.sid}|${ev.e}|${urlInfo.path}|${ts}`)).slice(0, 32);

  // revenue/currency are reserved props (§4.2); FX conversion to revenue_usd
  // at the daily rate is M3 — M1 stores USD verbatim only.
  const revenue = typeof ev.p?.revenue === 'number' ? (ev.p.revenue as number) : null;
  const currency = typeof ev.p?.currency === 'string' ? (ev.p.currency as string).slice(0, 8) : null;
  const revenue_usd = revenue !== null && (currency === null || currency.toUpperCase() === 'USD') ? revenue : null;

  // store props only if the JSON fits — truncating a serialized object with
  // slice() would persist syntactically invalid JSON that breaks any later parse
  let props: string | null = null;
  if (ev.p && Object.keys(ev.p).length > 0) {
    try {
      const s = JSON.stringify(ev.p);
      props = s.length <= MAX_PROPS_LEN ? s : null;
    } catch {
      props = null;
    }
  }

  return {
    eid,
    site_id: ev.s,
    event: String(ev.e).slice(0, 64),
    visitor_id: String(ev.vid).slice(0, 64),
    session_id: String(ev.sid).slice(0, 64),
    user_id: ev.uid ? String(ev.uid).slice(0, 128) : null,
    url: String(ev.u).slice(0, 2048),
    hostname: urlInfo.hostname,
    path: urlInfo.path.slice(0, 1024),
    referrer: str(ev.r, 2048),
    ref_domain: refDomain(typeof ev.r === 'string' ? ev.r : undefined),
    ...urlInfo.utm,
    click_id: urlInfo.click_id,
    click_id_type: urlInfo.click_id_type,
    extra_params: urlInfo.extra_params,
    country: cf?.country ?? null,
    region: (cf?.region as string | undefined) ?? null,
    city: (cf?.city as string | undefined) ?? null,
    browser: uaInfo.browser,
    os: uaInfo.os,
    device_type: uaInfo.device_type,
    screen_w: typeof ev.sw === 'number' ? ev.sw : null,
    screen_h: typeof ev.sh === 'number' ? ev.sh : null,
    lang: str(ev.lang, 35),
    ip_hash,
    ip24_hash,
    asn,
    asn_type: asnType,
    fp_hash,
    duration_ms: typeof ev.d === 'number' ? Math.max(0, Math.min(ev.d, 24 * 3600 * 1000)) : null,
    scroll_depth: typeof ev.sd === 'number' ? Math.max(0, Math.min(ev.sd, 100)) : null,
    had_interaction: ev.hi === 1 ? 1 : 0,
    revenue,
    revenue_usd,
    currency,
    props,
    ft_source: str(ev.ft?.s, 255),
    ft_medium: str(ev.ft?.m, 255),
    ft_campaign: str(ev.ft?.c, 255),
    ft_referrer: str(ev.ft?.r, 2048),
    bot_score: 0,
    verdict: 'clean',
    bot_flags: 0,
    score_stage: 'realtime',
    ts,
    created_at: ctx.now,
  };
}
