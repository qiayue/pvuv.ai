# pvuv.ai

**Self-hosted, privacy-conscious web analytics with built-in invalid-traffic detection and ad protection — on Cloudflare Workers + D1.**

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](./LICENSE)
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

> The commands below describe the intended deployment. Some pieces land incrementally — check the [roadmap](#roadmap).

**Prerequisites:** Node.js 18+, a Cloudflare account, and `wrangler` (`npm i -g wrangler`).

```bash
# 1. Clone
git clone https://github.com/qiayue/pvuv.ai.git
cd pvuv.ai
npm install

# 2. Create Cloudflare resources
wrangler d1 create pvuv
wrangler kv namespace create BLOCKLIST
wrangler kv namespace create SITE_CONFIG
wrangler queues create INGEST_QUEUE

# 3. Configure — copy placeholders and fill in your IDs (never commit real IDs)
cp config.example.toml config.local.toml     # scoring weights/thresholds (gitignored)
#   then paste the D1/KV/Queue IDs from step 2 into each workers/*/wrangler.toml

# 4. Set secrets (never put these in any file)
wrangler secret put HMAC_KEY                  # cookie signing / verdict integrity
wrangler secret put AI_API_KEY                # optional, for AI analysis

# 5. Apply the database schema
wrangler d1 execute pvuv --file=./shared/schema.sql

# 6. Deploy the Workers
wrangler deploy --config workers/ingest/wrangler.toml
wrangler deploy --config workers/consumer/wrangler.toml
wrangler deploy --config workers/api/wrangler.toml
wrangler deploy --config workers/console/wrangler.toml
wrangler deploy --config workers/cron/wrangler.toml
```

**Bind your domains** in the Cloudflare dashboard (or via routes): `js` + `in` → ingest/static, `api` → api Worker, apex → console.

## Add it to a site

Register a site in the console to get a `site_id`, then embed:

```html
<script defer src="https://js.pvuv.ai/f.js"
        data-site="YOUR_SITE_ID"
        data-adguard="balanced"
        data-adclient="ca-pub-xxxxxxxxxxxxxxxx"></script>
```

Optional attributes: `data-spa="true"` (SPA route tracking), `data-api` (self-hosted reverse-proxy endpoint, see [`PROJECT_PLAN.md` §12](./PROJECT_PLAN.md)), `data-exclude="/admin/*"`, `data-sensors="off"` (disable mobile-sensor signals for compliance).

## Configuration

Scoring weights, verdict thresholds, and the blocklist are **tunable and deployment-private**. `config.example.toml` ships example defaults; copy it to `config.local.toml` (gitignored) and tune privately. The engine reads weights from config — nothing is hardcoded — so you can adjust detection without exposing it to fraudsters. See [`PROJECT_PLAN.md` §21](./PROJECT_PLAN.md).

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

[GNU AGPL-3.0](./LICENSE). You may self-host and modify freely, but if you run a modified version as a network service, you must offer its source to your users. This keeps the project open while preventing closed-source commercial forks.
