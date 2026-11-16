/**
 * Map external properties (AdSense sites, Search Console properties, Adsterra
 * domains) to pvuv sites by domain.
 *
 * Rules (documented in docs/INTEGRATIONS.md):
 *   - hostnames compare case-insensitively, without scheme/port/path/trailing
 *     dot, and `www.` is ignored on both sides (www.example.com ≡ example.com);
 *   - an exact host match wins;
 *   - a Search Console Domain property (`sc-domain:example.com`) also covers
 *     subdomains — it maps to the site owning example.com, or, if no site owns
 *     the apex, to the ONE site owning a subdomain of it (several → unmapped,
 *     because the property's data cannot be split between them);
 *   - a property whose host belongs to no active site stays unmapped and is
 *     listed in the console for a manual override.
 */

export interface SiteDomains {
  site_id: string;
  domains: string[];
}

/** Normalize anything host-like ('https://WWW.Example.com:443/x', 'example.com.') to 'example.com'. */
export function normalizeHost(raw: string | null | undefined): string {
  let s = String(raw ?? '').trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^sc-domain:/, '');
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  s = s.replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/\.$/, '');
  return s.replace(/^www\./, '');
}

/** Host part of a Search Console property, plus whether it is a Domain property. */
export function gscPropertyHost(siteUrl: string): { host: string; domainProperty: boolean } {
  return { host: normalizeHost(siteUrl), domainProperty: /^sc-domain:/i.test(siteUrl) };
}

export interface DomainIndex {
  /** normalized host → site_id (first site wins if two list the same host) */
  exact: Map<string, string>;
  all: Array<{ host: string; site_id: string }>;
}

export function buildDomainIndex(sites: SiteDomains[]): DomainIndex {
  const exact = new Map<string, string>();
  const all: Array<{ host: string; site_id: string }> = [];
  for (const s of sites) {
    for (const d of s.domains) {
      const h = normalizeHost(d);
      if (!h) continue;
      if (!exact.has(h)) exact.set(h, s.site_id);
      all.push({ host: h, site_id: s.site_id });
    }
  }
  return { exact, all };
}

/** Site for a host-like property, or null. `coversSubdomains` for sc-domain: properties. */
export function matchSite(index: DomainIndex, rawHost: string, coversSubdomains = false): string | null {
  const host = normalizeHost(rawHost);
  if (!host) return null;
  const hit = index.exact.get(host);
  if (hit) return hit;
  if (!coversSubdomains) return null;
  const suffix = '.' + host;
  const owners = new Set(index.all.filter((e) => e.host.endsWith(suffix)).map((e) => e.site_id));
  return owners.size === 1 ? [...owners][0] : null;
}

/** Search Console: a site may be covered by several properties (Domain + URL-prefix,
 *  http + https, www + apex). Their data overlaps, so exactly one is synced per
 *  site: Domain property first, then https, then the apex host. Lower = preferred. */
export function gscPreference(siteUrl: string): number {
  if (/^sc-domain:/i.test(siteUrl)) return 0;
  const https = /^https:/i.test(siteUrl);
  const www = /^[a-z]+:\/\/www\./i.test(siteUrl);
  return 1 + (https ? 0 : 2) + (www ? 1 : 0);
}

/** Parse a stored allowed_domains JSON column. */
export function parseDomains(raw: string | null | undefined): string[] {
  try {
    const v = JSON.parse(raw ?? '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
