/**
 * Referrer-domain canonicalisation. A single platform arrives under many
 * hosts — www.google.com / google.com.hk / android-app://…googlequicksearchbox,
 * l.facebook.com / m.facebook.com, t.co — and each one used to become its own
 * "source" row. Applied at ingest (enrich) so sessions.source and every
 * breakdown group naturally; the console mirrors the map for display of
 * pre-existing rows (public/site.html SOURCE_LABEL).
 */

const HOST_CANON: ReadonlyArray<[RegExp, string]> = [
  [/(^|\.)google\.[a-z.]+$/, 'google.com'],
  [/^com\.google\.android\.googlequicksearchbox$/, 'google.com'],
  [/^com\.google\.android\.gm$/, 'mail.google.com'],
  [/(^|\.)bing\.com$/, 'bing.com'],
  [/(^|\.)yahoo\.[a-z.]+$/, 'yahoo.com'],
  [/(^|\.)duckduckgo\.com$/, 'duckduckgo.com'],
  [/(^|\.)yandex\.[a-z.]+$/, 'yandex.com'],
  [/(^|\.)baidu\.com$/, 'baidu.com'],
  [/(^|\.)ecosia\.org$/, 'ecosia.org'],
  [/^t\.co$/, 'x.com'],
  [/(^|\.)twitter\.com$/, 'x.com'],
  [/(^|\.)x\.com$/, 'x.com'],
  [/(^|\.)facebook\.com$/, 'facebook.com'],
  [/^fb\.com$/, 'facebook.com'],
  [/(^|\.)instagram\.com$/, 'instagram.com'],
  [/(^|\.)linkedin\.com$/, 'linkedin.com'],
  [/^lnkd\.in$/, 'linkedin.com'],
  [/(^|\.)reddit\.com$/, 'reddit.com'],
  [/(^|\.)youtube\.com$/, 'youtube.com'],
  [/^youtu\.be$/, 'youtube.com'],
  [/(^|\.)pinterest\.[a-z.]+$/, 'pinterest.com'],
  [/(^|\.)chatgpt\.com$/, 'chatgpt.com'],
  [/^chat\.openai\.com$/, 'chatgpt.com'],
  [/(^|\.)perplexity\.ai$/, 'perplexity.ai'],
  [/(^|\.)bilibili\.com$/, 'bilibili.com'],
  [/^b23\.tv$/, 'bilibili.com'],
  [/(^|\.)weibo\.(com|cn)$/, 'weibo.com'],
  [/(^|\.)zhihu\.com$/, 'zhihu.com'],
  [/^t\.me$/, 'telegram.org'],
];

/** Lower-cases, strips the mobile/link-shim prefixes (www. m. l. lm. amp.)
 *  and folds known platforms onto one host. Unknown hosts keep their
 *  subdomain (blog.example.com ≠ example.com is real information). */
export function canonicalSource(host: string | null | undefined): string | null {
  if (!host) return null;
  let h = host.toLowerCase().replace(/^(www|m|l|lm|amp|mobile)\./, '');
  for (const [re, canon] of HOST_CANON) if (re.test(h)) { h = canon; break; }
  return h || null;
}
