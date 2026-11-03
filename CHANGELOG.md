# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/) (pre-1.0: minor versions may include
breaking changes, always with a D1 migration and upgrade notes in
[`DEPLOY.md`](./DEPLOY.md)).

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
  record cards, English and Simplified Chinese UI.
- API tokens, CLI (`cli/pvuv.mjs`) and MCP server (`mcp/`); see
  [`docs/API.md`](./docs/API.md).
- Optional Cloudflare edge-request pull (opt-in, observation only).
- Deployment guides in English and Chinese: [`DEPLOY.md`](./DEPLOY.md),
  [`DEPLOY.zh-CN.md`](./DEPLOY.zh-CN.md).

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
