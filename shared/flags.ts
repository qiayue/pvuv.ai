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
} as const;

/** All flag names, in ascending bit order. */
export const ALL_FLAGS = Object.keys(FLAG) as FlagName[];

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
