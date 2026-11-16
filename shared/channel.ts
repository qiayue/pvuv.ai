/**
 * Traffic-channel classification (GA4/PostHog-style "default channel group"),
 * computed once per session from its first event's attribution fields and
 * stored on sessions.channel — so the dashboard can answer "what KIND of
 * traffic is this" (Organic Search / Paid Search / AI / …) instead of only
 * listing referrer domains.
 *
 * Session-level and write-time by design: the inputs (utm, click id, referrer
 * domain) are already session attribution, and a stored value keeps the
 * breakdown a plain GROUP BY. The SQL backfill in migrations/0016 mirrors
 * these rules for pre-existing sessions; keep the two roughly in sync when
 * editing the domain lists.
 */

export const CHANNELS = [
  'direct', 'organic_search', 'paid_search', 'organic_social', 'paid_social',
  'email', 'ai', 'video', 'referral',
] as const;
export type Channel = (typeof CHANNELS)[number];

// Referrer-domain suffix lists. Matching is "host equals or ends with .suffix",
// so 'google.com' covers www./news./maps. subdomains but NOT accounts.google.com
// being excluded — that's fine: any google.* referral is search-ish in practice.
const SEARCH_DOMAINS = [
  'google.com', 'google.com.hk', 'google.co.jp', 'google.co.uk', 'google.de', 'google.fr',
  'bing.com', 'baidu.com', 'duckduckgo.com', 'yandex.com', 'yandex.ru', 'yahoo.com',
  'sogou.com', 'so.com', 'sm.cn', 'naver.com', 'daum.net', 'ecosia.org', 'brave.com',
  'startpage.com', 'qwant.com', 'seznam.cz', 'coccoc.com',
];
const SOCIAL_DOMAINS = [
  'facebook.com', 'fb.com', 'instagram.com', 'twitter.com', 'x.com', 't.co',
  'linkedin.com', 'lnkd.in', 'reddit.com', 'pinterest.com', 'threads.net', 'tiktok.com',
  'douyin.com', 'weibo.com', 'weibo.cn', 'zhihu.com', 'xiaohongshu.com', 'okjike.com',
  'discord.com', 'discord.gg', 'telegram.org', 't.me', 'whatsapp.com', 'wechat.com',
  'v2ex.com', 'juejin.cn', 'news.ycombinator.com', 'ycombinator.com', 'quora.com',
  'mastodon.social', 'bsky.app', 'nextdoor.com',
];
const VIDEO_DOMAINS = [
  'youtube.com', 'youtu.be', 'bilibili.com', 'b23.tv', 'vimeo.com', 'twitch.tv',
];
// AI assistants/answer engines — a channel classic analytics tools don't have,
// and increasingly where content sites get discovered. One entry per assistant
// so the ai_referrals report can name WHICH assistant sent a visit; the
// channel's domain list is derived from it, so the two never drift.
export const AI_ASSISTANTS: ReadonlyArray<{ id: string; label: string; domains: readonly string[] }> = [
  { id: 'chatgpt', label: 'ChatGPT', domains: ['chatgpt.com', 'chat.openai.com', 'openai.com'] },
  { id: 'perplexity', label: 'Perplexity', domains: ['perplexity.ai'] },
  { id: 'claude', label: 'Claude', domains: ['claude.ai'] },
  { id: 'gemini', label: 'Gemini', domains: ['gemini.google.com', 'bard.google.com'] },
  { id: 'copilot', label: 'Microsoft Copilot', domains: ['copilot.microsoft.com'] },
  { id: 'poe', label: 'Poe', domains: ['poe.com'] },
  { id: 'you', label: 'You.com', domains: ['you.com'] },
  { id: 'phind', label: 'Phind', domains: ['phind.com'] },
  { id: 'deepseek', label: 'DeepSeek', domains: ['deepseek.com'] },
  { id: 'kimi', label: 'Kimi', domains: ['kimi.com', 'kimi.moonshot.cn'] },
  { id: 'doubao', label: 'Doubao', domains: ['doubao.com'] },
  { id: 'tongyi', label: 'Tongyi Qianwen', domains: ['tongyi.aliyun.com', 'qianwen.aliyun.com', 'tongyi.com'] },
  { id: 'yiyan', label: 'ERNIE Bot (Yiyan)', domains: ['yiyan.baidu.com'] },
  { id: 'yuanbao', label: 'Tencent Yuanbao', domains: ['yuanbao.tencent.com'] },
  { id: 'metaso', label: 'Metaso', domains: ['metaso.cn'] },
  { id: 'felo', label: 'Felo', domains: ['felo.ai'] },
  { id: 'mistral', label: 'Mistral Le Chat', domains: ['mistral.ai'] },
  { id: 'grok', label: 'Grok', domains: ['grok.com'] },
];
const AI_DOMAINS = AI_ASSISTANTS.flatMap((a) => a.domains);

const PAID_MEDIUMS = new Set(['cpc', 'ppc', 'sem', 'paid', 'cpm', 'cpv', 'cpa', 'display', 'banner', 'retargeting', 'paid_social', 'paidsocial']);
const EMAIL_MEDIUMS = new Set(['email', 'e-mail', 'newsletter', 'mail']);
// click-id → ad platform family (server already extracts these into click_id_type)
const SEARCH_CLICK_IDS = new Set(['gclid', 'msclkid']);
const SOCIAL_CLICK_IDS = new Set(['fbclid', 'ttclid']);

function inList(host: string, list: readonly string[]): boolean {
  return list.some((d) => host === d || host.endsWith('.' + d));
}

/** Does a bare utm_source value (not a domain) name a known platform? Covers
 *  hand-written tags like utm_source=facebook / twitter / google. */
function sourceNames(source: string, list: readonly string[]): boolean {
  const s = source.toLowerCase();
  return list.some((d) => d === s || d.startsWith(s + '.'));
}

export function classifyChannel(input: {
  refDomain: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  clickIdType: string | null;
}): Channel {
  const ref = (input.refDomain ?? '').toLowerCase();
  const src = (input.utmSource ?? '').trim();
  const medium = (input.utmMedium ?? '').trim().toLowerCase();
  const click = (input.clickIdType ?? '').toLowerCase();

  // 1. explicit ad click ids beat everything (they only exist on paid clicks)
  if (SEARCH_CLICK_IDS.has(click)) return 'paid_search';
  if (SOCIAL_CLICK_IDS.has(click)) return 'paid_social';

  // 2. paid medium: split search vs social by where the click came from
  if (PAID_MEDIUMS.has(medium)) {
    if (inList(ref, SOCIAL_DOMAINS) || sourceNames(src, SOCIAL_DOMAINS)) return 'paid_social';
    return 'paid_search';
  }
  if (EMAIL_MEDIUMS.has(medium) || /newsletter|^e?mail$/i.test(src)) return 'email';

  // 3. referrer-domain families (utm_source naming a platform counts too)
  if (inList(ref, AI_DOMAINS) || sourceNames(src, AI_DOMAINS)) return 'ai';
  if (inList(ref, SEARCH_DOMAINS) || sourceNames(src, SEARCH_DOMAINS)) return 'organic_search';
  if (inList(ref, VIDEO_DOMAINS) || sourceNames(src, VIDEO_DOMAINS)) return 'video';
  if (inList(ref, SOCIAL_DOMAINS) || sourceNames(src, SOCIAL_DOMAINS)) return 'organic_social';

  // 4. anything else with an attribution → referral; nothing at all → direct
  if (ref || src) return 'referral';
  return 'direct';
}

/** Which AI assistant a stored session source (a canonical referrer host, or a
 *  utm_source such as `chatgpt.com` / `chatgpt`) names, or null. Same matching
 *  rules as the channel classifier, so every session it names is in the 'ai'
 *  channel. */
export function aiAssistantOf(source: string | null | undefined): string | null {
  const s = (source ?? '').trim().toLowerCase();
  if (!s) return null;
  for (const a of AI_ASSISTANTS) if (inList(s, a.domains) || sourceNames(s, a.domains)) return a.id;
  return null;
}

/** SQL predicate that PRE-FILTERS stored session sources (a referrer host or a
 *  utm_source) down to those that may be organic search or an AI assistant, so
 *  batched rollup reads (the portfolio overview) don't ship every long-tail
 *  referrer back. Deliberately a superset: the caller still runs
 *  classifyChannel on what comes back. Only constant domain literals are
 *  inlined — never user input. */
export function searchOrAiSourceSql(col: string): string {
  const domains = [...SEARCH_DOMAINS, ...AI_DOMAINS];
  const bare = new Set(domains.map((d) => d.split('.')[0]));
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const exact = [...domains, ...bare].map(q).join(',');
  const suffix = domains.map((d) => `${col} LIKE ${q('%.' + d)}`).join(' OR ');
  return `(${col} IN (${exact}) OR ${suffix})`;
}
