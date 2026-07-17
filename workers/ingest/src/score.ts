/**
 * Realtime first-pass scoring — PROJECT_PLAN.md §5, §6.2, score_stage='realtime'.
 *
 * Combines client authenticity signals (event.x, §4.4/§4.6) with server-side
 * signals available at the edge (ASN, header completeness, timezone vs IP,
 * KV blocklist). Session-level (0x0040 zero-interaction, 0x0100 mechanical
 * timing) and population signals are later passes (§6.3–§6.4, M2).
 *
 * §21: every weight/threshold/trust-credit comes from CONFIG (generated from
 * config.local.toml / config.example.toml). No numeric value lives here.
 */

import { CONFIG } from '../../../shared/config.gen';
import {
  FLAG, FLAG_CONFIG_KEY, verdictForScore,
  type FlagName, type Verdict, type XPayload,
} from '../../../shared/flags';
import type { AsnType } from '../../../shared/asn';

/** Distinct screen/device contradictions the SDK checks (§4.4): screen==inner,
 *  800x600, colorDepth 0, mobile-no-touch, cores 0, low deviceMemory. */
const MAX_SCREEN_CONTRADICTIONS = 6;

export interface ScoreInput {
  x: XPayload | undefined;
  asnType: AsnType;
  isCrawler: boolean;
  /** UA is Chromium ≥90 (expected to send Sec-CH-UA) */
  chromiumUA: boolean;
  headers: Headers;
  /** cf.timezone (IANA) of the connecting IP */
  ipTimezone: string | undefined;
  /** OS parsed from UA — sensor signals are Android-only (§4.6) */
  os: string;
  deviceType: string;
  hadInteraction: boolean;
  isPageLeave: boolean;
  /** fp_hash / ip24_hash matched the KV blocklist */
  blocklisted: boolean;
  /** raw navigation referrer (document.referrer) — for forged-search detection */
  referrer?: string | undefined;
}

/** A search-engine referrer host (majors that organic-traffic forgers imitate),
 *  ignoring a leading www. Google/Yandex span many ccTLDs. */
function searchEngineHost(host: string): 'google' | 'bing' | 'other' | null {
  const h = host.replace(/^www\./, '');
  if (/^google\.[a-z.]{2,}$/.test(h)) return 'google';
  if (h === 'bing.com') return 'bing';
  if (
    h === 'duckduckgo.com' || h === 'yahoo.com' || h === 'search.yahoo.com'
    || h === 'baidu.com' || h === 'm.baidu.com' || /^yandex\.[a-z.]{2,}$/.test(h)
    || h === 'ecosia.org' || h === 'search.brave.com' || h === 'qwant.com'
    || h === 'startpage.com' || h === 'sogou.com' || h === 'so.com'
  ) return 'other';
  return null;
}

export interface ScoreResult {
  bot_score: number;
  verdict: Verdict;
  bot_flags: number;
  score_stage: 'realtime';
}

export function scoreRealtime(input: ScoreInput): ScoreResult {
  let flags = 0;
  let score = 0;
  let hard = false;

  const fire = (flag: FlagName, times = 1): void => {
    flags |= FLAG[flag];
    const w = CONFIG.weights[FLAG_CONFIG_KEY[flag]];
    if (w === 'hard') hard = true;
    else if (typeof w === 'number') score += w * times;
  };

  const x = input.x ?? {};

  // --- client hard/cheap signals (§4.4) ---
  if (x.x1 === 1) fire('WEBDRIVER');
  if (x.x2 === 1) fire('AUTOMATION_RESIDUE');
  if (x.x3 === 1) fire('UA_CH_MISMATCH');
  // x4 is a spoofable count from the client; clamp it to the number of
  // distinct contradictions the SDK actually checks (input sanitation, not a
  // tunable weight — the per-hit weight itself still comes from CONFIG, §21)
  if (typeof x.x4 === 'number' && x.x4 > 0) fire('SCREEN_DEVICE_MISMATCH', Math.min(x.x4, MAX_SCREEN_CONTRADICTIONS));
  if (x.x6 === 1) fire('SOFTWARE_WEBGL');
  if (CONFIG.detection.honeypot_enabled && x.x8 === 1) fire('HONEYPOT');

  // --- mobile sensor signals, Android-only (§4.6) ---
  if (CONFIG.detection.mobile_sensors_enabled && input.os === 'Android' && input.deviceType === 'mobile') {
    if (x.x9 === 0) fire('MOBILE_NO_MOTION');
    if (x.x10 === 1) fire('MOTION_STATIC');
  }

  // --- server-side signals (§6.1) ---
  if (input.asnType === 'datacenter') fire('DATACENTER_ASN');

  const hasSecFetch =
    input.headers.has('sec-fetch-mode') || input.headers.has('sec-fetch-site') || input.headers.has('sec-fetch-dest');
  if (!hasSecFetch) fire('SEC_FETCH_MISSING');

  // Chromium ≥90 always sends Sec-CH-UA; a Chrome UA without it is forged.
  // (only fire once even if the client also reported x3)
  if (input.chromiumUA && !input.headers.has('sec-ch-ua') && !(flags & FLAG.UA_CH_MISMATCH)) {
    fire('UA_CH_MISMATCH');
  }

  // timezone contradiction: client Intl timezone vs IP timezone (§4.4) —
  // compared by UTC offset, not string equality (adjacent-zone safety)
  if (typeof x.x5 === 'string' && input.ipTimezone) {
    const a = tzOffsetMinutes(x.x5);
    const b = tzOffsetMinutes(input.ipTimezone);
    if (a !== null && b !== null && a !== b) fire('TZ_IP_MISMATCH');
  }

  if (input.blocklisted) fire('BLOCKLIST_CLUSTER');

  // --- forged organic-search referrer (§6.1) ---------------------------------
  // Real Google/Bing organic clicks arrive over https, from residential/mobile
  // networks, with the query stripped from the referrer and Sec-Fetch-Site:
  // cross-site. Crawlers/AI browsers that spoof `referer: google.com` to pass as
  // organic search break one of these. Two independent signals:
  //   • search referrer + datacenter ASN  (real searchers aren't in the cloud)
  //   • structurally implausible referrer  (http, ?q= leak, sec-fetch mismatch)
  if (input.referrer) {
    let refHost: string | null = null;
    let scheme = '';
    let hasQuery = false;
    try {
      const u = new URL(input.referrer);
      refHost = u.hostname.toLowerCase();
      scheme = u.protocol;
      hasQuery = u.search.length > 1 || /\/search\b/i.test(u.pathname);
    } catch { /* unparseable referrer → not a usable signal */ }

    const engine = refHost ? searchEngineHost(refHost) : null;
    if (engine) {
      if (input.asnType === 'datacenter') fire('SEARCH_REF_DATACENTER');

      const sfs = input.headers.get('sec-fetch-site');
      const notHttps = scheme !== 'https:';                       // majors are https-only
      const queryLeak = engine === 'google' && hasQuery;          // Google always trims to origin
      const secFetchContradiction = sfs === 'same-origin' || sfs === 'none';    // ≠ external nav
      if (notHttps || queryLeak || secFetchContradiction) fire('FORGED_SEARCH_REFERRER');
    }
  }

  // --- verdict ---
  if (hard) score = 100;

  if (!hard) {
    // trust credits (§6.2) — legit traffic looks cleaner
    const credits = CONFIG.trust_credits;
    if (input.asnType === 'residential' || input.asnType === 'mobile') {
      score -= credits.residential_or_mobile_asn ?? 0;
    }
    if (input.hadInteraction) score -= credits.has_interaction ?? 0;
    if (input.isPageLeave) score -= credits.has_page_leave ?? 0;
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  // Verified crawlers are classified separately regardless of score (§6.2).
  // M1 matches by UA; reverse-DNS verification hardens this in M2 (§15).
  const verdict: Verdict = input.isCrawler ? 'crawler' : verdictForScore(score, CONFIG.bands);

  return { bot_score: score, verdict, bot_flags: flags, score_stage: 'realtime' };
}

/** Current UTC offset of an IANA timezone, in minutes; null if unparseable. */
export function tzOffsetMinutes(tz: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' })
      .formatToParts(Date.now());
    const name = parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
    const m = name.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
    if (!m) return name === 'GMT' ? 0 : null;
    const sign = m[1] === '-' ? -1 : 1;
    return sign * (parseInt(m[2], 10) * 60 + (m[3] ? parseInt(m[3], 10) : 0));
  } catch {
    return null;
  }
}
