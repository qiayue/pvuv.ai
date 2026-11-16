# Portfolio console redesign — shared contract

This document is the single source of truth for the three parallel work streams
that rebuild the console for owners of many sites (50–500, one new site a day).
Every stream branches from `claude/dreamy-turing-jm0cm9` and must stay inside
its ownership boundaries below so the three branches merge cleanly.

- Visual reference (CURRENT): `docs/design/portfolio-mock-light.html` /
  `portfolio-mock-light.png` — calm light, neutral SaaS style. Copy its CSS
  variables verbatim as the console tokens.
- SUPERSEDED: `portfolio-mock.*` (premium dark) and the palette of
  `portfolio-drawer-mock.*`. Use those files only for *content/layout* (what
  the table columns and the drawer contain), never for colours or decoration.
- No hard-coded product names of client integrations anywhere (code, docs,
  commits). Refer to "a site launcher" / "an integration".

## 1. Product decisions (fixed)

| Topic | Decision |
|---|---|
| Default view | "All sites" table, with the "Needs attention" quick filter visible and its count in the sidebar |
| Default period | last 7 days, compared with the previous period |
| Stable growth | ≥ 1,000 clean visitors in the last 7 days and Δ ≥ −10% (configurable, instance settings) |
| Declining | 28-day clean visitors down > 30% vs the previous 28 days (configurable) |
| Waiting for crawl overdue | live > 3 days and no search-engine crawl |
| Crawled but no organic overdue | first crawl > 14 days ago and no organic-search visitor |
| No data alert | site created/active and no event in the last 24 h |
| IVT alert | invalid-traffic share > 20 % (critical when ad-guard mode is `off`) |
| Style | **light neutral** (see `portfolio-mock-light.*`): page `#f7f7f8`, white cards, 1px `#e7e7ea` borders, 12px radius, no shadows/glows/gradients except a very faint fill under the main line chart; one blue data accent (`#3b82f6`), green primary CTA, grey secondary text; large page title + underline tabs; segmented controls for filters/toggles; "Synced <time> · Refresh" on the right; KPI cards = icon + label, delta % small top-right (green/red), big number; breakdowns as thin progress bars with value / % / extra columns; status as a small coloured dot + grey text (no filled pills); sparklines are thin 1.5px lines (red when Δ < 0), no area fill; site identity = neutral bordered initial tile (no coloured avatars); line-style 16px icons; left sidebar with grouped sections (站点 / 分析 / 配置) and counts. No emoji in UI chrome. Dark mode is out of scope for now (keep tokens as CSS variables so it can be added later). |
| Stack | keep no-build static console; vendor Preact + htm standalone and uPlot; in-house SVG sparklines |

## 2. Lifecycle stages

`setup` → `awaiting_crawl` → `crawled` → `organic` → `growing` | `declining`,
plus `archived` (status column, set manually).

| Stage | Rule (first match from the bottom wins for active sites) |
|---|---|
| `setup` | no event ever received |
| `awaiting_crawl` | has data, no search-kind crawler milestone (`crawler_milestones`, kind = search) |
| `crawled` | has a search crawl, no organic-search or AI-referred visitor yet |
| `organic` | at least one organic-search or AI visitor |
| `growing` | meets the "stable growth" rule |
| `declining` | meets the "declining" rule (takes precedence over `growing`/`organic`) |

`stage_since` = when the current stage was entered (best effort from the
underlying first-seen timestamps).

## 3. API contract (console + api workers)

### 3.1 `GET /api/portfolio?period=7d&compare=previous` (console, session cookie)
Same payload is exposed as `GET /v1/portfolio` for all-sites tokens.

```jsonc
{
  "period": { "token": "7d", "start": "…", "end": "…" },
  "generated_at": 1763270000000,
  "totals": {                                   // all active sites in scope
    "uv": 48210, "uv_prev": 43000, "pv": 131904, "pv_prev": 121000,
    "ivt_pct": 6.8, "ivt_pct_prev": 5.6,
    "organic_uv": 19377, "organic_uv_prev": 16000,
    "ai_uv": 1204, "ai_uv_prev": 734,
    "top10_share": 0.71,                        // share of uv from the top 10 % of sites
    "series": [{ "day": "2026-11-10", "uv": 6900 }]
  },
  "funnel": { "total": 126, "has_data": 124, "google_crawled": 119, "organic": 101, "weekly_1000": 27 },
  "stage_counts": { "setup": 2, "awaiting_crawl": 5, "crawled": 18, "organic": 61, "growing": 27, "declining": 13, "archived": 4 },
  "attention_count": 7,
  "sites": [{
    "site_id": "Ab3xK9pQ", "name": "Pixel Golf", "domains": ["pixelgolf.io"],
    "status": "active", "created_at": 1753000000000, "days_live": 120,
    "starred": false, "tags": ["小游戏", "AdSense"],          // P1 reads; P2 writes
    "adguard_mode": "off",
    "stage": "declining", "stage_since": 1762000000000,
    "uv": 1544, "uv_prev": 1755, "pv": 4210, "pv_prev": 4800, "delta_pct": -12.0,
    "series": [{ "day": "2026-11-03", "uv": 230 }],            // 14 points, oldest first
    "organic_uv": 512, "ai_uv": 37, "ivt_pct": 31.4,
    "crawl": { "google": { "first_seen_at": 0, "last_seen_at": 0 }, "bing": null, "yandex": null, "baidu": null },
    "health": ["ok","ok","warn","bad", "none"],                // 14 days: ok | warn | bad | none
    "attention": [{ "code": "ivt_high", "severity": "critical", "params": { "ivt_pct": 31.4, "adguard_mode": "off" } }],
    "external": null                                           // P3 fills, see 3.3
  }]
}
```

- One batched request; must stay fast at 500 sites (rollup tables only, chunked
  `IN (…)`, no per-site raw scans). Cache per (owner, period) for 5 minutes.
- `attention` codes (P1): `no_data_24h`, `crawl_overdue`, `organic_overdue`,
  `declining`, `ivt_high`, `ivt_spike`. P3 adds `traffic_no_revenue`,
  `adsense_needs_attention`, `ads_txt_problem`, `network_declined`,
  `external_stale`. Severity: `critical` | `high` | `normal`. The client
  sorts the attention queue by severity, then by `uv` descending.
- UI text for codes comes from `i18n.js` keys `attn.<code>` with `{param}`
  placeholders.

### 3.2 Labels (owned by P1 for read, P2 for write)
- Migration `0026_site_labels.sql` (P1): `site_labels(site_id PK, starred INTEGER DEFAULT 0, tags TEXT DEFAULT '[]', notes TEXT, updated_at)`.
- P2 adds write endpoints: `POST /api/sites/bulk` `{site_ids:[], action:"star"|"unstar"|"tag"|"untag"|"archive"|"restore"|"adguard", value?}` and `PUT /api/sites/{id}/labels`. Also automatic cohort tag `launch:YYYY-Www` computed at read time (P1 may display it; P2 owns the helper `cohortTag(created_at, tz)` in `shared/labels.ts` — P1 creates that file with this one function, P2 extends it).

### 3.3 External data (owned by P3)
- `workers/api/src/external.ts` exports
  `loadExternal(db, siteIds: string[], period): Promise<Record<string, ExternalSite>>`.
  P1 ships a stub returning `{}`; P3 replaces the body, keeping the signature.
- `ExternalSite` = `{ revenue_usd, revenue_prev_usd, rpm_usd, adsense: {status, ads_txt, checked_at} | null, adsterra: {status, checked_at} | null, search: {indexed_pages, impressions, clicks, checked_at} | null, attention: Attention[] }`.
- P1 merges `external` into each site and `external.attention` into `attention`; P1 renders revenue/RPM/AdSense columns only when any site has external data (columns hidden otherwise).
- Migrations from P3 start at `0028_…`. P2 uses `0027_…` if it needs one.

## 4. Frontend file layout

| Path | Owner | Notes |
|---|---|---|
| `workers/console/public/vendor/preact-htm.js`, `uplot.*` | P1 | vendored, license headers kept |
| `workers/console/public/js/ui.js` | P1 | design tokens helpers, `sparkline()`, `areaSpark()`, `avatar()`, `chip()`, `fmt` |
| `workers/console/public/js/cmdk.js` | P1 | ⌘K / `/` site switcher, loaded on every page |
| `workers/console/public/sites.html` | P1 | rewritten as the portfolio overview; settings panel removed, ⚙ links to `/settings.html` |
| `workers/console/public/console.css` | P1 | premium tokens as CSS variables; others only append clearly marked blocks |
| `workers/console/public/js/drawer.js` | P2 | `window.pvuvDrawer = { open(site, ctx), close() }` — P1 calls it on row click if present |
| `workers/console/public/js/views.js` | P2 | `window.pvuvViews = { cards(el, sites, ctx), heatmap(el, sites, ctx) }` — P1's view switch calls them if present |
| `workers/console/public/js/bulk.js` | P2 | `window.pvuvBulk = { mount(toolbarEl, getSelectedIds, onDone) }` |
| `workers/console/public/settings.html` | P2 | everything that lived in the sites.html ⚙ panel (tokens, templates, storage, bot directory, AI, Cloudflare) moved here, split into sections |
| `workers/console/public/integrations.html` or a section of settings | P3 | connect AdSense / Search Console (Google OAuth), Adsterra API token, sync status |
| `workers/console/public/i18n.js` | all | each stream appends its keys in a block commented `// ── portfolio:p1|p2|p3` at the end of every language object; all 7 languages |

`ctx` passed to P2 modules: `{ period, t, te, esc, fmt, ui }` where `ui` is the module from `js/ui.js`.

## 5. Shared rules
- Tests: `npm test` and `npm run typecheck` pass; add tests for every new endpoint.
- Screenshots: each stream adds Playwright screenshots of its screens with mocked
  API data to `docs/design/screens/` (P1: overview; P2: drawer, cards, heatmap,
  settings; P3: integrations + overview with external columns).
- Keep the single-site page working; P1 only adds the ⌘K switcher and a top
  site switcher there.
- Commit messages and code must not contain model identifiers or client product names.
