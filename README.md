# pvuv.ai

**Self-hosted, privacy-conscious web analytics with built-in invalid-traffic detection and ad protection — on Cloudflare Workers + D1.**

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![Status: early development](https://img.shields.io/badge/status-early%20development-orange.svg)](#roadmap)
[![Runs on Cloudflare](https://img.shields.io/badge/runs%20on-Cloudflare%20Workers-f38020.svg)](https://workers.cloudflare.com/)

> 中文说明 / Chinese: [`README.zh-CN.md`](./README.zh-CN.md) · Full build spec: [`PROJECT_PLAN.md`](./PROJECT_PLAN.md)

pvuv.ai is a lightweight analytics platform you host yourself on Cloudflare's edge. Beyond counting PV/UV, it scores every hit for authenticity, spots invalid traffic that only reveals itself in aggregate, and can gate ad code so it loads only for traffic judged trustworthy — helping protect ad accounts from invalid-traffic penalties.

> **Status.** This repository is under active development. The [roadmap](#roadmap) tracks progress toward the first deployable milestone (M1). Interfaces and schema may change before a tagged release.

---

## Why

Most self-hosted analytics tools count traffic but treat every request as real. Sites that monetize with ad networks are exposed to invalid-traffic penalties they can't see coming. pvuv.ai treats **traffic quality as a first-class metric**: it collects the usual analytics *and* a layered authenticity signal, so you can tell clean traffic from bots, understand where bad traffic comes from, and act on it.

## Features

**Full-dimension analytics**
- Multi-site and multi-subdomain, per-page PV/UV
- Referrers, full UTM set, and all click/tracking params (gclid, fbclid, ttclid, msclkid, ref, …)
- Bounce rate (engagement-based, GA4-style) and true dwell time
- Custom events with revenue (auto-converted to USD)
- Session- and user-level full-path attribution (first-touch + last-touch), cross-device identity merge

**Invalid-traffic detection (three layers)**
- **Client signals** — headless/automation traits, environment contradictions, WebGL/canvas, honeypots
- **Session features** — inter-page timing, path patterns, interaction presence
- **Population statistics** — fingerprint / IP-segment clusters, distribution-shape tests, timing regularity, baseline anomalies, and cross-site detection
- Every event carries a 0–100 score, a verdict (`clean`/`suspect`/`bot`/`crawler`), and a bit-flag record of which signals fired

**Ad protection (optional)**
- Progressive verdict: fast first-page decision, then accurate blocking from the second page onward
- Loads ad code only for trustworthy traffic; **never modifies the ad network's script** (decides *whether* to inject only)
- Fail-open by design — any error defaults to loading ads, never costing you revenue
- Per-site owner-controlled thresholds with a shadow (record-only) mode to preview impact before enforcing

**AI-powered analysis (optional)**
- Scheduled and on-demand reports: *data anomaly → attribution → actionable recommendations*

## Architecture

```
browser (f.js)
  → in.pvuv.ai/in   ingest Worker: validate + server-side enrichment + realtime scoring
  → Cloudflare Queue
  → consumer Worker: batch-write D1 events, update sessions/profiles
  → Cron (hourly)   rollup pre-aggregation tables
  → Cron (daily)    population analysis → re-verdict + KV blocklist ──┐
                                                                      │ loops back to
  api.pvuv.ai/v1    query API (dashboard / ranking / AI)             │
  pvuv.ai           console (dashboards, traffic quality)   in.pvuv.ai/v ←┘ fast verdict
```

**Domain split** — exposed subdomains (`js`, `in`) that get embedded on measured sites are isolated from internal ones (`api`, apex console), so if an exposed subdomain ever hits a blocklist, dashboards and queries are unaffected. See [`PROJECT_PLAN.md` §1](./PROJECT_PLAN.md).

## Tech stack

Cloudflare **Workers** (ingest, consumer, api, console, cron) · **D1** (SQLite, monthly-partitioned events) · **Queues** (spike buffering) · **KV** (blocklist, config cache) · **Cron Triggers** (rollups, batch analysis) · optional **R2** (archive/static). No external database, no server to run.

## Quick start

**Full step-by-step guide: [`DEPLOY.md`](./DEPLOY.md)** (中文: [`DEPLOY.zh-CN.md`](./DEPLOY.zh-CN.md)). The short version:

**Prerequisites:** Node.js 18+, a Cloudflare account on the **Workers Paid plan** (Queues requires it), and a domain on Cloudflare.

```bash
# 1. Clone
git clone https://github.com/qiayue/pvuv.ai.git
cd pvuv.ai
npm install                                    # also generates the scoring config

# 2. Create Cloudflare resources
npx wrangler d1 create pvuv-db
npx wrangler kv namespace create BLOCKLIST
npx wrangler kv namespace create SITE_CONFIG
npx wrangler queues create pvuv-ingest
npx wrangler queues create pvuv-ingest-dlq

# 3. Configure — replace the PLACEHOLDER_* ids in wrangler.toml and
#    workers/*/wrangler.toml, set your domains in the route patterns,
#    and (optionally) tune scoring privately:
cp config.example.toml config.local.toml       # gitignored
npm run config:gen

# 4. Create the schema, deploy, set secrets (same HMAC_KEY on all three)
npm run db:migrate:remote
npm run deploy:all
npx wrangler secret put HMAC_KEY  -c workers/ingest/wrangler.toml
npx wrangler secret put HMAC_KEY  -c workers/api/wrangler.toml
npx wrangler secret put HMAC_KEY  -c workers/console/wrangler.toml
npx wrangler secret put API_TOKEN -c workers/api/wrangler.toml

# 5. Console login is OAuth-only — configure Google and/or GitHub
#    (set ADMIN_EMAILS + GOOGLE_CLIENT_ID in console/wrangler.toml [vars]):
npx wrangler secret put GOOGLE_CLIENT_SECRET -c workers/console/wrangler.toml

# 6. Build + host the SDK
npm run build:sdk
cp sdk/dist/f.js workers/console/public/f.js && npm run deploy:console
```

Then sign in at your console domain with Google/GitHub (your email must be in `ADMIN_EMAILS`), register a site, and embed the snippet it prints. Details, OAuth setup, DNS notes, verification, and troubleshooting: [`DEPLOY.md`](./DEPLOY.md).

## Add it to a site

Register a site in the console to get a `site_id`, then embed:

```html
<script defer src="https://js.pvuv.ai/f.js"
        data-site="YOUR_SITE_ID"
        data-adguard="balanced"
        data-adclient="ca-pub-xxxxxxxxxxxxxxxx"></script>
```

Optional attributes: `data-spa="true"` (SPA route tracking), `data-api` (ingest endpoint override / self-hosted reverse proxy, see [`PROJECT_PLAN.md` §12](./PROJECT_PLAN.md)), `data-exclude="/admin/*"`, `data-sensors="off"` (disable mobile-sensor signals for compliance).

> **Self-hosted deployments must set `data-api`** to their own ingest host (e.g. `data-api="https://in.example.com"`) — the SDK's built-in default points at the reference domain. The console generates a snippet with the right values for your deployment.

## Configuration

Scoring weights, verdict thresholds, and the blocklist are **tunable and deployment-private**. `config.example.toml` ships example defaults; copy it to `config.local.toml` (gitignored) and tune privately. The engine reads weights from config — nothing is hardcoded — so you can adjust detection without exposing it to fraudsters. See [`PROJECT_PLAN.md` §21](./PROJECT_PLAN.md).

## External ranking API (optional)

An external ranking/scoring system can pull a cross-site, clean-traffic leaderboard in one call, authorized with the server-side API token:

```bash
curl -H "Authorization: Bearer $API_TOKEN" \
  "https://api.pvuv.ai/v1/ranking?period=30d"
```

Returns each active site with clean (bot/crawler/suspect-excluded) pageviews split into **internal** (mutual visits referred by another site in the same deployment) and **external** traffic. The default `score` is external clean pageviews, so mutual visits between your own sites can't inflate the ranking; every field is exposed so an external system can apply its own formula. Owners also see this as a "Site ranking" table in the console. See [`PROJECT_PLAN.md` §14](./PROJECT_PLAN.md).

## Editions

pvuv.ai is **open core**:

- **This repository — the self-hosted edition — is MIT-licensed.** Use it, modify it, run it commercially, fold it into a closed product. No copyleft, no attribution requirement, no strings. Use it without a second thought.
- **A hosted, multi-tenant SaaS edition** (managed accounts, billing, org isolation, support) is offered separately by the author and is **not** part of this repository. The two do not overlap or conflict — the open-source edition is complete and fully functional on its own.

## Attribution (optional)

The shipped default homepage carries a small "Powered by pvuv.ai" footer linking back to the project — **on the deployed instance's homepage only** (dashboards and inner pages have no links, and nothing is ever injected into the sites you measure). It's a courtesy, **not a requirement**: MIT imposes none. Keep it if you'd like to support the project, or remove it freely — provide your own `workers/console/public/home.html` (served verbatim, with no footer added) or edit the default page. A star on GitHub is always appreciated. 🙏

> The default homepage is intentionally sparse — it is *meant* to be customized. Thousands of deployments sharing identical landing copy would only create duplicate-content noise in search engines.

## Privacy & compliance

pvuv.ai is designed to minimize what it stores:
- IP is stored only as a truncated hash (+ /24 segment hash), never in plaintext.
- Device fingerprints are stored as hashes and conclusions only — never raw values — and are used solely for authenticity scoring, not cross-site visitor profiling.
- Mobile-sensor signals are coarse booleans only (no raw streams, no sensor fingerprint) and can be turned off.

**Deployer responsibility:** in GDPR/ePrivacy jurisdictions, fingerprinting and sensor signals may require user consent. The project ships data-minimizing defaults and opt-out toggles; each deployer is responsible for compliance in their own jurisdiction. See [`PROJECT_PLAN.md` §16](./PROJECT_PLAN.md).

## Roadmap

| Milestone | Scope |
|---|---|
| **M1** (first deployable) | SDK + ingest + fast verdict + D1 schema + minimal console (PV/UV, sources, top pages, traffic-quality overview) |
| **M2** | Sessions/dwell/bounce, full UTM, rollup acceleration, population analysis + blocklist loop, shadow mode, reverse-proxy option |
| **M3** | identify + custom events + revenue + funnel attribution, distribution tests + baseline anomalies |
| **M4** | AI reports, full anti-fraud, external ranking integration, human-review UI |

Full details in [`PROJECT_PLAN.md`](./PROJECT_PLAN.md).

## Contributing

Contributions are welcome — see [`CONTRIBUTING.md`](./CONTRIBUTING.md). Please read the build spec first so proposals fit the architecture.

## Security

Found a vulnerability? Please report it privately — see [`SECURITY.md`](./SECURITY.md). Do not open a public issue for security reports.

## License

[MIT](./LICENSE). Do whatever you want — self-host, modify, redistribute, or use it commercially — with no obligation to open your changes and no attribution requirement. The separately-offered hosted multi-tenant SaaS edition is licensed on its own terms and is not covered by this repository.
