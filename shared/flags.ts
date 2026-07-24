/**
 * bot_flags bit definitions — PROJECT_PLAN.md §6.2, §4.6.
 *
 * Shared by the SDK (client-side checks report which signals fired) and the
 * workers (scoring engine, drill-down evidence cards). One INTEGER column
 * holds the bitmap.
 *
 * IMPORTANT (§21): this file defines WHICH signals exist, never how much
 * they weigh. Weights/thresholds come from config (config.example.toml →
 * config.local.toml → generated shared/config.gen.ts) via FLAG_CONFIG_KEY.
 */

export const FLAG = {
  /** navigator.webdriver === true (hard signal) */
  WEBDRIVER: 0x0001,
  /** automation residue globals: _phantom / __nightmare / $cdc_* / callPhantom (hard) */
  AUTOMATION_RESIDUE: 0x0002,
  /** UA vs Sec-CH-UA / client-environment contradiction */
  UA_CH_MISMATCH: 0x0004,
  /** request from a hosting/datacenter ASN */
  DATACENTER_ASN: 0x0008,
  /** Sec-Fetch-* headers absent */
  SEC_FETCH_MISSING: 0x0010,
  /** JS timezone vs IP geo (cf.timezone) contradiction */
  TZ_IP_MISMATCH: 0x0020,
  /** zero interaction AND no page_leave in the session */
  ZERO_INTERACTION_NO_LEAVE: 0x0040,
  /** software-rendered WebGL: SwiftShader / llvmpipe / Mesa OffScreen */
  SOFTWARE_WEBGL: 0x0080,
  /** near-zero inter-event interval CV (mechanical timing) */
  MECHANICAL_TIMING: 0x0100,
  /** matches a KV-blocklisted cluster */
  BLOCKLIST_CLUSTER: 0x0200,
  /** hidden honeypot link followed (hard) */
  HONEYPOT: 0x0400,
  /** screen/device contradiction (screen==inner / 800x600 / touch / cores) */
  SCREEN_DEVICE_MISMATCH: 0x0800,
  /** mobile UA but no devicemotion data (Android-only signal, §4.6) */
  MOBILE_NO_MOTION: 0x1000,
  /** accelerationIncludingGravity perfectly static across samples (§4.6) */
  MOTION_STATIC: 0x2000,
  /** referrer claims a search engine but the request comes from a datacenter
   *  ASN — real organic-search users are on residential/mobile networks, so a
   *  "Google/Bing" visit from a cloud/hosting IP is almost always forged */
  SEARCH_REF_DATACENTER: 0x4000,
  /** referrer claims a search engine but is structurally implausible: http (not
   *  https), a leaked ?q= query (Google/Bing strip it), or a Sec-Fetch-Site that
   *  contradicts an external referrer (same-origin/none) */
  FORGED_SEARCH_REFERRER: 0x8000,
  /** User-Agent advertises a headless engine ("HeadlessChrome" / "Headless") —
   *  a self-declared automation runtime (server-side, high precision) */
  HEADLESS_UA: 0x10000,
  /** headless window geometry: outer width/height report 0 on a desktop browser
   *  that has a real inner viewport (a windowless / old-headless-Chrome tell) */
  HEADLESS_WINDOW: 0x20000,
  /** navigator.platform contradicts the UA's OS family (e.g. a Windows/macOS/iOS
   *  UA on a Linux platform) — a common OS-spoofing tell for cloud automation */
  UA_PLATFORM_MISMATCH: 0x40000,
  /** synthetic rendering environment: a bare headless/container runtime renders
   *  color emoji as a monochrome glyph and collapses every system-font family to
   *  one fallback metric (no real fonts installed). Count of such tells (§4.4). */
  SYNTHETIC_ENV: 0x80000,
} as const;

export type FlagName = keyof typeof FLAG;

/**
 * Maps each flag to its key in the [weights] table of config.example.toml /
 * config.local.toml. The scoring engine resolves weights ONLY through this
 * mapping — no numeric weight ever appears in code (§21).
 */
export const FLAG_CONFIG_KEY: Record<FlagName, string> = {
  WEBDRIVER: 'webdriver',
  AUTOMATION_RESIDUE: 'automation_residue',
  UA_CH_MISMATCH: 'ua_clienthints_mismatch',
  DATACENTER_ASN: 'datacenter_asn',
  SEC_FETCH_MISSING: 'sec_fetch_missing',
  TZ_IP_MISMATCH: 'timezone_ip_mismatch',
  ZERO_INTERACTION_NO_LEAVE: 'zero_interaction_noleave',
  SOFTWARE_WEBGL: 'software_webgl',
  MECHANICAL_TIMING: 'mechanical_timing',
  BLOCKLIST_CLUSTER: 'blocklist_cluster',
  HONEYPOT: 'honeypot',
  SCREEN_DEVICE_MISMATCH: 'screen_device_mismatch',
  MOBILE_NO_MOTION: 'mobile_no_motion',
  MOTION_STATIC: 'motion_static',
  SEARCH_REF_DATACENTER: 'search_ref_datacenter',
  FORGED_SEARCH_REFERRER: 'forged_search_referrer',
  HEADLESS_UA: 'headless_ua',
  HEADLESS_WINDOW: 'headless_window',
  UA_PLATFORM_MISMATCH: 'ua_platform_mismatch',
  SYNTHETIC_ENV: 'synthetic_env',
} as const;

/** All flag names, in ascending bit order. */
export const ALL_FLAGS = Object.keys(FLAG) as FlagName[];

/** Bitmask of the two forged-organic-search flags (the alert's "fake search"
 *  tally and the rollup's fake_pv column share this). */
export const FAKE_SEARCH_MASK = FLAG.SEARCH_REF_DATACENTER | FLAG.FORGED_SEARCH_REFERRER;

/** SQLite predicate matching a search-engine referrer host over a ref_domain
 *  column — the majors organic-traffic forgers imitate. Used by BOTH the daily
 *  rollup (search_ref_pv) and the alerts "share of search traffic" denominator;
 *  they must stay byte-identical, so the fragment lives here, not inline. */
export function searchRefDomainSql(col: string): string {
  return `(${col} LIKE 'google.%' OR ${col} LIKE 'www.google.%'
    OR ${col} LIKE '%bing.com' OR ${col} LIKE '%duckduckgo.com'
    OR ${col} LIKE '%yahoo.com' OR ${col} LIKE '%baidu.com'
    OR ${col} LIKE 'yandex.%' OR ${col} LIKE 'www.yandex.%')`;
}

/** Decode a bot_flags bitmap into the list of fired signal names. */
export function flagNames(bitmap: number): FlagName[] {
  return ALL_FLAGS.filter((name) => (bitmap & FLAG[name]) !== 0);
}

export function hasFlag(bitmap: number, flag: FlagName): boolean {
  return (bitmap & FLAG[flag]) !== 0;
}

// ---------------------------------------------------------------------------
// SDK wire protocol for authenticity signals (§4.4: field names obfuscated
// as x1/x2/…). The SDK sends these inside the event's `x` object; the ingest
// scorer maps them back to flags. Absent key = check not run (≠ passed).
// ---------------------------------------------------------------------------

export const XF = {
  /** 0/1 — navigator.webdriver === true */
  WEBDRIVER: 'x1',
  /** 0/1 — automation residue globals present */
  AUTOMATION_RESIDUE: 'x2',
  /** 0/1 — env contradiction: Chrome UA w/o window.chrome, empty languages,
   *  desktop UA with 0 plugins, or permission-state contradiction */
  ENV_MISMATCH: 'x3',
  /** count — screen/device contradictions (screen==inner, 800x600,
   *  colorDepth 0, mobile UA w/o touch, abnormal cores/memory) */
  SCREEN_DEVICE_COUNT: 'x4',
  /** string — IANA timezone from Intl (server compares to cf.timezone) */
  TIMEZONE: 'x5',
  /** 0/1 — WebGL renderer is software (SwiftShader/llvmpipe/Mesa OffScreen) */
  WEBGL_SOFT: 'x6',
  /** string — canvas render hash (expensive check; feeds fp_hash) */
  CANVAS_HASH: 'x7',
  /** 0/1 — hidden honeypot link followed */
  HONEYPOT: 'x8',
  /** 0/1 — Android only: whether any devicemotion event arrived (§4.6) */
  HAS_MOTION: 'x9',
  /** 0/1 — Android only: motion readings perfectly static (§4.6) */
  MOTION_STATIC: 'x10',
  /** 0/1 — desktop headless window tell: outerWidth/outerHeight === 0 */
  HEADLESS_WINDOW: 'x11',
  /** 0/1 — navigator.platform contradicts the UA OS family (Win/Mac/iOS) */
  UA_PLATFORM_MISMATCH: 'x12',
  /** count — synthetic-render tells: color emoji rendered monochrome, and/or
   *  no real system fonts installed (every family collapses to one metric) */
  SYNTHETIC_ENV: 'x13',
} as const;

/** Shape of the event `x` payload as sent by f.js. */
export interface XPayload {
  x1?: 0 | 1;
  x2?: 0 | 1;
  x3?: 0 | 1;
  x4?: number;
  x5?: string;
  x6?: 0 | 1;
  x7?: string;
  x8?: 0 | 1;
  x9?: 0 | 1;
  x10?: 0 | 1;
  x11?: 0 | 1;
  x12?: 0 | 1;
  x13?: number;
}

/** Persisted verdict values (§6.2). Verified crawlers classified separately. */
export type Verdict = 'clean' | 'suspect' | 'bot' | 'crawler';

/** Which scoring pass assigned the current score (§6.2). */
export type ScoreStage = 'realtime' | 'session' | 'batch';

/**
 * Map a 0–100 bot_score to a verdict using config bands
 * ([bands] clean_max / suspect_max — never hardcoded here).
 */
export function verdictForScore(
  score: number,
  bands: { clean_max: number; suspect_max: number },
): Exclude<Verdict, 'crawler'> {
  if (score <= bands.clean_max) return 'clean';
  if (score <= bands.suspect_max) return 'suspect';
  return 'bot';
}
