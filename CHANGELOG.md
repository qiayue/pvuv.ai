# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/) (pre-1.0: minor versions may include
breaking changes, always with a D1 migration and upgrade notes in
[`DEPLOY.md`](https://github.com/qiayue/pvuv.ai/blob/main/DEPLOY.md)).

## [Unreleased]

### Site provisioning API
- The API is no longer purely read-only: a console owner can issue an
  all-sites **read/write** token ("Read & manage sites") for a trusted
  integration, e.g. a launcher that brings a new site up every day. Read-only
  remains the default. See [`docs/API.md`](./docs/API.md) §6.
- `POST /v1/sites` — find-or-create by owner + domain (race-safe; retries never
  duplicate). Accepts extra `domains`, a `template` (id or name) and explicit
  `timezone` / `engaged_seconds` / `adguard_mode` / `adclient` overrides, and
  returns a ready-to-paste embed `snippet` alongside `{created, site}`.
- `PATCH /v1/sites/{id}` — rename, replace / add / remove domains (test
  subdomain → production, www + apex), archive (`status: "archived"`, stops
  ingest, keeps data) and restore. Ingest's cached site config is invalidated
  on every change. A domain may belong to only one active site per owner.
- `POST /v1/sites/{id}/funnels` is now find-or-create **by name**: an existing
  funnel comes back with `created: false`, and differing steps are replaced
  (`updated: true`). Step values are capped at 512 characters.
- **Site templates** (migration `0023_site_templates.sql`): per-owner presets —
  timezone, engagement threshold, ad-protection mode, AdSense client, default
  funnels — managed in ⚙ settings → Site templates and listed by
  `GET /v1/templates`.
- Unknown write paths now return `404` (previously `401`), and wrong methods on
  known paths `405`.

### Changed
- Console and API create sites through one shared helper (`shared/sites.ts`):
  one domain normaliser (lowercase; scheme / port / path / trailing dot
  stripped; Unicode → IDNA `xn--`; IP literals refused), one insert and KV
  write-through. The API now accepts `https://…` URLs it used to reject; the
  console form now drops entries that are not real hostnames (e.g. bare IPs or
  `foo..com`) — `localhost` is still accepted.
- Saving a funnel in the console now rejects empty or over-long (> 512 chars)
  step values, the same rule the API applies.
- The API-token form is fully translated again (permission picker and help text
  in all 7 languages); archived sites are tagged in the site list.

### Upgrade notes
- Apply migrations `0022` and `0023` before deploying the api and console
  workers.
- `workers/api/wrangler.toml` has new `[vars]` `CONSOLE_HOST` and `INGEST_HOST`
  (used for the returned snippet); set them to your hosts.

## [0.1.0] — 2026-11-03

First open-source release: a self-hosted, Cloudflare Workers + D1 deployment of
pvuv.ai.

### Analytics
- Multi-site / multi-subdomain PV/UV, top pages, entry pages, referrers, full UTM
  set and click IDs, GA4-style channel groups.
- Sessions, engagement-based bounce rate, true dwell time, visitor journeys.
- Custom events with revenue, funnels with friction signals, segments,
  drop-off drill-down and saved funnels.
- Core Web Vitals, periodic behaviour reporting (`page_pulse`), frustration /
  error / form signals.
- Public share links for read-only dashboards.

### Invalid-traffic detection
- Per-hit 0–100 score, verdict (`clean` / `suspect` / `bot` / `crawler`) and
  signal bit flags.
- Client signals, transport fingerprint, declared AI-agent classification,
  pointer-dynamics scoring, scroll-vs-pointer interaction, session-drift
  detection.
- Daily batch analysis: population clusters, bipartite graph propagation,
  one-shot farm detection on network/transport keys, conversion-timing analysis.
- Shadow (record-only) mode for previewing blocking before enforcing it.

### Platform
- Workers: `ingest`, `consumer`, `api`, `console`, `cron`, optional `proxy`.
- 21 D1 migrations (`migrations/0001`–`0021`), D1 retention trims and a
  storage panel.
- Console: tabbed dashboard loaded on demand, first-run onboarding, mobile
  record cards, UI in 7 languages (English, 中文, 日本語, 한국어, Deutsch,
  Français, Español).
- API tokens, CLI (`cli/pvuv.mjs`) and MCP server (`mcp/`); see
  [`docs/API.md`](https://github.com/qiayue/pvuv.ai/blob/main/docs/API.md).
- Optional Cloudflare edge-request pull (opt-in, observation only).
- Deployment guides in English and Chinese: [`DEPLOY.md`](https://github.com/qiayue/pvuv.ai/blob/main/DEPLOY.md),
  [`DEPLOY.zh-CN.md`](https://github.com/qiayue/pvuv.ai/blob/main/DEPLOY.zh-CN.md).

### Requirements
- Node.js 22+ (required by wrangler 4), a Cloudflare account on the Workers
  Paid plan, and a domain on Cloudflare DNS.

### Known limitations
- Revenue is aggregated in USD only; events in other currencies are stored but
  not yet converted.
- `identify()` records the user ↔ visitor link, but nothing merges visitors
  across devices yet; there are no multi-touch attribution models.
- AI reports are on demand only (no scheduled reports), and anomalies have no
  review/dismiss UI.
- The expensive client checks (WebGL/canvas fingerprint) are not collected, so
  the fingerprint blocklist and cross-site fingerprint clusters stay dormant.
- Old monthly partitions are dropped by retention, not archived.

[0.1.0]: https://github.com/qiayue/pvuv.ai/releases/tag/v0.1.0
