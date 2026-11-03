/**
 * Bot directory — an OPTIONAL, owner-supplied catalogue of known crawlers used
 * to label crawler traffic by category (PROJECT_PLAN.md §6.6).
 *
 * Why owner-supplied: Cloudflare's BotBase is Enterprise Bot Management only, so
 * a self-hosted deployment can't read it at runtime. The same catalogue is
 * published publicly (Cloudflare Radar's bots-and-agents directory, and
 * community JSON mirrors of it), so the deployer downloads it once and pastes it
 * into the console. No account, token or extra service is required, and the
 * feature degrades to "no categories" when nothing is imported.
 *
 * IMPORTANT — this is CLASSIFICATION ONLY. A category never changes a verdict,
 * a score, or an ad-guard decision; it is descriptive metadata so an owner can
 * see which kinds of crawlers visit (search vs AI-training vs SEO vs ads).
 *
 * The published shapes vary between sources and versions, so the parser is
 * deliberately format-tolerant rather than bound to one schema: it accepts a
 * bare array or a wrapper object, and reads each entry's pattern/category from
 * any of several conventional field names. The console shows a parse preview so
 * the deployer can confirm the import actually understood their file.
 */

export interface BotEntry {
  /** lower-cased UA substring to look for (never a regex — see matchBot) */
  pattern: string;
  /** display name of the bot/operator */
  name: string;
  /** normalized category, e.g. 'search' / 'ai_training' / 'seo' */
  category: string;
}

export interface ParsedDirectory {
  entries: BotEntry[];
  /** input records that carried no usable UA pattern */
  skipped: number;
  /** category → number of entries, for the import preview */
  categories: Record<string, number>;
}

/** Hard ceiling on imported entries — a directory is a few hundred rows; this
 *  bounds both the stored blob and the per-event matching cost. */
export const MAX_BOT_ENTRIES = 4000;
/** Patterns shorter than this match far too much of the UA string. */
const MIN_PATTERN_LEN = 3;

/** Field names seen across the published/mirrored directory formats. */
const PATTERN_KEYS = ['pattern', 'ua_pattern', 'uaPattern', 'user_agent', 'userAgent', 'ua', 'regex', 'token', 'slug', 'name', 'bot'];
const CATEGORY_KEYS = ['category', 'categories', 'bot_category', 'botCategory', 'type', 'classification', 'kind', 'group'];
const NAME_KEYS = ['name', 'bot', 'title', 'operator', 'owner', 'company', 'slug'];

/** Arrays can arrive bare or wrapped by an API envelope. */
const ARRAY_KEYS = ['result', 'results', 'bots', 'agents', 'data', 'directory', 'items', 'entries'];

function firstString(rec: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    // some feeds nest the value, e.g. category: { name: 'Search' }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const n = (v as Record<string, unknown>).name ?? (v as Record<string, unknown>).value;
      if (typeof n === 'string' && n.trim()) return n.trim();
    }
    // …or give a list, e.g. categories: ['Search']
    if (Array.isArray(v) && v.length) {
      const f = v[0];
      if (typeof f === 'string' && f.trim()) return f.trim();
      if (f && typeof f === 'object') {
        const n = (f as Record<string, unknown>).name;
        if (typeof n === 'string' && n.trim()) return n.trim();
      }
    }
  }
  return '';
}

/** Lower-case, collapse separators; keeps whatever vocabulary the source uses
 *  (we are observing, not imposing a taxonomy) but makes it groupable. */
export function normalizeCategory(raw: string): string {
  const c = raw.toLowerCase().trim().replace(/[\s/-]+/g, '_').replace(/[^a-z0-9_]/g, '').slice(0, 40);
  return c || 'uncategorized';
}

/** Locate the array of records inside whatever wrapper the source used. */
function findRecords(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    for (const k of ARRAY_KEYS) {
      const v = obj[k];
      if (Array.isArray(v)) return v;
      // one more level, e.g. { result: { bots: [...] } }
      if (v && typeof v === 'object') {
        for (const k2 of ARRAY_KEYS) {
          const v2 = (v as Record<string, unknown>)[k2];
          if (Array.isArray(v2)) return v2;
        }
      }
    }
    // last resort: an object keyed by bot name → record
    const vals = Object.values(obj);
    if (vals.length && vals.every((v) => v && typeof v === 'object')) return vals;
  }
  return [];
}

export function parseBotDirectory(raw: unknown): ParsedDirectory {
  const records = findRecords(raw);
  const entries: BotEntry[] = [];
  const seen = new Set<string>();
  const categories: Record<string, number> = {};
  let skipped = 0;

  for (const rec of records) {
    if (entries.length >= MAX_BOT_ENTRIES) break;
    let pattern = '';
    let name = '';
    let category = '';

    if (typeof rec === 'string') {
      pattern = rec.trim();
      name = pattern;
    } else if (rec && typeof rec === 'object') {
      const r = rec as Record<string, unknown>;
      pattern = firstString(r, PATTERN_KEYS);
      name = firstString(r, NAME_KEYS) || pattern;
      category = firstString(r, CATEGORY_KEYS);
    }

    // A regex-ish pattern is reduced to its longest literal run: matching is
    // plain substring only, so an untrusted file can never cost us a
    // catastrophic-backtracking regex on every event.
    const rawPattern = pattern;
    if (/[\\^$*+?()[\]{}|]/.test(pattern)) {
      const literals = pattern.split(/[\\^$*+?()[\]{}|.]+/).filter(Boolean);
      pattern = literals.sort((a, b) => b.length - a.length)[0] ?? '';
    }
    pattern = pattern.toLowerCase().trim();
    // a regex is unreadable as a label — show the literal we actually match on
    if (name === rawPattern && rawPattern !== pattern) name = pattern;

    if (pattern.length < MIN_PATTERN_LEN || seen.has(pattern)) { skipped++; continue; }
    seen.add(pattern);
    const cat = normalizeCategory(category);
    categories[cat] = (categories[cat] ?? 0) + 1;
    entries.push({ pattern, name: name.slice(0, 80), category: cat });
  }

  // longest pattern first, so the most specific bot wins a match
  entries.sort((a, b) => b.pattern.length - a.pattern.length);
  return { entries, skipped, categories };
}

/**
 * Classify a User-Agent against the directory. Plain case-insensitive substring
 * matching against pre-lowered patterns — predictable and immune to the ReDoS
 * risk of running imported regexes. Returns null when nothing matches.
 */
export function matchBot(ua: string | null | undefined, entries: BotEntry[]): BotEntry | null {
  if (!ua || !entries.length) return null;
  const s = ua.toLowerCase();
  for (const e of entries) if (s.indexOf(e.pattern) !== -1) return e;
  return null;
}
