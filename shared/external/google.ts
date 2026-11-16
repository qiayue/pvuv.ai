/**
 * Google OAuth 2.0 + AdSense Management API v2 + Search Console API clients.
 *
 * Every call goes through an injected `fetch`, so tests run against recorded
 * fixtures and nothing needs live credentials. Errors are thrown as ExtError
 * with a classification the sync uses for backoff / re-auth decisions.
 *
 * References (see docs/INTEGRATIONS.md for the full list):
 *   https://developers.google.com/identity/protocols/oauth2/web-server
 *   https://developers.google.com/adsense/management/reference/rest
 *   https://developers.google.com/webmaster-tools/v1/api_reference_index
 */

export type FetchFn = typeof fetch;

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
export const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
export const ADSENSE_BASE = 'https://adsense.googleapis.com/v2';
export const GSC_BASE = 'https://www.googleapis.com/webmasters/v3';
export const URL_INSPECTION_URL = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect';

export const SCOPE_ADSENSE = 'https://www.googleapis.com/auth/adsense.readonly';
export const SCOPE_GSC = 'https://www.googleapis.com/auth/webmasters.readonly';
export const GOOGLE_SCOPES = ['openid', 'email', SCOPE_ADSENSE, SCOPE_GSC];

/** quota = rate/quota exhausted (back off); auth = credential revoked/expired
 *  (owner must reconnect); denied = API not enabled / no access; other. */
export type ExtErrorKind = 'quota' | 'auth' | 'denied' | 'not_found' | 'other';

export class ExtError extends Error {
  constructor(public kind: ExtErrorKind, message: string, public status = 0) { super(message); }
}

/** Classify a failed HTTP response from any of the providers. */
export async function errorFromResponse(r: Response, what: string): Promise<ExtError> {
  let text = '';
  try { text = (await r.text()).slice(0, 2000); } catch { /* body unreadable */ }
  let msg = text;
  let reason = '';
  try {
    const j = JSON.parse(text);
    const e = j?.error;
    if (typeof e === 'string') { reason = e; msg = j.error_description || e; }
    else if (e) {
      msg = e.message || msg;
      reason = e.status || e.errors?.[0]?.reason || '';
    } else if (j?.message) msg = j.message;
  } catch { /* not JSON */ }
  msg = `${what}: ${String(msg || r.statusText || 'HTTP ' + r.status).slice(0, 300)}`;
  const quota = r.status === 429 || /RESOURCE_EXHAUSTED|rateLimitExceeded|quotaExceeded|userRateLimitExceeded/i.test(reason + ' ' + text);
  if (quota) return new ExtError('quota', msg, r.status);
  if (r.status === 401 || reason === 'invalid_grant' || reason === 'UNAUTHENTICATED') return new ExtError('auth', msg, r.status);
  if (r.status === 403) return new ExtError('denied', msg, r.status);
  if (r.status === 404) return new ExtError('not_found', msg, r.status);
  return new ExtError('other', msg, r.status);
}

async function getJson<T>(fetchFn: FetchFn, url: string, token: string, what: string, init: RequestInit = {}): Promise<T> {
  const r = await fetchFn(url, {
    ...init,
    headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}) },
  });
  if (!r.ok) throw await errorFromResponse(r, what);
  return await r.json() as T;
}

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

export interface GoogleClient { clientId: string; clientSecret: string }

export function googleAuthUrl(client: GoogleClient, redirectUri: string, state: string): string {
  const p = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    state,
    // a refresh token is only issued with offline access, and only re-issued
    // on a fresh consent — reconnecting must always yield a new one
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
  });
  return `${GOOGLE_AUTH_URL}?${p.toString()}`;
}

export interface GoogleTokens { access_token: string; refresh_token?: string; scope?: string; expires_in?: number }

export async function exchangeGoogleCode(fetchFn: FetchFn, client: GoogleClient, code: string, redirectUri: string): Promise<GoogleTokens> {
  const r = await fetchFn(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      client_id: client.clientId, client_secret: client.clientSecret, code,
      redirect_uri: redirectUri, grant_type: 'authorization_code',
    }).toString(),
  });
  if (!r.ok) throw await errorFromResponse(r, 'token exchange');
  const j = await r.json() as GoogleTokens;
  if (!j.access_token) throw new ExtError('auth', 'token exchange: no access_token');
  return j;
}

export async function refreshGoogleToken(fetchFn: FetchFn, client: GoogleClient, refreshToken: string): Promise<string> {
  const r = await fetchFn(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      client_id: client.clientId, client_secret: client.clientSecret,
      refresh_token: refreshToken, grant_type: 'refresh_token',
    }).toString(),
  });
  if (!r.ok) {
    const e = await errorFromResponse(r, 'token refresh');
    // invalid_grant = revoked, expired (7-day limit for apps in "Testing"), or password change
    if (r.status === 400 && /invalid_grant/i.test(e.message)) throw new ExtError('auth', e.message, r.status);
    throw e;
  }
  const j = await r.json() as GoogleTokens;
  if (!j.access_token) throw new ExtError('auth', 'token refresh: no access_token');
  return j.access_token;
}

export async function googleEmail(fetchFn: FetchFn, accessToken: string): Promise<string | null> {
  try {
    const j = await getJson<{ email?: string }>(fetchFn, GOOGLE_USERINFO_URL, accessToken, 'userinfo');
    return j.email ?? null;
  } catch {
    return null;
  }
}

export async function revokeGoogleToken(fetchFn: FetchFn, token: string): Promise<void> {
  try {
    await fetchFn(GOOGLE_REVOKE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
    });
  } catch { /* best effort: the row is deleted regardless */ }
}

// ---------------------------------------------------------------------------
// AdSense Management API v2
// ---------------------------------------------------------------------------

export interface AdsenseAccount { name: string; displayName?: string; timeZone?: { id?: string } }
export interface AdsenseSite { name: string; domain: string; state?: string; autoAdsEnabled?: boolean; reportingDimensionId?: string }
export interface AdsensePolicyIssue {
  site?: string; siteSection?: string; uri?: string; entityType?: string;
  action?: string; policyTopics?: Array<{ topic?: string; mustFix?: boolean }>;
  lastDetectedDate?: { year: number; month: number; day: number };
}
export interface AdsenseAlert { name?: string; severity?: string; message?: string; type?: string }

export async function adsenseAccounts(fetchFn: FetchFn, token: string): Promise<AdsenseAccount[]> {
  const j = await getJson<{ accounts?: AdsenseAccount[] }>(fetchFn, `${ADSENSE_BASE}/accounts?pageSize=50`, token, 'adsense accounts');
  return j.accounts ?? [];
}

async function paged<T>(fetchFn: FetchFn, base: string, key: string, token: string, what: string, maxPages = 10): Promise<T[]> {
  const out: T[] = [];
  let pageToken = '';
  for (let i = 0; i < maxPages; i++) {
    const sep = base.includes('?') ? '&' : '?';
    const j = await getJson<Record<string, unknown>>(fetchFn, `${base}${sep}pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`, token, what);
    out.push(...((j[key] as T[] | undefined) ?? []));
    pageToken = String(j.nextPageToken ?? '');
    if (!pageToken) break;
  }
  return out;
}

export function adsenseSites(fetchFn: FetchFn, token: string, account: string): Promise<AdsenseSite[]> {
  return paged<AdsenseSite>(fetchFn, `${ADSENSE_BASE}/${account}/sites`, 'sites', token, 'adsense sites');
}

export function adsensePolicyIssues(fetchFn: FetchFn, token: string, account: string): Promise<AdsensePolicyIssue[]> {
  return paged<AdsensePolicyIssue>(fetchFn, `${ADSENSE_BASE}/${account}/policyIssues`, 'policyIssues', token, 'adsense policy issues');
}

export async function adsenseAlerts(fetchFn: FetchFn, token: string, account: string): Promise<AdsenseAlert[]> {
  const j = await getJson<{ alerts?: AdsenseAlert[] }>(fetchFn, `${ADSENSE_BASE}/${account}/alerts`, token, 'adsense alerts');
  return j.alerts ?? [];
}

export interface AdsenseReportRow { day: string; domain: string; earnings: number; impressions: number; clicks: number; pageviews: number }

/** reports.generate by DATE × DOMAIN_NAME. `currency` undefined = account currency. */
export async function adsenseReport(
  fetchFn: FetchFn, token: string, account: string, start: string, end: string, currency?: string,
): Promise<{ currency: string | null; rows: AdsenseReportRow[] }> {
  const [sy, sm, sd] = start.split('-').map(Number);
  const [ey, em, ed] = end.split('-').map(Number);
  const p = new URLSearchParams({
    dateRange: 'CUSTOM',
    'startDate.year': String(sy), 'startDate.month': String(sm), 'startDate.day': String(sd),
    'endDate.year': String(ey), 'endDate.month': String(em), 'endDate.day': String(ed),
    reportingTimeZone: 'ACCOUNT_TIME_ZONE',
  });
  for (const d of ['DATE', 'DOMAIN_NAME']) p.append('dimensions', d);
  for (const m of ['ESTIMATED_EARNINGS', 'IMPRESSIONS', 'CLICKS', 'PAGE_VIEWS']) p.append('metrics', m);
  if (currency) p.set('currencyCode', currency);
  const j = await getJson<{
    headers?: Array<{ name: string; type?: string; currencyCode?: string }>;
    rows?: Array<{ cells: Array<{ value?: string }> }>;
  }>(fetchFn, `${ADSENSE_BASE}/${account}/reports:generate?${p.toString()}`, token, 'adsense report');
  const headers = j.headers ?? [];
  const idx = (n: string) => headers.findIndex((h) => h.name === n);
  const iDate = idx('DATE'), iDom = idx('DOMAIN_NAME'), iEarn = idx('ESTIMATED_EARNINGS');
  const iImp = idx('IMPRESSIONS'), iClk = idx('CLICKS'), iPv = idx('PAGE_VIEWS');
  const num = (v: string | undefined) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const rows: AdsenseReportRow[] = [];
  for (const r of j.rows ?? []) {
    const c = r.cells ?? [];
    const day = c[iDate]?.value ?? '';
    const domain = c[iDom]?.value ?? '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !domain) continue;
    rows.push({ day, domain, earnings: num(c[iEarn]?.value), impressions: num(c[iImp]?.value), clicks: num(c[iClk]?.value), pageviews: num(c[iPv]?.value) });
  }
  return { currency: (iEarn >= 0 ? headers[iEarn].currencyCode : undefined) ?? currency ?? null, rows };
}

// ---------------------------------------------------------------------------
// Search Console
// ---------------------------------------------------------------------------

export interface GscSite { siteUrl: string; permissionLevel: string }

export async function gscSites(fetchFn: FetchFn, token: string): Promise<GscSite[]> {
  const j = await getJson<{ siteEntry?: GscSite[] }>(fetchFn, `${GSC_BASE}/sites`, token, 'search console sites');
  return (j.siteEntry ?? []).filter((s) => s.permissionLevel !== 'siteUnverifiedUser');
}

export interface GscRow { keys?: string[]; clicks: number; impressions: number; ctr?: number; position?: number }

export async function gscQuery(
  fetchFn: FetchFn, token: string, siteUrl: string,
  body: { startDate: string; endDate: string; dimensions: string[]; rowLimit?: number },
): Promise<GscRow[]> {
  const j = await getJson<{ rows?: GscRow[] }>(
    fetchFn, `${GSC_BASE}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`, token, 'search analytics',
    { method: 'POST', body: JSON.stringify({ type: 'web', dataState: 'all', ...body }) },
  );
  return j.rows ?? [];
}

export interface IndexStatus { verdict: string | null; coverageState: string | null; lastCrawlTime: string | null }

export async function inspectUrl(fetchFn: FetchFn, token: string, siteUrl: string, url: string): Promise<IndexStatus> {
  const j = await getJson<{ inspectionResult?: { indexStatusResult?: { verdict?: string; coverageState?: string; lastCrawlTime?: string } } }>(
    fetchFn, URL_INSPECTION_URL, token, 'url inspection',
    { method: 'POST', body: JSON.stringify({ inspectionUrl: url, siteUrl }) },
  );
  const s = j.inspectionResult?.indexStatusResult ?? {};
  return { verdict: s.verdict ?? null, coverageState: s.coverageState ?? null, lastCrawlTime: s.lastCrawlTime ?? null };
}
