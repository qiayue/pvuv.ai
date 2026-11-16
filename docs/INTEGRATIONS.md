# External integrations: AdSense, Search Console, Adsterra, ads.txt

The portfolio overview can show each site's **ad revenue, RPM, AdSense status,
ads.txt status and Google Search data** next to pvuv's own traffic numbers, and
raise alerts such as "traffic but no revenue". All of it is optional and
read-only. The pieces are:

| Source | Credential | What is pulled |
|---|---|---|
| Google AdSense | Google OAuth (`adsense.readonly`) | earnings (USD + account currency), impressions, clicks, page views per domain per day; site state; policy issues; account alerts |
| Google Search Console | the same Google grant (`webmasters.readonly`) | clicks, impressions, average position per day; pages with impressions in 28 days; homepage index status (URL Inspection) |
| Adsterra | Publisher API token | impressions, clicks, revenue per domain per day; domain list |
| ads.txt | none | each monetized site's `/ads.txt`, checked for a `DIRECT` line with your AdSense publisher id |

The console page is **Integrations** (`/integrations.html`).

---

## 1. Setup

### 1.1 Google (AdSense + Search Console)

1. In [Google Cloud Console](https://console.cloud.google.com/) pick the project
   that holds your console login client, or create one.
2. **APIs & Services → Library**: enable **AdSense Management API** and
   **Google Search Console API**.
3. **OAuth consent screen**: add the scopes
   `https://www.googleapis.com/auth/adsense.readonly` and
   `https://www.googleapis.com/auth/webmasters.readonly`.
   Set the publishing status to **In production**. While an External app is in
   **Testing**, Google expires its refresh tokens after **7 days**, and syncing
   stops with `invalid_grant` until you reconnect. Read-only scopes on your own
   account do not need Google verification for personal use; the consent
   screen only shows an "unverified app" warning.
4. **Credentials → OAuth client (Web application)**: add the authorized
   redirect URI `https://<your-console-domain>/api/integrations/google/callback`.
   You can reuse the login client: add the URI next to the login callback.
   Or create a dedicated client (step 5).
5. Give the client to **both** the console and the cron worker:

   ```bash
   # reuse the login client (GOOGLE_CLIENT_ID is already a [vars] entry on the console)
   wrangler secret put GOOGLE_CLIENT_SECRET -c workers/cron/wrangler.toml
   #   …and add GOOGLE_CLIENT_ID = "…" under [vars] in workers/cron/wrangler.toml

   # OR a dedicated integrations client (wins over the login client when set)
   #   EXT_GOOGLE_CLIENT_ID = "…"  under [vars] of workers/console AND workers/cron
   wrangler secret put EXT_GOOGLE_CLIENT_SECRET -c workers/console/wrangler.toml
   wrangler secret put EXT_GOOGLE_CLIENT_SECRET -c workers/cron/wrangler.toml
   ```

6. The cron worker also needs **`HMAC_KEY`**, the same value as the console's,
   because it decrypts the stored credentials:

   ```bash
   wrangler secret put HMAC_KEY -c workers/cron/wrangler.toml
   ```

7. Apply migration `0028_external_integrations.sql`
   (`npm run db:migrate:remote`) and redeploy the console and cron workers.
8. Console → Integrations → **Connect Google** and grant access with the Google
   account that owns AdSense and Search Console.

### 1.2 Adsterra

Publisher dashboard → **Profile → API** → generate a token, then paste it on the
Integrations page. The console checks it once against `GET /publisher/domains.json`
before storing it. Adsterra tokens expire after a year. When yours expires, the
sync status shows `401`; paste a new token.

### 1.3 ads.txt

No setup is needed. A site is checked when it has an AdSense ad client
(`sites.adclient`, e.g. from a template) or is mapped to a property of the
connected AdSense account.

---

## 2. How sites are matched

Properties are mapped to pvuv sites **by domain**:

- Domains match case-insensitively. Scheme, port, path and a trailing dot are
  ignored, and `www.` is dropped on both sides.
- A Search Console **Domain property** (`sc-domain:example.com`) also covers
  subdomains. It maps to the site that owns `example.com`. If no site owns
  that domain, it maps to the **one** site that owns a subdomain of it. When
  several sites own subdomains, the property stays unmapped, because its data
  cannot be split between them.
- When several Search Console properties cover the same site (Domain +
  URL-prefix, http + https, www + apex), their data overlaps. Only the
  preferred one is synced, in this order: Domain, https apex, https www, http.
  The others are marked `duplicate`.
- An AdSense report row for `www.example.com` and one for `example.com` are
  added together into the `example.com` property.
- Anything unmatched is listed as **Unmapped** on the Integrations page. Choose
  a site to map it manually, or **Ignore** it. Manual choices survive every
  sync, and choosing **Auto** returns the property to domain matching.

---

## 3. Sync schedule, quotas and failures

The cron worker runs the sync after its existing jobs. It never makes them fail.

| Run | Work |
|---|---|
| daily (`30 3 * * *`) | list properties and re-map; revenue for the last 7 days (28 on the first run); AdSense policy issues and alerts; Search Console and ads.txt for every property not refreshed in 20 h |
| hourly (`5 * * * *`) | revenue for yesterday and today; continues the Search Console / ads.txt rotation within a small call budget |
| **Sync now** (console) | the daily work for one source or all, ignoring backoff |

Search Console costs 3 calls per property: daily data, pages, and homepage
inspection. The stalest properties go first, within a per-run budget, so 500
sites are spread over several hourly runs instead of one burst.

- Each source runs in isolation. One failing property records its error on that
  property, and the rest continue.
- Quota errors (HTTP 429, `RESOURCE_EXHAUSTED`, `rateLimitExceeded`) back off
  the source for 1 h, 2 h, 4 h … up to 24 h.
- A revoked or expired Google grant (`invalid_grant`) shows on both Google
  sources. Click **Reconnect**.
- Every write is an idempotent upsert keyed by (source, property, day), so
  re-running a pass or re-pulling a day just replaces its figures.

Published limits:
- **AdSense**: 10,000 requests/day, 100/min per user. A run makes 3–6 calls.
- **Search Console**: Search Analytics allows 1,200/min per site.
- **URL Inspection**: 2,000/day and 600/min per property. pvuv inspects one URL
  per property per day.
- **Adsterra**: 1,200/min, at most 5 concurrent stats requests.

---

## 4. Metrics and alerts

| Field | Meaning |
|---|---|
| `revenue_usd` | AdSense + Adsterra earnings in the period (USD). AdSense also stores the account-currency figure. Adsterra reports USD |
| `rpm_usd` | revenue per 1,000 **clean pageviews measured by pvuv**, so it is comparable across networks and not inflated by invalid traffic |
| `adsense.status` | AdSense site state: `ready`, `getting_ready`, `requires_review`, `needs_attention` |
| `adsense.ads_txt` | `ok`, `missing` (no file, HTML page, or no google.com line), `mismatch` (google.com lines, but none `DIRECT` with your pub id), `error` (fetch failed) |
| `adsterra.status` | `active` (impressions in the period) or `no_impressions`. The API exposes no approval status |
| `search.indexed_pages` | pages with ≥ 1 Google impression in the last 28 days. This is a **lower bound** of indexed pages (see §5) |
| `search.home_verdict` | URL Inspection verdict for the homepage (`PASS` / `NEUTRAL` / `FAIL` …) |

Attention codes (merged into the portfolio's attention queue):

| Code | Severity | When |
|---|---|---|
| `traffic_no_revenue` | high | an ad network is connected, the period spans more than one day, the site has ≥ N clean visitors (default 200, set on the Integrations page) and earns < $0.01 |
| `adsense_needs_attention` | high | AdSense state `needs_attention`, or a policy issue (warned / restricted / click confirmation) |
| `network_declined` | critical | an AdSense policy issue with action `AD_SERVING_DISABLED` |
| `ads_txt_problem` | high | ads.txt `missing` or `mismatch` |
| `external_stale` | normal | a source the site depends on has had no successful sync for > 48 h |

Days are each network's reporting day: the AdSense account time zone, Pacific
time for Search Console, and Adsterra's own day. They are compared with the
period's site-local dates as-is.

English UI strings for the codes (the `attn.<code>` keys in `i18n.js`):
`{uv} clean visitors but no ad revenue`, `AdSense needs attention ({domain})`,
`ads.txt problem: {status}`, `Ads disabled by {network}`,
`{source} data not updated for {hours} h`.

---

## 5. What the APIs do not provide

- **AdSense**: no ads.txt status (pvuv checks the file itself), no approval
  reason beyond the `state` value, and policy issues only for the last 7 days.
- **Search Console**: no total of indexed / not-indexed pages, and no reasons
  from the Page indexing report. Sitemap `indexed` counts are deprecated. Only
  per-URL inspection exists (2,000/day per property), which pvuv uses for the
  homepage. Data for the last 2–3 days is still provisional; pvuv requests
  `dataState=all` and re-pulls those days.
- **Adsterra**: no website approval or moderation status, no currency field
  (USD assumed), and no time zone.

Official references:
[AdSense reports.generate](https://developers.google.com/adsense/management/reference/rest/v2/accounts.reports/generate),
[sites](https://developers.google.com/adsense/management/reference/rest/v2/accounts.sites),
[policyIssues](https://developers.google.com/adsense/management/reference/rest/v2/accounts.policyIssues),
[AdSense limits](https://developers.google.com/adsense/management/appendix/limits),
[Search Analytics query](https://developers.google.com/webmaster-tools/v1/searchanalytics/query),
[URL Inspection](https://developers.google.com/webmaster-tools/v1/urlInspection.index/inspect),
[Search Console limits](https://developers.google.com/webmaster-tools/limits),
[OAuth for web servers](https://developers.google.com/identity/protocols/oauth2/web-server),
[Adsterra Publisher API](https://docs.adsterratools.com/public/v3/publishers-api/).

---

## 6. Privacy and security

- **Credentials** are the Google refresh token and the Adsterra token. They are
  encrypted with AES-256-GCM before they reach D1, with a key derived from
  `HMAC_KEY` (HKDF-SHA-256, purpose-bound). Each value is also bound to its
  provider name, so one stored value cannot be used as another provider's
  credential.
- Credentials are never returned to the browser or written to logs. The API
  shows only the Google account email and a token hint (first 4 and last 2
  characters).
- Rotating `HMAC_KEY` makes stored credentials undecryptable. Reconnect after a
  rotation.
- **Disconnect** revokes the Google grant at Google (best effort) and deletes
  the stored credential. Data already pulled stays, for history.
- The Google OAuth flow uses a signed, expiring state value that is bound to
  the signed-in user and to an HttpOnly cookie (double submit), which blocks
  CSRF and login mix-up.
- Only aggregates are pulled: per-domain daily totals, page counts, and one
  homepage index status. No visitor-level data leaves or enters pvuv through
  these integrations.
- Outbound calls go only to the official API hosts and to your own sites'
  `/ads.txt`.

---

## 7. Data model (migration 0028)

| Table | Contents |
|---|---|
| `ext_credentials` | one row per provider (`google`, `adsterra`): ciphertext, account label, scopes |
| `ext_sync_status` | per source: last run, last success, last error, consecutive errors, backoff, run stats |
| `ext_properties` | AdSense sites, Search Console properties, Adsterra domains, ads.txt hosts; mapping (`auto` / `manual` / `ignored`), state, per-property error, `checked_at` |
| `ext_daily` | (source, property, day): impressions, clicks, page views, revenue + currency, revenue_usd, position; `site_id` copied from the mapping |

Read API: `GET /v1/sites/{id}/external` and the console's
`GET /api/sites/{id}/external` (see [API.md](./API.md#external-data-ad-revenue-adsense-adsterra-search-console)),
plus the `external` field of every site in `/api/portfolio`.
