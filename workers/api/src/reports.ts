/**
 * Read-only reports for site launchers and A/B-testing clients (api + console):
 *
 *   GET /v1/sites/:id/experiment?experiment=…&goal=…   — Bayesian A/B readout
 *   GET /v1/sites/:id/experiments?period=30d           — experiments seen in exposures
 *   GET /v1/sites/:id/event_inventory?period=30d       — custom events + prop keys
 *   GET /v1/sites/:id/ai_referrals?period=30d&assistant=chatgpt
 *
 * Experiments are read from ordinary custom events: the page sends
 *   pvuv('event', 'exposure', { experiment, variant })
 * when a visitor is shown a variant (at most once per visitor/experiment/
 * variant/day is enough), and the goal is any other custom event name. Nothing
 * here writes; every query is bounded by the period and a LIMIT, scans the
 * month partitions overlapping the period only, and enters each partition
 * through its (site_id, event, ts) or (site_id, ts) index.
 */
import { eventTables, unionOver, parsePeriod, ApiError, type Period } from './queries';
import { RESERVED_EVENTS_SQL } from '../../../shared/events';
import { AI_ASSISTANTS, aiAssistantOf } from '../../../shared/channel';
import { tzOffsetMs } from '../../../shared/tz';

const CLEAN = "verdict NOT IN ('bot','crawler')";
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Dispatch one of the reports in this module, or `undefined` when `resource`
 *  is not one of them (the caller then falls through to its own routes). */
export async function extraReport(
  db: D1Database, siteId: string, resource: string, q: URLSearchParams, period: Period,
): Promise<unknown | undefined> {
  switch (resource) {
    case 'experiment': {
      // experiments usually outlive a 30-day default window less often than
      // they outlive a 7-day one; without an explicit period read 90 days
      const p = q.get('period') ? period : parsePeriod('90d', period.tz, period.now);
      return experimentReport(db, siteId, p, {
        experiment: q.get('experiment'),
        goal: q.get('goal'),
        windowHours: intParam(q.get('window_hours'), 48, 1, 720),
        baseline: q.get('baseline'),
        minExposures: intParam(q.get('min_exposures'), 100, 1, 1_000_000),
        winThreshold: winThresholdParam(q.get('win_threshold')),
        split: q.get('split'),
      });
    }
    case 'experiments': return experimentsList(db, siteId, period);
    case 'event_inventory': return eventInventory(db, siteId, period);
    case 'ai_referrals': return aiReferrals(db, siteId, period, q.get('assistant'), intParam(q.get('limit'), 10, 1, 100));
    default: return undefined;
  }
}

function intParam(raw: string | null, def: number, min: number, max: number): number {
  const n = raw == null || raw === '' ? def : parseInt(raw, 10);
  return Math.min(Math.max(Number.isFinite(n) ? n : def, min), max);
}

const periodOut = (p: Period) => ({ start: p.start, end: p.end });

// ---------------------------------------------------------------------------
// Beta-Binomial "probability to be best" (pure, deterministic)
// ---------------------------------------------------------------------------

/** mulberry32 — tiny seeded PRNG, uniform in [0, 1). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a of a string — seeds the PRNG from the experiment's identity. */
export function seedOf(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

function stdNormal(rng: () => number): number {
  let u = 0;
  while (u === 0) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/** Gamma(shape, 1) via Marsaglia–Tsang (boosted for shape < 1). */
function gammaDraw(shape: number, rng: () => number): number {
  if (shape < 1) {
    let u = 0;
    while (u === 0) u = rng();
    return gammaDraw(shape + 1, rng) * Math.pow(u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number, v: number;
    do { x = stdNormal(rng); v = 1 + c * x; } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function betaDraw(a: number, b: number, rng: () => number): number {
  const x = gammaDraw(a, rng);
  const y = gammaDraw(b, rng);
  return x / (x + y);
}

/**
 * Monte Carlo over independent Beta(1 + c, 1 + n − c) posteriors (uniform
 * prior, Binomial likelihood): for each draw, which arm has the highest
 * conversion rate. Returns P(arm is best) per arm and, when `baseline` is an
 * index, P(arm's rate > baseline's rate). Same inputs + seed → same output.
 */
export function betaBinomialPBest(
  arms: ReadonlyArray<{ visitors: number; conversions: number }>,
  opts: { draws?: number; seed?: number; baseline?: number | null } = {},
): { p_best: number[]; p_beat_baseline: Array<number | null> | null } {
  const k = arms.length;
  if (k === 0) return { p_best: [], p_beat_baseline: null };
  if (k === 1) return { p_best: [1], p_beat_baseline: opts.baseline === 0 ? [0] : null };
  const draws = Math.max(100, Math.min(opts.draws ?? 10_000, 200_000));
  const rng = mulberry32(opts.seed ?? 0x9e3779b9);
  const params = arms.map((a) => {
    const n = Math.max(0, Math.floor(a.visitors));
    const c = Math.min(Math.max(0, Math.floor(a.conversions)), n);
    return [1 + c, 1 + n - c] as const;
  });
  const b = opts.baseline ?? -1;
  const wins = new Array(k).fill(0);
  const beat = new Array(k).fill(0);
  const x = new Array(k).fill(0);
  for (let d = 0; d < draws; d++) {
    let best = 0;
    for (let i = 0; i < k; i++) {
      x[i] = betaDraw(params[i][0], params[i][1], rng);
      if (x[i] > x[best]) best = i;
    }
    wins[best]++;
    if (b >= 0) for (let i = 0; i < k; i++) if (i !== b && x[i] > x[b]) beat[i]++;
  }
  const r4 = (v: number) => Math.round(v * 10_000) / 10_000;
  return {
    p_best: wins.map((w) => r4(w / draws)),
    p_beat_baseline: b >= 0 ? beat.map((w, i) => (i === b ? null : r4(w / draws))) : null,
  };
}

/** Default P(best) a variant needs to be declared the winner. Strict on
 *  purpose: an adaptive client shifts most traffic to the winner on this
 *  verdict, so a false positive is expensive. `win_threshold` overrides it. */
export const WINNER_P_BEST = 0.99;

/** `win_threshold` param: a probability in [0.5, 0.999]; anything else → default. */
function winThresholdParam(raw: string | null): number {
  const n = raw === null || raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) ? Math.min(Math.max(n, 0.5), 0.999) : WINNER_P_BEST;
}
export const LOSER_P_BEST = 0.01;

export type ExperimentStatus = 'running' | 'winner' | 'insufficient';

/** The decision rule, separate from the data so it can be tested on its own:
 *  - insufficient: fewer than two variants, or any variant (the named baseline
 *    included) below `minExposures` visitors — no verdict, no losers;
 *  - winner: one variant has P(best) ≥ winThreshold (default WINNER_P_BEST);
 *  - otherwise running.
 *  In winner/running, losers = every variant with P(best) < 0.01 (the
 *  baseline is not exempt; a client that must keep a control can skip it). */
export function decide(
  variants: ReadonlyArray<{ variant: string; visitors: number; p_best: number }>, minExposures: number,
  winThreshold: number = WINNER_P_BEST,
): { status: ExperimentStatus; winner: string | null; losers: string[]; reason: string } {
  if (variants.length < 2) return { status: 'insufficient', winner: null, losers: [], reason: 'fewer than two variants have exposures' };
  const thin = variants.filter((v) => v.visitors < minExposures);
  if (thin.length) {
    return { status: 'insufficient', winner: null, losers: [], reason: `below min_exposures (${minExposures}): ${thin.map((v) => v.variant).join(', ')}` };
  }
  const losers = variants.filter((v) => v.p_best < LOSER_P_BEST).map((v) => v.variant);
  const top = variants.reduce((a, v) => (v.p_best > a.p_best ? v : a));
  if (top.p_best >= winThreshold) {
    return { status: 'winner', winner: top.variant, losers, reason: `P(best) of ${top.variant} is ${top.p_best} ≥ ${winThreshold}` };
  }
  return { status: 'running', winner: null, losers, reason: `no variant has P(best) ≥ ${winThreshold} yet` };
}

// ---------------------------------------------------------------------------
// GET /experiment
// ---------------------------------------------------------------------------

const MAX_VARIANTS = 20;
const NAME_MAX = 128;

export const EXPERIMENT_METHOD =
  'visitors = distinct clean (non-bot, non-crawler) visitors with an `exposure` event for this experiment in the period, '
  + 'each attributed to the variant of their FIRST exposure; conversion = the same visitor fires `goal` within window_hours '
  + 'after that first exposure. p_best = P(variant has the highest conversion rate) from 10,000 Monte Carlo draws of '
  + 'independent Beta(1 + conversions, 1 + visitors − conversions) posteriors with a PRNG seeded from experiment+goal, '
  + 'so the same data always gives the same numbers. Decision: insufficient if any variant has < min_exposures visitors; '
  + `winner when one variant has p_best ≥ win_threshold (default ${WINNER_P_BEST}); losers = variants with p_best < ${LOSER_P_BEST}.`;

export async function experimentReport(
  db: D1Database, siteId: string, period: Period,
  o: { experiment: string | null; goal: string | null; windowHours: number; baseline: string | null; minExposures: number; winThreshold: number; split: string | null },
) {
  const experiment = (o.experiment ?? '').trim().slice(0, NAME_MAX);
  const goal = (o.goal ?? '').trim().slice(0, 64);
  if (!experiment) throw new ApiError(400, 'experiment is required (the `experiment` prop of your exposure events)');
  if (!goal) throw new ApiError(400, 'goal is required (a custom event name, e.g. play_start — see event_inventory)');
  const baseline = o.baseline ? o.baseline.trim().slice(0, NAME_MAX) : null;
  const windowMs = o.windowHours * HOUR;

  const exTables = await eventTables(db, period.startTs, period.endTs);
  type Row = { variant: string; visitors: number; conversions: number; multi: number };
  let rows: Row[] = [];
  if (exTables.length) {
    const ex = unionOver(exTables, 'visitor_id, ts, props', siteId, period.startTs, period.endTs,
      `event = 'exposure' AND ${CLEAN} AND json_valid(props) AND json_extract(props, '$.experiment') = ?`, [experiment]);
    // a conversion may land up to window_hours after the period's last exposure
    const goalEnd = period.endTs + windowMs;
    const gTables = await eventTables(db, period.startTs, goalEnd);
    const g = unionOver(gTables, 'visitor_id, ts', siteId, period.startTs, goalEnd, `event = ? AND ${CLEAN}`, [goal]);
    const res = await db.prepare(`
      WITH ex AS MATERIALIZED (
        SELECT visitor_id, ts, CAST(json_extract(props, '$.variant') AS TEXT) AS v FROM (${ex.sql})
      ),
      per AS (
        SELECT visitor_id, MIN(ts) AS t0,
               SUBSTR(MIN(printf('%020d', ts) || v), 21) AS variant,
               COUNT(DISTINCT v) AS nv
        FROM ex WHERE v IS NOT NULL AND v != '' GROUP BY visitor_id
      ),
      g AS MATERIALIZED (${g.sql}),
      conv AS (
        SELECT per.visitor_id AS visitor_id FROM per
        JOIN g ON g.visitor_id = per.visitor_id AND g.ts >= per.t0 AND g.ts <= per.t0 + ?
        GROUP BY per.visitor_id
      )
      SELECT per.variant AS variant, COUNT(*) AS visitors,
             SUM(CASE WHEN conv.visitor_id IS NOT NULL THEN 1 ELSE 0 END) AS conversions,
             SUM(CASE WHEN per.nv > 1 THEN 1 ELSE 0 END) AS multi
      FROM per LEFT JOIN conv ON conv.visitor_id = per.visitor_id
      GROUP BY per.variant ORDER BY visitors DESC LIMIT ${MAX_VARIANTS}
    `).bind(...ex.binds, ...g.binds, windowMs).all<Row>();
    rows = res.results.map((r) => ({
      variant: String(r.variant), visitors: Number(r.visitors) || 0,
      conversions: Number(r.conversions) || 0, multi: Number(r.multi) || 0,
    }));
  }
  // a named baseline with no exposures yet is still a variant of the test
  if (baseline && !rows.some((r) => r.variant === baseline)) rows.push({ variant: baseline, visitors: 0, conversions: 0, multi: 0 });
  rows.sort((a, b) => (a.variant === baseline ? -1 : b.variant === baseline ? 1 : a.variant < b.variant ? -1 : a.variant > b.variant ? 1 : 0));

  const bIdx = baseline ? rows.findIndex((r) => r.variant === baseline) : -1;
  const mc = betaBinomialPBest(rows, { seed: seedOf(`${experiment}|${goal}`), baseline: bIdx >= 0 ? bIdx : null });
  const baseRate = bIdx >= 0 && rows[bIdx].visitors ? rows[bIdx].conversions / rows[bIdx].visitors : null;
  const variants = rows.map((r, i) => {
    const rate = r.visitors ? Math.round((r.conversions / r.visitors) * 10_000) / 10_000 : 0;
    return {
      variant: r.variant,
      visitors: r.visitors,
      conversions: r.conversions,
      rate,
      p_best: mc.p_best[i] ?? 0,
      p_beat_baseline: mc.p_beat_baseline ? mc.p_beat_baseline[i] : null,
      lift: baseRate && i !== bIdx ? Math.round(((r.visitors ? r.conversions / r.visitors : 0) / baseRate - 1) * 10_000) / 10_000 : null,
      multi_variant_visitors: r.multi,
    };
  });
  return {
    experiment, goal,
    period: periodOut(period),
    window_hours: o.windowHours,
    baseline,
    min_exposures: o.minExposures,
    win_threshold: o.winThreshold,
    split: o.split || null,
    variants,
    visitors_multi_variant: rows.reduce((s, r) => s + r.multi, 0),
    decision: decide(variants, o.minExposures, o.winThreshold),
    method: EXPERIMENT_METHOD,
    clean_only: true,
  };
}

// ---------------------------------------------------------------------------
// GET /experiments
// ---------------------------------------------------------------------------

export async function experimentsList(db: D1Database, siteId: string, period: Period) {
  const empty = { period: periodOut(period), experiments: [] as unknown[], clean_only: true };
  const tables = await eventTables(db, period.startTs, period.endTs);
  if (!tables.length) return empty;
  const u = unionOver(tables, 'visitor_id, ts, props', siteId, period.startTs, period.endTs,
    `event = 'exposure' AND ${CLEAN} AND json_valid(props)`);
  // one scan: per-variant rows plus per-experiment totals (variant NULL), since
  // a visitor who saw two variants must count once in the experiment total
  const res = await db.prepare(`
    WITH ex AS MATERIALIZED (
      SELECT visitor_id, ts,
             CAST(json_extract(props, '$.experiment') AS TEXT) AS e,
             CAST(json_extract(props, '$.variant') AS TEXT) AS v
      FROM (${u.sql})
    )
    SELECT e AS experiment, v AS variant, COUNT(DISTINCT visitor_id) AS visitors, COUNT(*) AS exposures,
           MIN(ts) AS first_seen, MAX(ts) AS last_seen
      FROM ex WHERE e IS NOT NULL AND e != '' GROUP BY e, v
    UNION ALL
    SELECT e, NULL, COUNT(DISTINCT visitor_id), COUNT(*), MIN(ts), MAX(ts)
      FROM ex WHERE e IS NOT NULL AND e != '' GROUP BY e
    ORDER BY 6 DESC LIMIT 1000
  `).bind(...u.binds).all<{ experiment: string; variant: string | null; visitors: number; exposures: number; first_seen: number; last_seen: number }>();
  type Exp = { experiment: string; visitors: number; exposures: number; first_seen: number; last_seen: number;
    variants: Array<{ variant: string; visitors: number; exposures: number; first_seen: number; last_seen: number }> };
  const by = new Map<string, Exp>();
  const get = (e: string) => by.get(e) ?? by.set(e, { experiment: e, visitors: 0, exposures: 0, first_seen: 0, last_seen: 0, variants: [] }).get(e)!;
  for (const r of res.results) {
    const x = get(r.experiment);
    if (r.variant === null) Object.assign(x, { visitors: r.visitors, exposures: r.exposures, first_seen: r.first_seen, last_seen: r.last_seen });
    else x.variants.push({ variant: r.variant ?? '(none)', visitors: r.visitors, exposures: r.exposures, first_seen: r.first_seen, last_seen: r.last_seen });
  }
  const experiments = [...by.values()]
    .map((x) => ({ ...x, variants: x.variants.sort((a, b) => b.visitors - a.visitors).slice(0, MAX_VARIANTS) }))
    .sort((a, b) => b.last_seen - a.last_seen)
    .slice(0, 100);
  return { ...empty, experiments };
}

// ---------------------------------------------------------------------------
// GET /event_inventory
// ---------------------------------------------------------------------------

const INVENTORY_EVENTS = 200;
const PROP_SAMPLE = 200;

export async function eventInventory(db: D1Database, siteId: string, period: Period) {
  const empty = { period: periodOut(period), events: [] as unknown[], reserved: RESERVED_EVENTS_SQL.replace(/'/g, '').split(','), clean_only: true };
  const tables = await eventTables(db, period.startTs, period.endTs);
  if (!tables.length) return empty;
  const u = unionOver(tables, 'event, visitor_id, ts, props', siteId, period.startTs, period.endTs,
    `event NOT IN (${RESERVED_EVENTS_SQL}) AND ${CLEAN}`);
  // one scan, two shapes (k = 0: per-event totals; k = 1: prop keys from the
  // newest PROP_SAMPLE events with props, per event name)
  const res = await db.prepare(`
    WITH ev AS MATERIALIZED (${u.sql}),
    s AS (
      SELECT event, props FROM (
        SELECT event, props, ROW_NUMBER() OVER (PARTITION BY event ORDER BY ts DESC) AS rn
        FROM ev WHERE props IS NOT NULL AND json_valid(props)
      ) WHERE rn <= ${PROP_SAMPLE}
    )
    SELECT 0 AS k, event, NULL AS key, NULL AS type, COUNT(*) AS n, COUNT(DISTINCT visitor_id) AS visitors,
           MIN(ts) AS first_seen, MAX(ts) AS last_seen, SUM(props IS NOT NULL) AS with_props, NULL AS examples
      FROM ev GROUP BY event
    UNION ALL
    SELECT 1, s.event, j.key, j.type, COUNT(*), NULL, NULL, NULL, NULL,
           SUBSTR(GROUP_CONCAT(DISTINCT CASE WHEN j.type IN ('text','integer','real','true','false') THEN SUBSTR(REPLACE(CAST(j.atom AS TEXT), ',', ' '), 1, 40) END), 1, 400)
      FROM s, json_each(s.props) AS j GROUP BY s.event, j.key, j.type
    ORDER BY 1, 5 DESC LIMIT 4000
  `).bind(...u.binds).all<{ k: number; event: string; key: string | null; type: string | null; n: number; visitors: number | null;
    first_seen: number | null; last_seen: number | null; with_props: number | null; examples: string | null }>();
  type Ev = { event: string; count: number; visitors: number; first_seen: number; last_seen: number; with_props: number;
    props: Array<{ key: string; type: string; seen: number; examples: string[] }> };
  const by = new Map<string, Ev>();
  for (const r of res.results) {
    if (r.k === 0) {
      by.set(r.event, { event: r.event, count: r.n, visitors: r.visitors ?? 0, first_seen: r.first_seen ?? 0,
        last_seen: r.last_seen ?? 0, with_props: r.with_props ?? 0, props: [] });
    }
  }
  for (const r of res.results) {
    if (r.k !== 1) continue;
    const e = by.get(r.event);
    if (!e || e.props.length >= 30) continue;
    e.props.push({ key: String(r.key), type: String(r.type), seen: r.n, examples: (r.examples ?? '').split(',').filter(Boolean).slice(0, 5) });
  }
  const events = [...by.values()].sort((a, b) => b.count - a.count).slice(0, INVENTORY_EVENTS);
  return { ...empty, events, prop_sample_per_event: PROP_SAMPLE };
}

// ---------------------------------------------------------------------------
// GET /ai_referrals
// ---------------------------------------------------------------------------

const ASSISTANT_LABEL = new Map(AI_ASSISTANTS.map((a) => [a.id, a.label]));

/**
 * Visits that arrived from an AI assistant: sessions whose channel is 'ai'
 * (shared/channel.ts — referrer domain such as chatgpt.com, or a utm_source
 * naming one, e.g. ?utm_source=chatgpt.com), clean traffic only. Session-level,
 * from the live sessions table via its (site_id, started_at) index.
 */
export async function aiReferrals(db: D1Database, siteId: string, period: Period, assistant: string | null, limit = 10) {
  const want = assistant ? assistant.trim().toLowerCase() : null;
  if (want && !ASSISTANT_LABEL.has(want)) {
    throw new ApiError(400, `unknown assistant: ${assistant} (one of ${AI_ASSISTANTS.map((a) => a.id).join(', ')})`);
  }
  const base = `site_id = ? AND started_at >= ? AND started_at < ? AND channel = 'ai' AND ${CLEAN}`;
  const binds: unknown[] = [siteId, period.startTs, period.endTs];

  const bySource = await db.prepare(`
    SELECT COALESCE(source, '') AS source, COUNT(*) AS sessions, COUNT(DISTINCT visitor_id) AS visitors,
           COALESCE(SUM(pageviews), 0) AS pageviews, COALESCE(SUM(is_bounce), 0) AS bounces
    FROM sessions WHERE ${base} GROUP BY 1 ORDER BY sessions DESC LIMIT 200
  `).bind(...binds).all<{ source: string; sessions: number; visitors: number; pageviews: number; bounces: number }>();

  type Agg = { assistant: string; label: string; sessions: number; visitors: number; pageviews: number; bounces: number; sources: string[] };
  const by = new Map<string, Agg>();
  for (const r of bySource.results) {
    const id = aiAssistantOf(r.source) ?? 'other';
    if (want && id !== want) continue;
    const a = by.get(id) ?? by.set(id, { assistant: id, label: ASSISTANT_LABEL.get(id) ?? 'Other AI', sessions: 0, visitors: 0, pageviews: 0, bounces: 0, sources: [] }).get(id)!;
    a.sessions += r.sessions; a.visitors += r.visitors; a.pageviews += r.pageviews; a.bounces += r.bounces;
    if (r.source) a.sources.push(r.source);
  }
  const assistants = [...by.values()].sort((a, b) => b.sessions - a.sessions).map(({ bounces, ...a }) => ({
    ...a, bounce_rate: a.sessions ? Math.round((bounces / a.sessions) * 10_000) / 10_000 : null,
  }));

  // restrict the series/landing queries to the chosen assistant's sources
  let where = base;
  const wb = [...binds];
  if (want) {
    const srcs = assistants.flatMap((a) => a.sources);
    if (!srcs.length) {
      return { period: periodOut(period), assistant: want, totals: { sessions: 0, visitors: 0, pageviews: 0 }, assistants: [], daily: [], landing_pages: [], clean_only: true };
    }
    where += ` AND COALESCE(source, '') IN (${srcs.map(() => '?').join(',')})`;
    wb.push(...srcs);
  }

  // site-local day; the offset is taken at the period's end, so a DST change
  // inside the period shifts that side's boundary by an hour (documented)
  const off = tzOffsetMs(Math.min(period.endTs - 1, period.now), period.tz);
  const res = await db.prepare(`
    SELECT 0 AS k, strftime('%Y-%m-%d', (started_at + ?) / 1000, 'unixepoch') AS key,
           COUNT(*) AS sessions, COUNT(DISTINCT visitor_id) AS visitors, COALESCE(SUM(pageviews), 0) AS pageviews
      FROM sessions WHERE ${where} GROUP BY 2
    UNION ALL
    SELECT 1, '', COUNT(*), COUNT(DISTINCT visitor_id), COALESCE(SUM(pageviews), 0) FROM sessions WHERE ${where}
    ORDER BY 1, 2 LIMIT 800
  `).bind(off, ...wb, ...wb).all<{ k: number; key: string; sessions: number; visitors: number; pageviews: number }>();
  const landing = await db.prepare(`
    SELECT COALESCE(NULLIF(entry_page, ''), '(unknown)') AS page, COUNT(*) AS sessions,
           COUNT(DISTINCT visitor_id) AS visitors, COALESCE(SUM(pageviews), 0) AS pageviews,
           COALESCE(SUM(is_bounce), 0) AS bounces
    FROM sessions WHERE ${where} GROUP BY 1 ORDER BY sessions DESC LIMIT ?
  `).bind(...wb, limit).all<{ page: string; sessions: number; visitors: number; pageviews: number; bounces: number }>();

  const dailyMap = new Map(res.results.filter((r) => r.k === 0).map((r) => [r.key, r]));
  const daily: Array<{ day: string; sessions: number; visitors: number; pageviews: number }> = [];
  for (let t = Date.parse(period.start + 'T00:00:00Z'), end = Date.parse(period.end + 'T00:00:00Z'); t <= end; t += DAY) {
    const day = new Date(t).toISOString().slice(0, 10);
    const r = dailyMap.get(day);
    daily.push({ day, sessions: r?.sessions ?? 0, visitors: r?.visitors ?? 0, pageviews: r?.pageviews ?? 0 });
  }
  const tot = res.results.find((r) => r.k === 1);
  return {
    period: periodOut(period),
    assistant: want,
    totals: { sessions: tot?.sessions ?? 0, visitors: tot?.visitors ?? 0, pageviews: tot?.pageviews ?? 0 },
    assistants,
    daily,
    landing_pages: landing.results.map(({ bounces, ...p }) => ({ ...p, bounce_rate: p.sessions ? Math.round((bounces / p.sessions) * 10_000) / 10_000 : null })),
    known_assistants: AI_ASSISTANTS.map((a) => a.id),
    clean_only: true,
  };
}
