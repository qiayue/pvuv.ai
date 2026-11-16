/**
 * Adsterra Publisher API client (https://api3.adsterratools.com/publisher,
 * header `X-API-Key`; OpenAPI spec: docs.adsterratools.com/docs/public/v3/publishers-api.yml).
 *
 * Endpoints used:
 *   GET /domains.json                       → {items:[{id,title}]}
 *   GET /stats.json?start_date&finish_date&group_by[]=date&group_by[]=domain
 *                                           → {items:[{date,domain(id),impression,clicks,ctr,cpm,revenue}]}
 *
 * Not available via the API: domain approval/moderation status, currency
 * (the publisher dashboard reports USD; stored as USD), report time zone.
 */

import { errorFromResponse, type FetchFn } from './google';

export const ADSTERRA_BASE = 'https://api3.adsterratools.com/publisher';

export interface AdsterraDomain { id: number; title: string }
export interface AdsterraStatRow { day: string; domain_id: string; impressions: number; clicks: number; revenue: number }

async function get<T>(fetchFn: FetchFn, token: string, path: string, what: string): Promise<T> {
  const r = await fetchFn(`${ADSTERRA_BASE}${path}`, { headers: { 'X-API-Key': token, accept: 'application/json' } });
  if (!r.ok) throw await errorFromResponse(r, what);
  return await r.json() as T;
}

export async function adsterraDomains(fetchFn: FetchFn, token: string): Promise<AdsterraDomain[]> {
  const j = await get<{ items?: AdsterraDomain[] }>(fetchFn, token, '/domains.json', 'adsterra domains');
  return (j.items ?? []).filter((d) => d && d.id != null);
}

export async function adsterraStats(fetchFn: FetchFn, token: string, start: string, end: string): Promise<AdsterraStatRow[]> {
  const p = new URLSearchParams({ start_date: start, finish_date: end });
  p.append('group_by[]', 'date');
  p.append('group_by[]', 'domain');
  const j = await get<{ items?: Array<Record<string, unknown>> }>(fetchFn, token, `/stats.json?${p.toString()}`, 'adsterra stats');
  const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const out: AdsterraStatRow[] = [];
  for (const it of j.items ?? []) {
    const day = String(it.date ?? '').slice(0, 10);
    const dom = it.domain;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || dom == null || dom === '') continue;
    out.push({ day, domain_id: String(dom), impressions: num(it.impression ?? it.impressions), clicks: num(it.clicks), revenue: num(it.revenue) });
  }
  return out;
}
