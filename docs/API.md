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

### Endpoints

| Endpoint | Returns |
|---|---|
| `GET /v1/sites` | sites this token can read — **call first**, ids are not guessable |
| `GET /v1/sites/{id}/overview` | pageviews, visitors, sessions, bounce rates, dwell, verdict split |
| `GET /v1/sites/{id}/realtime` | visitors in the last 30 min + per-minute sparkline |
| `GET /v1/sites/{id}/timeseries` | a metric over time; each bucket also carries `pv` and `invalid` |
| `GET /v1/sites/{id}/breakdown` | top values for one dimension |
| `GET /v1/sites/{id}/quality` | verdict totals + which detection signals fired |
| `GET /v1/sites/{id}/alerts` | rule checks, their ratios and thresholds |
| `GET /v1/sites/{id}/adguard` | per-tier block/false-positive estimates, block reasons |
| `GET /v1/sites/{id}/traffic` | individual suspicious visitors with their evidence |
| `GET /v1/sites/{id}/anomalies` | baseline anomaly reports |
| `GET /v1/sites/{id}/funnel` | conversion funnel for `steps` |
| `GET /v1/sites/{id}/visitors` | visitor list; `/{vid}/profile` for one journey |

### Common parameters

- `period` — `24h` `today` `yesterday` `7d` `30d` `90d` `this_week` `last_week`
  `this_month` `last_month` `this_year` (resolved in the site's own timezone)
- `metric` — `pv` `uv` `sessions` `bounce_rate` `bounce_rate_single`
  `avg_duration_ms` `visit_duration_ms`
- `interval` — `minute` `hour` `day` `week` `month`
- `dim` — `page` `entry_page` `exit_page` `source` `referrer` `country` `region`
  `city` `browser` `os` `device` `size` `utm_*` `ft_*` `goal` `bot_category`
- `limit`, `filters` (JSON array of `{dim,value}`)

Errors are `{"error":"…"}` with a matching status: `401` bad/missing token,
`403` token not valid for that site, `404` unknown route or site.

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
`get_suspicious_visitors`.

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

Prefer personal tokens for anything else: `API_TOKEN` cannot be scoped to a
site, revoked individually, or attributed to a client, and rotating it breaks
every consumer at once.
