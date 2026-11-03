# API, MCP server & CLI

Three ways to read a pvuv.ai deployment programmatically. All are **read-only**
(`GET` only) and share one credential: a personal API token.

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

> A token grants read access to the sites in its scope. Treat it like a
> password: it is not a public key, and anything holding it can read your
> analytics.

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
| `GET /v1/sites` | sites this token can read (`site_id`, `name`, `domains`, `timezone`, `created_at`) — **call first**, ids are not guessable | — |
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
`get_edge_requests`, `get_suspicious_visitors`.

They map onto `/v1/sites`, `overview`, `realtime`, `timeseries`, `breakdown`,
`quality`, `alerts`, `adguard`, `edge` and `traffic`. Notes:

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
`alerts` `adguard` `edge` `traffic`. Flags: `--period` (default `7d`),
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
