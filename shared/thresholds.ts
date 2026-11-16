/**
 * Portfolio thresholds (docs/design/portfolio-ui.md §1): the instance-wide
 * numbers the overview uses for lifecycle stages and attention alerts.
 * Stored as one JSON value in `instance_settings` under PORTFOLIO_THRESHOLDS_KEY;
 * missing / malformed fields fall back to the contract defaults.
 *
 * Edited at GET/PUT /api/settings/portfolio (settings.html → Portfolio
 * thresholds); read by the overview through readPortfolioThresholds().
 */

// The slice of D1 / KV used here, typed structurally: shared/ is also compiled
// by the SDK's tsconfig, which has no Workers types. D1Database satisfies it.
interface Stmt {
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}
type D1Database = { prepare(sql: string): { bind(...values: unknown[]): Stmt } };

export const PORTFOLIO_THRESHOLDS_KEY = 'portfolio_thresholds';

export interface PortfolioThresholds {
  /** "stable growth": at least this many clean visitors in the last 7 days … */
  growth_uv_7d: number;
  /** … and a 7-day change of at least this many percent (negative = allowed dip) */
  growth_min_delta_pct: number;
  /** "declining": 28-day clean visitors down more than this percent vs the previous 28 days */
  decline_pct: number;
  /** IVT alert: invalid-traffic share above this percent */
  ivt_pct: number;
}

export const PORTFOLIO_DEFAULTS: PortfolioThresholds = {
  growth_uv_7d: 1000,
  growth_min_delta_pct: -10,
  decline_pct: 30,
  ivt_pct: 20,
};

const LIMITS: Record<keyof PortfolioThresholds, [number, number]> = {
  growth_uv_7d: [1, 1e9],
  growth_min_delta_pct: [-100, 1000],
  decline_pct: [1, 100],
  ivt_pct: [1, 100],
};

/** Validate a partial update. Unknown keys are rejected so a typo is loud. */
export function validateThresholds(body: unknown): { values: Partial<PortfolioThresholds> } | { error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'bad json' };
  const out: Partial<PortfolioThresholds> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (!(k in LIMITS)) return { error: `unknown setting: ${k}` };
    const [lo, hi] = LIMITS[k as keyof PortfolioThresholds];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) return { error: `${k} must be a number between ${lo} and ${hi}` };
    out[k as keyof PortfolioThresholds] = k === 'growth_uv_7d' ? Math.round(v) : Math.round(v * 10) / 10;
  }
  return { values: out };
}

export function mergeThresholds(raw: string | null | undefined): PortfolioThresholds {
  const out = { ...PORTFOLIO_DEFAULTS };
  if (!raw) return out;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return out; }
  if (!parsed || typeof parsed !== 'object') return out;
  for (const k of Object.keys(LIMITS) as (keyof PortfolioThresholds)[]) {
    const v = (parsed as Record<string, unknown>)[k];
    const [lo, hi] = LIMITS[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi) out[k] = v;
  }
  return out;
}

export async function readPortfolioThresholds(db: D1Database): Promise<PortfolioThresholds> {
  try {
    const row = await db.prepare('SELECT value FROM instance_settings WHERE key = ?')
      .bind(PORTFOLIO_THRESHOLDS_KEY).first<{ value: string }>();
    return mergeThresholds(row?.value);
  } catch {
    return { ...PORTFOLIO_DEFAULTS }; // table missing → defaults
  }
}

export async function writePortfolioThresholds(db: D1Database, patch: Partial<PortfolioThresholds>): Promise<PortfolioThresholds> {
  const next = { ...(await readPortfolioThresholds(db)), ...patch };
  await db.prepare(`INSERT INTO instance_settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .bind(PORTFOLIO_THRESHOLDS_KEY, JSON.stringify(next), Date.now()).run();
  return next;
}
