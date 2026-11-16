# API, MCP server & CLI

Three ways to read a pvuv.ai deployment programmatically, all sharing one
credential: a personal API token. Tokens are read-only by default; an owner can
explicitly issue a **read/write** token that also lets a trusted integration —
such as a site launcher — create and manage sites ([§6 Site provisioning](#6-site-provisioning-readwrite-tokens)).

- **REST API** — for dashboards, scripts, spreadsheets, anything that speaks HTTP
- **MCP server** — so your own chatbot can answer questions about your traffic
- **CLI** — for a terminal, a cron job or a pipeline

---

## 1. Create a token

Console → **⚙ settings** → **API tokens**. Give it a name (which client is it
for?) and a scope:

| Scope | Sees |
|---|---|
| All my sites | every site you own, including ones added later |
| A single site | only that site |

The token is shown **once**. Only an HMAC of it is stored, so it cannot be
recovered — if you lose it, revoke it and create another. Tokens start with
`pvuv_`, which lets secret scanners recognise one if it is ever committed.

Revoking takes effect immediately. `last used` in the list helps you spot
credentials nothing is using any more.

A token also has a **permission**:

| Permission | Can |
|---|---|
| Read only (default) | query reports for the sites in its scope |
| Read & manage sites | the same, plus create / update / archive sites and funnels — [§6](#6-site-provisioning-readwrite-tokens). All sites only. |

> A token grants read access to the sites in its scope. Treat it like a
> password: it is not a public key, and anything holding it can read your
> analytics — and, for a read/write token, change your sites.

---

## 2. REST API

Base URL: your api worker, e.g. `https://api.example.com`.

```bash
curl -H "Authorization: Bearer pvuv_…" \
  "https://api.example.com/v1/sites"
```

`X-API-Key: pvuv_…` works as an alias where setting an `Authorization` header is
awkward (some no-code and spreadsheet tools).

The api worker also accepts the console's signed session cookie, so a browser
that is signed in to the console can call it directly for that owner's sites.

### Endpoints

| Endpoint | Returns | Parameters |
|---|---|---|
| `GET /v1/sites` | sites this token can read (`site_id`, `name`, `domains`, `timezone`, `created_at`, `first_search_crawl_at`) — **call first**, ids are not guessable | — |
| `GET /v1/templates` | the owner's site templates (see [§6](#6-site-provisioning-readwrite-tokens)) | — |
| `GET /v1/sites/summary` | per-site totals for every site in scope, in one pass (`uv_approx: true` when visitors are summed per day) | `period` |
| `GET /v1/sites/{id}/overview` | pageviews, visitors, sessions, both bounce rates, dwell, visit duration, verdict split, conversions, revenue | `period` `filters` |
| `GET /v1/sites/{id}/realtime` | `{window_minutes, online, pageviews, minutes[]}` for the last 30 min; bot/crawler traffic excluded; always live (ignores `period`) | — |
| `GET /v1/sites/{id}/timeseries` | `{metric, interval, points[]}`; each point carries `label`, `value`, `status` (`complete`/`partial`/`future`), `pv` and `invalid` | `period` `metric` `interval` `filters` |
| `GET /v1/sites/{id}/breakdown` | `{dim, rows[]}` — top values for one dimension | `period` `dim` `limit` (default 20, max 1000) `key` `filters` |
| `GET /v1/sites/{id}/quality` | verdict totals + which detection signals fired | `period` `filters` |
| `GET /v1/sites/{id}/vitals` | Web Vitals (LCP/CLS/INP/FCP/TTFB p75 + ratings, slowest pages) from non-bot traffic | `period` `filters` |
| `GET /v1/sites/{id}/ctit` | conversion timing: time from session start to goal event (`n`, `median_ms`, `fast_share`, `buckets`, `flag`) | `period` |
| `GET /v1/sites/{id}/alerts` | rule checks, their ratios and thresholds (`stats`, `thresholds`, `muted`) | `period` `filters` |
| `GET /v1/sites/{id}/adguard` | per-tier block/false-positive estimates, block reasons | `period` |
| `GET /v1/sites/{id}/edge` | Cloudflare edge requests vs reported pageviews — the traffic that never ran JS | `period` |
| `GET /v1/sites/{id}/crawlers` | crawler / indexing signals per engine (first/last seen, hits, daily series) + top crawled pages — a separate metric, see below | `period` `limit` (top pages, default 20, max 100) `bot` (one engine id, case-insensitive) `search` (truthy → only `kind = search` engines) |
| `GET /v1/sites/{id}/traffic` | individual suspicious visitors with their evidence | `period` `verdict` `min_score` `limit` (default 50, max 1000) `filters` |
| `GET /v1/sites/{id}/anomalies` | the 40 most recent pending baseline anomaly reports (`day`, `dimension`, `baseline`, `actual`, `deviation`, `kind`, `message`, `top_sig`, `unit`); ignores `period` | — |
| `GET /v1/sites/{id}/funnels` | saved funnels: `{funnels:[{funnel_id, name, steps, created_at, updated_at}]}` | — |
| `GET /v1/sites/{id}/funnel` | conversion funnel | `steps` or `funnel_id`, `breakdown`, `period` `filters` |
| `GET /v1/sites/{id}/funnel_dropoff` | the visitors who reached step `step` but not the next one | `steps` or `funnel_id`, `step` (default 0), `limit` (default 50), `period` `filters` |
| `GET /v1/sites/{id}/visitors` | visitor list | `period` `path` `verdict` `limit` (default 50) |
| `GET /v1/sites/{id}/visitors/{vid}/profile` | one visitor's journey | `period` |
| `GET /v1/ranking` | cross-site clean-traffic ranking — **legacy `API_TOKEN` only**, see §5 | `period` (resolved in UTC) `limit` (default 100) |

### Parameters

- `period` — `24h` `today` `yesterday` `Nd` (any number of days 1–730, e.g. `7d`
  `30d` `90d`) `this_week` `last_week` `this_month` `last_month` `this_year`.
  Resolved in the site's own timezone. Default `30d`; an unrecognised value also
  falls back to `30d`.
- `metric` — `pv` `uv` `sessions` `bounce_rate` `bounce_rate_single`
  `avg_duration_ms` `visit_duration_ms` `pv_per_visitor` `clean_count`
  `suspect_count` `bot_count` `crawler_count`. Default `pv`.
- `interval` — `minute` `hour` `day` `week` `month`. Default `day`; with
  `period=24h` a day/week/month interval is forced to `hour`.
- `dim` — `page` `entry_page` `exit_page` `source` `channel` `referrer`
  `country` `region` `city` `browser` `os` `device` `size` `utm_campaign`
  `utm_medium` `utm_term` `utm_content` `ft_source` `ft_medium` `ft_campaign`
  `goal` `bot_category`. Default `page`. (`utm_source` is not a dimension — use
  `source`.)
- `key` — with `dim=referrer`, the source whose referring URLs to list
  (`(direct)` for none).
- `filters` — JSON array of `{dim, value}` (AND-ed, at most 8). Filterable dims:
  `page` `country` `device` `browser` `os` `region` `city` `source`
  `utm_campaign` `utm_medium` `utm_term` `utm_content` `ft_source` `ft_medium`
  `ft_campaign`; anything else is silently ignored. An optional
  `values: [...]` (up to 20) matches any of several raw values.
- `steps` — JSON array of 2–8 `{type: "page" | "event", value}`, e.g.
  `[{"type":"page","value":"/pricing"},{"type":"event","value":"signup"}]`.
  `funnel_id` (from `/funnels`) uses a saved funnel instead.
- `breakdown` (funnel) — `source` `country` `device` `browser` `os`.
- `verdict` — `clean` `suspect` `bot` `crawler`.
- `min_score` — minimum bot score 0–100 (no default on the API).
- `path` (visitors) — a page path; a trailing `*` matches a prefix (`/pay*`).

Errors are `{"error":"…"}` with a matching status: `400` invalid parameter
(unknown metric/interval/dim, bad funnel, range too large for the interval),
`401` bad/missing token, `403` token or session not valid for that site, `404`
unknown route, site or funnel, `405` any method other than `GET`.

`edge` depends on an optional Cloudflare API token the deployer configures in
the console; without it the endpoint answers `{"available": false}` with zeroed
totals rather than an error. It also covers **completed days only** — today's
edge counts are still accumulating and are deliberately excluded, so `days` can
be shorter than the requested `period`. See
[DEPLOY.md → Cloudflare edge requests](../DEPLOY.md#cloudflare-edge-requests-optional-advanced).

### Crawler / indexing signals

`GET /v1/sites/{id}/crawlers` answers the first question for a newly launched
site: has Googlebot (Bing, …) come yet, how often, and which pages. It is a
**separate metric** — nothing in it counts toward PV/UV, scoring, verdicts or
ad protection, and it reads only its own tables.

```json
{
  "site_id": "3exbuw7w",
  "period": { "start": "2026-10-18", "end": "2026-11-16" },
  "available": true,
  "first_search_crawl_at": 1762905600000,
  "sources": {
    "beacon": { "available": true, "note": "…JS-rendering crawlers only…" },
    "edge":   { "available": false, "note": "…no Cloudflare API token…" },
    "server": { "available": true, "note": "…reported by the site's own server…" }
  },
  "filters": { "bot": null, "search": false },
  "merge": "…hits = max(beacon, edge, server) per engine per day, summed…",
  "engines": [
    {
      "engine": "googlebot", "label": "Googlebot", "kind": "search",
      "first_seen_at": 1762905600000, "first_source": "beacon", "first_path": "/",
      "last_seen_at": 1763251200000,
      "hits": 57, "beacon_hits": 42, "edge_hits": 0, "server_hits": 57,
      "server_error_hits": 3, "server_verified_hits": 0, "pages": 17,
      "days": [ { "day": "2026-11-12", "beacon": 5, "edge": 0, "server": 7 } ]
    }
  ],
  "top_pages": {
    "source": "beacon+server", "note": "Beacon and server-reported pages …",
    "pages": [ { "path": "/", "hits": 9, "engines": { "googlebot": 7, "bingbot": 2 } } ]
  }
}
```

- `engine` — a built-in id: `googlebot`, `bingbot`, `yandex`, `baidu`,
  `applebot`, `duckduckgo`, `sogou`, `so360`, `shenma`, `petal`, `yahoo`,
  `naver`, `seznam`, `google_adsbot` / `google_adsense` / `bing_ads` (kind
  `ads`), AI crawlers (`openai`, `anthropic`, `perplexity`, `bytespider`,
  `commoncrawl`, `meta_ai`, `amazonbot`, …), SEO tools (`ahrefs`, `semrush`, …),
  `social`, `google_inspection` (Search Console's URL inspection — not counted
  as a search crawl). A crawler the list does not know is `other_<kind>`.
- `kind` — `search` `ai` `ads` `seo` `other`. When a bot directory is imported
  (console → settings) its category decides the kind; the built-in list is the
  fallback. Google's and Bing's ads crawlers are always `ads`.
- `first_seen_at` / `last_seen_at` are **all-time** and durable — they survive
  raw-event retention. Every engine ever seen is listed, even with no hits in
  `period`. An edge-sourced time is day-granular (start of that local day).
- `hits` counts are in `period`. Several sources can see the same fetch (a
  crawler that runs JavaScript also made an HTML request, which the edge and a
  reporting server both see), so `hits` is the largest of `beacon`, `edge` and
  `server` per day, summed — not their sum. `beacon_hits` / `edge_hits` /
  `server_hits` and `days[]` keep each source separately.
- `server_error_hits` — server-reported hits answered with HTTP status ≥ 400
  (a crawler fetching pages that do not exist). `server_verified_hits` — hits
  the reporter marked `verified: true` (see §6, Crawler reporting).
- `pages` — distinct paths in `period` across beacon and server data.
- `first_search_crawl_at` — earliest `first_seen_at` of any `search`-kind
  engine; `null` until one has come. The same field is on every `/v1/sites`
  item, so a launch overview can show "days since launch → first crawl".
- `sources.beacon` is always available but only sees crawlers that execute the
  tracking script (Googlebot does; many crawlers do not). `sources.edge` is
  available only when the deployer configured the optional Cloudflare token and
  the site's zone is visible to it; it adds non-JS crawlers from Cloudflare's
  top user agents per completed day, with no paths. `sources.server` is
  available once the site's own server has reported crawler hits
  (§6, Crawler reporting): every crawler that reached it, with paths and
  status. User agents are as declared, in every source — not verified.
- `top_pages` merges beacon and server data (max of the two per day, engine
  and path; `source` says which were present). Edge data has no paths.
- `bot=<engine>` restricts everything (engines, top pages,
  `first_search_crawl_at`) to one engine id, case-insensitive; `search=1`
  (any value but `0` / `false` / `no` / `off` / empty) to `kind = search`
  engines. `filters` echoes what was applied.
- `available: false` means the deployment has not applied migration 0024 yet.

Beacon and edge data are written by the cron worker: the hourly rollup
(beacon, today and yesterday), the daily edge pull (edge), and a one-time
backfill from data already present when 0024 is first deployed. Server data is
written as it is reported (migration 0025).

---

## 3. MCP server (chatbot access)

Lets an MCP-capable assistant query your deployment — "how much of yesterday's
traffic was bots?", "which pages did crawlers hit most this week?".

No install and no dependencies: the server speaks MCP over stdio directly, so
there is no package to audit for something that holds a read token.

Add to your client's MCP config (Claude Desktop shown):

```json
{
  "mcpServers": {
    "pvuv": {
      "command": "node",
      "args": ["/path/to/pvuv.ai/mcp/index.mjs"],
      "env": {
        "PVUV_API_URL": "https://api.example.com",
        "PVUV_TOKEN": "pvuv_…"
      }
    }
  }
}
```

Tools: `list_sites`, `get_overview`, `get_realtime`, `get_timeseries`,
`get_breakdown`, `get_traffic_quality`, `get_alerts`, `get_ad_protection`,
`get_edge_requests`, `get_crawlers`, `get_suspicious_visitors`.

They map onto `/v1/sites`, `overview`, `realtime`, `timeseries`, `breakdown`,
`quality`, `alerts`, `adguard`, `edge`, `crawlers` and `traffic`. Notes:

- `period` defaults to `7d` (the REST API defaults to `30d`) and is limited to
  the named list (`24h` … `this_year`, with `7d` `30d` `90d` as rolling windows).
- `get_breakdown` takes the dimension as `dimension`, not `dim`.
- `get_suspicious_visitors` sends `min_score` 30 unless told otherwise.
- There is no tool yet for `sites/summary`, `vitals`, `ctit`, `anomalies`,
  `funnels`, `funnel`, `funnel_dropoff` or `visitors`; use the REST API for
  those.

The server only issues GETs, so a chatbot can never change your configuration,
delete data, or alter ad protection — the worst it can do is read.

---

## 4. CLI

```bash
export PVUV_API_URL=https://api.example.com
export PVUV_TOKEN=pvuv_…

node cli/pvuv.mjs sites
node cli/pvuv.mjs overview 3exbuw7w --period 7d
node cli/pvuv.mjs breakdown 3exbuw7w --dim page --limit 10
node cli/pvuv.mjs quality 3exbuw7w
node cli/pvuv.mjs adguard 3exbuw7w --json
```

Output is a readable table; `--json` prints the raw API response for piping into
`jq` or a script. `node cli/pvuv.mjs help` lists everything.

Commands: `sites` `overview` `realtime` `timeseries` `breakdown` `quality`
`alerts` `adguard` `edge` `crawlers` `traffic`. Flags: `--period` (default `7d`;
`30d` for `crawlers`),
`--metric`, `--interval`, `--dim` (required for `breakdown`), `--limit`,
`--min-score` (`traffic`, default 30), `--json`. There are no commands for
`anomalies`, funnels, visitors, `vitals` or `ctit`, and no `--filters` flag —
call the REST API for those.

Example — daily invalid-traffic share into a log:

```bash
node cli/pvuv.mjs alerts "$SITE" --json \
  | jq -r '"\(now|todate) invalid=\(.stats.invalid / .stats.pv * 100 | floor)%"' \
  >> traffic-quality.log
```

---

## 5. The legacy `API_TOKEN` secret

The deployment-wide `API_TOKEN` worker secret still works and still reaches
every site plus `/v1/ranking` (which personal tokens deliberately cannot, since
it spans sites beyond one owner).

A legacy token is not tied to an owner: on every `/v1/sites/...` route it can
read any site in the deployment, and `/v1/sites` lists all of them.

Prefer personal tokens for anything else: `API_TOKEN` cannot be scoped to a
site, revoked individually, or attributed to a client, and rotating it breaks
every consumer at once.

---

## 6. Site provisioning (read/write tokens)

A site launcher — anything that brings new sites up on a schedule — can
register each site, configure it and get its embed tag in **one call**, then
manage the site through its lifecycle. These endpoints need a **read/write**
token: console → ⚙ settings → API tokens → Permission **Read & manage sites**.
A read/write token always covers all of the owner's sites (it cannot be scoped
to one), still reads like any other token, and is revocable like any other.
Store it as a secret and give it only to a service you trust: it can create,
rename and archive your sites.

Read-only tokens, session cookies and the legacy `API_TOKEN` get `403` on every
write endpoint. Unknown paths return `404` before any authentication; a known
path with the wrong method returns `405`. Request bodies are JSON, at most
16 KB (`crawler_hits`: 64 KB, see below).

| Endpoint | Does |
|---|---|
| `POST /v1/sites` | find-or-create a site by domain, optionally from a template; returns the embed snippet |
| `PATCH /v1/sites/{id}` | rename, replace / add / remove domains, archive or restore |
| `POST /v1/sites/{id}/funnels` | find-or-create a saved funnel by name |
| `GET /v1/templates` | the owner's site templates (any of the owner's tokens, read-only included) |
| `POST /v1/sites/{id}/tokens` | mint a site-scoped **ingest-only** token for server-side crawler reporting (see below) |
| `POST /v1/sites/{id}/crawler_hits` | report crawler requests (ingest token of that site, or the read/write token) |

**Every write except `/tokens` and `/crawler_hits` is safe to retry.** A launcher that times out and tries again
gets the same site and the same funnels back (`created: false`), never a
duplicate — including when several identical requests race.

### Domains

Every domain — in `POST /v1/sites`, `PATCH`, and the console's own site form —
goes through one normaliser: lowercased; scheme, port, path, query and a
trailing dot dropped; a Unicode name converted to its IDNA `xn--` form. So
`https://Shop.Example.com:8443/landing` is stored as `shop.example.com`, and
`bücher.de` as `xn--bcher-kva.de`. IP addresses and anything that is not a
hostname are refused (`400 invalid domain: …`); `localhost` is accepted for
local development. A site's whitelist also admits subdomains, so `example.com`
covers `www.example.com`.

### `POST /v1/sites`

```bash
curl -X POST "$PVUV_API_URL/v1/sites" \
  -H "Authorization: Bearer $PVUV_WRITE_TOKEN" -H "content-type: application/json" \
  -d '{"name":"Snake Game","domain":"snake.example.com","template":"Game site"}'
```

| Field | |
|---|---|
| `name` | required, up to 100 chars |
| `domain` | required (or `domains`) — the site's primary domain |
| `domains` | optional extra domains, e.g. `["www.snake.example.com"]` |
| `template` | optional template **id or name** (name match is case-insensitive) |
| `timezone` | IANA id, e.g. `Europe/Berlin` — **fixed at creation**, cannot be changed later |
| `engaged_seconds` | engagement threshold, clamped to 1–300 |
| `adguard_mode` | `off` · `balanced` · `loose` · `strict` |
| `adclient` | AdSense publisher id `ca-pub-…`; `null` clears a template's value |

Each setting resolves as **request field → template → default** (owner's
default timezone, 15 s, `off`, no adclient). Validation follows the console's
rules, but strictly: an invalid timezone, mode or adclient is a `400`, never
silently dropped.

The call is idempotent per owner + domain: if one of the owner's **active**
sites already lists any of the requested domains, that site is returned with
`created: false` and the settings in the request are *not* applied to it
(the timezone is immutable anyway; use `PATCH` or the console for the rest).
A template's default funnels are ensured by name on every call, so a retry
after a partial failure completes the set.

```json
{
  "created": true,
  "site": {
    "site_id": "Ab3xK9pQ", "name": "Snake Game", "domains": ["snake.example.com"],
    "timezone": "America/New_York", "status": "active",
    "adguard_mode": "balanced", "adclient": "ca-pub-1234567890123456",
    "engaged_seconds": 20, "shadow_until": 1764633600000
  },
  "snippet": "<script defer src=\"https://analytics.example.com/f.js\"\n        data-site=\"Ab3xK9pQ\"\n        data-api=\"https://in.example.com\"\n        data-adguard=\"balanced\"\n        data-adclient=\"ca-pub-1234567890123456\"></script>",
  "template": "Tm4pQ2xZ",
  "funnels": [
    { "funnel_id": "Fz81kLmN", "name": "Play", "created": true, "updated": false }
  ]
}
```

`snippet` is exactly the tag the console shows after creating a site: paste it
into the site's `<head>`. It is built from the api worker's `CONSOLE_HOST`
(where `f.js` is served) and `INGEST_HOST` vars in `workers/api/wrangler.toml`;
if either is empty, `snippet` is `null`. New sites start in shadow mode
(record-only until `shadow_until`) like console-created ones.

### `PATCH /v1/sites/{id}`

Typical launch day: a site goes live on a test subdomain, then moves to its
production domain with both `www` and the apex.

```bash
curl -X PATCH "$PVUV_API_URL/v1/sites/Ab3xK9pQ" \
  -H "Authorization: Bearer $PVUV_WRITE_TOKEN" -H "content-type: application/json" \
  -d '{"name":"Snake","add_domains":["snake.com","www.snake.com"],"remove_domains":["snake.example.com"]}'
```

| Field | |
|---|---|
| `name` | new name |
| `domains` | replace the whole list |
| `add_domains` / `remove_domains` | applied after `domains`, in that order |
| `status` | `archived` stops collection (ingest only accepts active sites) and hides the site from `GET /v1/sites`; its data is kept. `active` restores it. |

Returns `{ "changed": true, "site": {…} }` (`changed: false` for a no-op). A
site must keep at least one domain, and a domain can belong to only one active
site per owner — adding (or restoring a site with) a domain another active site
holds is a `409` that names that site. Changes reach ingest immediately: the
cached site config is invalidated. Timezone is immutable; the ad-protection
mode is changed in the console.

### `POST /v1/sites/{id}/funnels`

```json
{ "name": "Play", "steps": [ {"type":"page","value":"/"}, {"type":"event","value":"play_start"} ] }
```

2–8 steps of `page` (path, `*` suffix matches a prefix) or `event` (event
name); each value non-empty and at most 512 characters. Find-or-create **by
name**: a funnel of that name is returned as is (`created: false`); if its
steps differ they are replaced and `updated: true` says so; the `funnel_id`
never changes.

```json
{ "funnel_id": "Fz81kLmN", "name": "Play", "steps": [...], "created": false, "updated": true, "updated_at": 1764633600000 }
```

### Templates

A template is a per-owner preset: timezone, engagement threshold, ad-protection
mode, AdSense client and a list of default funnels. Any field can be left unset
(it then falls back to the normal default). Templates are managed in the
console (⚙ settings → **Site templates**); the API lists them:

```bash
curl -H "Authorization: Bearer $PVUV_TOKEN" "$PVUV_API_URL/v1/templates"
```

```json
{ "templates": [ {
  "template_id": "Tm4pQ2xZ", "name": "Game site", "timezone": "America/New_York",
  "engaged_seconds": 20, "adguard_mode": "balanced", "adclient": "ca-pub-1234567890123456",
  "funnels": [ { "name": "Play", "steps": [...] } ], "created_at": 1764633600000, "updated_at": 1764633600000
} ] }
```

### Crawler reporting

Crawlers do not run JavaScript, so a site served by its own Worker (or any
server) reports the crawler requests it answers. These hits go **only** into
the crawler metric (`GET /v1/sites/{id}/crawlers`, source `server`): never into
events, PV/UV, sessions, scoring, verdicts or ad protection, so a reported
crawler can never be counted as a visitor.

**1. Get an ingest token** — once per site, with the read/write token:

```bash
curl -X POST "$PVUV_API_URL/v1/sites/Ab3xK9pQ/tokens" \
  -H "Authorization: Bearer $PVUV_WRITE_TOKEN" -H "content-type: application/json" \
  -d '{"name":"launcher snake.com"}'
```

```json
{ "token": "pvuv_…", "token_id": "q3Lr0x8aZ1", "site_id": "Ab3xK9pQ", "scopes": ["ingest"],
  "name": "launcher snake.com", "prefix": "pvuv_Xy12ab", "created_at": 1764633600000 }
```

- The plaintext is returned **once**; only its HMAC is stored. It appears in
  the console token list as "Ingest only (crawler reports)" and is revoked
  there like any other token.
- **Not idempotent:** every call mints a new token, because an existing
  token's plaintext cannot be shown again. Call it only when you hold none (or
  lost it), and revoke the old one. A site can hold at most 20 live ingest
  tokens; past that the call is a `409`.
- `name` is optional (default `crawler ingest`); the body may be empty.
- An ingest token can do exactly one thing: `POST /v1/sites/{its site}/crawler_hits`.
  Every report, the site list, every other write and every other site answer
  `403`.

**2. Report hits** — in the background, after answering the crawler:

```bash
curl -X POST "$PVUV_API_URL/v1/sites/Ab3xK9pQ/crawler_hits" \
  -H "Authorization: Bearer $PVUV_INGEST_TOKEN" -H "content-type: application/json" \
  -d '{"hits":[{"ua":"Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)","path":"/privacy","ip":"203.0.113.9","status":200,"country":"US","ts":1764633600000}]}'
```

```json
{ "accepted": 1, "ignored": 0 }
```

Auth: that site's ingest token, or the owner's read/write token. Read-only
tokens get `403`; an archived site `403`.

| Field | |
|---|---|
| `ua` | required. Classified with the built-in engine list; a user agent that is not a known crawler (a person, an unknown bot) is **ignored** — counted in `ignored`, stored nowhere. |
| `path` | required. Must start with `/` (an absolute `http(s)://` URL is reduced to its path). The **query string and fragment are dropped** (cardinality, and they can carry session ids); longer than 512 characters is cut. |
| `status` | optional HTTP status you answered with; `>= 400` is counted in `server_error_hits`. |
| `ts` | optional, ms. Missing, malformed or in the future → now. Older than 48 hours → ignored. |
| `verified` | optional `true` when *your* server has a trustworthy verified-bot signal for the request (e.g. Cloudflare Bot Management's `verifiedBot`); counted in `server_verified_hits`. |
| `ip`, `country` | accepted, **not stored**. |

Limits: at most 100 hits and 64 KB per request (`413` beyond). Hits are
grouped per local day (site timezone) and engine and written in one batch;
reports are **additive** — a retried request is counted again. Up to 200
distinct paths are kept per engine per day (the daily hit count stays exact).

**Spoofing.** Anyone can send a `Googlebot` user agent, and the report is
trusted as sent by the token holder (the site owner's own server). pvuv does
no reverse-DNS check. `verified` is self-asserted by the reporter; on plans
without Cloudflare's verified-bot signal, leave it unset — `hits` then counts
declared user agents, like the beacon and edge sources do.

Requires migration `0025`; before it is applied the endpoint answers `503`.

### Tests

`npm test` runs the integration suite (`tests/*.test.mjs`) against temporary
Worker bundles and an in-memory SQLite stand-in for D1.
