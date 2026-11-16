/**
 * Crawler / indexing signals — which ENGINE a crawler belongs to.
 *
 * For a newly launched site the first question is not "how many visitors" but
 * "has Googlebot (Bing, …) come yet, how often, and which pages". This module
 * answers the "which engine" part with a small built-in User-Agent matcher, so
 * the feature works with no imported bot directory at all.
 *
 * IMPORTANT — this is a SEPARATE METRIC. Nothing here feeds PV/UV, scoring,
 * verdicts or the ad-guard decision; it labels traffic that is already in the
 * crawler bucket (or that the edge saw and the beacon never did).
 *
 * Classification has two axes:
 *   engine — a stable id ('googlebot', 'bingbot', …). Crawlers the built-in
 *            list does not know collapse into `other_<kind>` so a deployer's
 *            imported directory can still say WHAT kind they were.
 *   kind   — search / ai / ads / seo / other. The imported bot directory's
 *            category (bot_category, PROJECT_PLAN.md §6.6) wins when present;
 *            the built-in kind is the fallback. Google's ads crawlers
 *            (AdsBot-Google, Mediapartners-Google) are always `ads`: AdSense
 *            owners need them kept apart from Googlebot, and a directory that
 *            files them under "search" would merge exactly the two things the
 *            owner is trying to tell apart.
 *
 * Matching is plain case-insensitive substring search over pre-lowered
 * patterns, same policy as shared/botdir.ts — predictable, no regex cost.
 */

export type CrawlerKind = 'search' | 'ai' | 'ads' | 'seo' | 'other';
export const CRAWLER_KINDS: readonly CrawlerKind[] = ['search', 'ai', 'ads', 'seo', 'other'];

export interface CrawlerEngine {
  engine: string;
  label: string;
  kind: CrawlerKind;
  /** lower-cased UA substrings, any of which identifies the engine */
  patterns: string[];
  /** built-in kind is authoritative even when a directory category exists */
  fixedKind?: boolean;
}

export interface CrawlerMatch {
  engine: string;
  label: string;
  kind: CrawlerKind;
}

/** Ordered: the first match wins, so more specific tokens come first (the
 *  Google ads bots before Googlebot, Bing's ads bot before Bingbot, …). */
export const CRAWLER_ENGINES: readonly CrawlerEngine[] = [
  // --- Google -------------------------------------------------------------
  { engine: 'google_adsbot', label: 'AdsBot-Google', kind: 'ads', patterns: ['adsbot-google'], fixedKind: true },
  { engine: 'google_adsense', label: 'Mediapartners-Google (AdSense)', kind: 'ads', patterns: ['mediapartners-google'], fixedKind: true },
  // URL Inspection / Rich Results test from Search Console: the owner asked,
  // Google did not decide to crawl — kept out of "first search crawl"
  { engine: 'google_inspection', label: 'Google-InspectionTool', kind: 'other', patterns: ['google-inspectiontool'] },
  { engine: 'googlebot', label: 'Googlebot', kind: 'search', patterns: ['googlebot'] },
  { engine: 'google_other', label: 'GoogleOther', kind: 'other', patterns: ['googleother', 'storebot-google', 'google-site-verification', 'google favicon', 'feedfetcher-google'] },
  // --- Microsoft ----------------------------------------------------------
  { engine: 'bing_ads', label: 'Bing AdIdxBot', kind: 'ads', patterns: ['adidxbot'], fixedKind: true },
  { engine: 'bingbot', label: 'Bingbot', kind: 'search', patterns: ['bingbot', 'bingpreview', 'msnbot'] },
  // --- other search engines -----------------------------------------------
  { engine: 'yandex', label: 'YandexBot', kind: 'search', patterns: ['yandexbot', 'yandeximages', 'yandexmobilebot', 'yandex.com/bots'] },
  { engine: 'baidu', label: 'Baiduspider', kind: 'search', patterns: ['baiduspider'] },
  { engine: 'applebot', label: 'Applebot', kind: 'search', patterns: ['applebot'] },
  { engine: 'duckduckgo', label: 'DuckDuckBot', kind: 'search', patterns: ['duckduckbot'] },
  // 'sogou' alone would also match the Sogou desktop/mobile BROWSERS
  { engine: 'sogou', label: 'Sogou Spider', kind: 'search', patterns: ['sogou web spider', 'sogou inst spider', 'sogou spider', 'sogou+web+spider', 'sogou-test-spider'] },
  { engine: 'so360', label: '360Spider', kind: 'search', patterns: ['360spider', 'haosouspider'] },
  { engine: 'shenma', label: 'YisouSpider (Shenma)', kind: 'search', patterns: ['yisouspider'] },
  { engine: 'petal', label: 'PetalBot (Huawei)', kind: 'search', patterns: ['petalbot'] },
  { engine: 'yahoo', label: 'Yahoo Slurp', kind: 'search', patterns: ['yahoo! slurp', 'slurp'] },
  { engine: 'naver', label: 'Naver Yeti', kind: 'search', patterns: ['yeti/', 'naverbot'] },
  { engine: 'seznam', label: 'SeznamBot', kind: 'search', patterns: ['seznambot'] },
  { engine: 'coccoc', label: 'coccocbot', kind: 'search', patterns: ['coccocbot'] },
  { engine: 'mojeek', label: 'MojeekBot', kind: 'search', patterns: ['mojeekbot'] },
  // --- AI crawlers / assistants -------------------------------------------
  { engine: 'bytespider', label: 'Bytespider (ByteDance)', kind: 'ai', patterns: ['bytespider'] },
  { engine: 'openai', label: 'OpenAI (GPTBot / ChatGPT)', kind: 'ai', patterns: ['gptbot', 'oai-searchbot', 'chatgpt-user'] },
  { engine: 'anthropic', label: 'Anthropic (ClaudeBot)', kind: 'ai', patterns: ['claudebot', 'claude-user', 'claude-searchbot', 'anthropic-ai', 'claude-web'] },
  { engine: 'perplexity', label: 'PerplexityBot', kind: 'ai', patterns: ['perplexitybot', 'perplexity-user'] },
  { engine: 'commoncrawl', label: 'CCBot (Common Crawl)', kind: 'ai', patterns: ['ccbot'] },
  { engine: 'meta_ai', label: 'Meta-ExternalAgent', kind: 'ai', patterns: ['meta-externalagent', 'meta-externalfetcher'] },
  { engine: 'amazonbot', label: 'Amazonbot', kind: 'ai', patterns: ['amazonbot'] },
  { engine: 'duckassist', label: 'DuckAssistBot', kind: 'ai', patterns: ['duckassistbot'] },
  { engine: 'mistral', label: 'MistralAI-User', kind: 'ai', patterns: ['mistralai-user'] },
  { engine: 'cohere', label: 'cohere-ai', kind: 'ai', patterns: ['cohere-ai', 'cohere-training'] },
  { engine: 'ai_other', label: 'Other AI crawler', kind: 'ai', patterns: ['diffbot', 'youbot', 'timpibot', 'ai2bot', 'omgilibot', 'imagesiftbot'] },
  // --- SEO tools ----------------------------------------------------------
  { engine: 'ahrefs', label: 'AhrefsBot', kind: 'seo', patterns: ['ahrefsbot', 'ahrefssiteaudit'] },
  { engine: 'semrush', label: 'SemrushBot', kind: 'seo', patterns: ['semrushbot', 'siteauditbot'] },
  { engine: 'majestic', label: 'MJ12bot (Majestic)', kind: 'seo', patterns: ['mj12bot'] },
  { engine: 'seo_other', label: 'Other SEO crawler', kind: 'seo', patterns: ['dotbot', 'rogerbot', 'screaming frog', 'serpstatbot', 'dataforseobot', 'blexbot', 'barkrowler'] },
  // --- link previews / social ---------------------------------------------
  { engine: 'social', label: 'Link preview (social)', kind: 'other', patterns: ['facebookexternalhit', 'facebookcatalog', 'twitterbot', 'linkedinbot', 'slackbot', 'telegrambot', 'discordbot', 'pinterestbot', 'whatsapp/'] },
];

const BY_ID = new Map(CRAWLER_ENGINES.map((e) => [e.engine, e]));

const OTHER_LABEL: Record<CrawlerKind, string> = {
  search: 'Other search crawler',
  ai: 'Other AI crawler',
  ads: 'Other ads crawler',
  seo: 'Other SEO crawler',
  other: 'Other crawler',
};

/** Engine id for a crawler the built-in list does not recognise. */
export function otherEngine(kind: CrawlerKind): string {
  return `other_${kind}`;
}

/**
 * Map a bot_category (the imported directory's vocabulary, or Cloudflare's
 * verified-bot category, both normalized by shared/botdir.ts normalizeCategory)
 * onto a kind. Returns null for "no usable category".
 *
 * Order matters: Cloudflare's "Search Engine Optimization" contains "search",
 * and "AI Search" is an AI product rather than a web index.
 */
export function kindFromCategory(category: string | null | undefined): CrawlerKind | null {
  if (!category) return null;
  const c = category.toLowerCase();
  if (c === 'uncategorized' || c === '') return null;
  const tokens = c.split(/[^a-z0-9]+/).filter(Boolean);
  if (tokens.includes('seo') || c.includes('optimization') || c.includes('optimisation')) return 'seo';
  if (tokens.some((t) => t === 'ai' || t === 'llm' || t === 'gpt' || t === 'training' || t === 'assistant' || t === 'agent')) return 'ai';
  if (c.includes('advertis') || c.includes('marketing') || tokens.includes('ads') || tokens.includes('ad')) return 'ads';
  if (c.includes('search')) return 'search';
  return 'other';
}

/** Built-in match only (no directory) — null when the UA names no known engine. */
export function matchEngine(ua: string | null | undefined): CrawlerEngine | null {
  if (!ua) return null;
  const s = ua.toLowerCase();
  for (const e of CRAWLER_ENGINES) {
    for (const p of e.patterns) if (s.indexOf(p) !== -1) return e;
  }
  return null;
}

/**
 * Classify a crawler. `ua` may be null (only the stored category is known —
 * e.g. events recorded before the engine was stamped at ingest).
 *
 * Returns null when neither the UA nor the category identifies a crawler, so
 * callers can use it to tell crawler user agents from browsers (edge data).
 */
export function classifyCrawler(ua: string | null | undefined, botCategory?: string | null): CrawlerMatch | null {
  const builtin = matchEngine(ua);
  const catKind = kindFromCategory(botCategory);
  if (builtin) {
    const kind = builtin.fixedKind ? builtin.kind : (catKind ?? builtin.kind);
    return { engine: builtin.engine, label: builtin.label, kind };
  }
  if (catKind) return { engine: otherEngine(catKind), label: OTHER_LABEL[catKind], kind: catKind };
  return null;
}

/** Engine id → display label/kind, for ids read back from storage. */
export function engineInfo(engine: string): { label: string; kind: CrawlerKind } {
  const e = BY_ID.get(engine);
  if (e) return { label: e.label, kind: e.kind };
  const m = engine.match(/^other_(search|ai|ads|seo|other)$/);
  if (m) return { label: OTHER_LABEL[m[1] as CrawlerKind], kind: m[1] as CrawlerKind };
  return { label: engine, kind: 'other' };
}

/**
 * Kind for an engine id read back from storage, re-applying the same
 * precedence as classifyCrawler (the stored bot_category wins unless the
 * built-in engine's kind is fixed). Used where the engine was stamped at
 * ingest but the kind was not.
 */
export function kindForEngine(engine: string, botCategory?: string | null): CrawlerKind {
  const e = BY_ID.get(engine);
  if (e) return e.fixedKind ? e.kind : (kindFromCategory(botCategory) ?? e.kind);
  return engineInfo(engine).kind;
}
