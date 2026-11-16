# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/) (pre-1.0: minor versions may include
breaking changes, always with a D1 migration and upgrade notes in
[`DEPLOY.md`](https://github.com/qiayue/pvuv.ai/blob/main/DEPLOY.md)).

## [Unreleased]

### Added
- Crawler / indexing signals, a separate metric for newly launched sites: has
  Googlebot (Bing, Yandex, Baidu, Applebot, …) come yet, how often, and which
  pages. A built-in engine matcher (`shared/crawlers.ts`) classifies crawlers
  into engines and kinds (`search` / `ai` / `ads` / `seo` / `other`;
  AdsBot-Google and Mediapartners-Google are `ads`), preferring the imported bot
  directory's category when there is one. Durable per-engine first/last-seen
  milestones and a daily per-engine rollup are filled by the hourly rollup
  (beacon) and the daily Cloudflare edge pull (non-JS crawlers, optional), with
  a one-time backfill. New `GET /v1/sites/{id}/crawlers`, console "Crawlers"
  tab, MCP `get_crawlers`, CLI `pvuv crawlers`, and `first_search_crawl_at` on
  every `/v1/sites` item. Never feeds PV/UV, scoring, verdicts or ad protection.
- Migration `0024_crawler_milestones.sql`. Event partitions gain a
  `crawler_engine` column through the existing automatic partition repair.
  Order-independent: before the migration lands the crawler step logs and
  skips, and the endpoint answers `available: false`.

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
