/**
 * External per-site data (ad revenue, ad-network status, search-console
 * figures) merged into the portfolio overview — docs/design/portfolio-ui.md
 * §3.3. This file is a STUB: the integrations stream replaces the body of
 * loadExternal, keeping its signature and the exported types.
 */
import type { Period } from './queries';

export type AttentionSeverity = 'critical' | 'high' | 'normal';
export interface Attention {
  code: string;
  severity: AttentionSeverity;
  params?: Record<string, unknown>;
}

export interface ExternalSite {
  revenue_usd: number | null;
  revenue_prev_usd: number | null;
  rpm_usd: number | null;
  adsense: { status: string; ads_txt: string | null; checked_at: number } | null;
  adsterra: { status: string; checked_at: number } | null;
  search: { indexed_pages: number | null; impressions: number | null; clicks: number | null; checked_at: number } | null;
  attention: Attention[];
}

/** External data for `siteIds` over `period`, keyed by site id. Sites without
 *  any connected integration are simply absent. */
export async function loadExternal(
  db: D1Database, siteIds: string[], period: Period,
): Promise<Record<string, ExternalSite>> {
  void db; void siteIds; void period;
  return {};
}
