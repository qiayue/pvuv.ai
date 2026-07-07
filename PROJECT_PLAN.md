# pvuv.ai — Self-hosted Web Analytics with Invalid-Traffic Detection & Ad Protection

> **Project planning document** (build spec / handoff to Claude Code) · v1.1
> Repo: https://github.com/qiayue/pvuv.ai · License: AGPL-3.0
> 中文版 / Chinese version: [`PROJECT_PLAN.zh-CN.md`](./PROJECT_PLAN.zh-CN.md)

**pvuv.ai** is a self-hosted, privacy-conscious web analytics platform running on Cloudflare Workers + D1. It combines full-dimension traffic analytics (multi-site, multi-subdomain, per-page PV/UV, referrers, UTM & all tracking params, bounce rate, dwell time, custom events with revenue, session- and user-level attribution) with a three-layer invalid-traffic (bot) detection system and an optional ad-protection layer that loads ad code only for traffic judged trustworthy.

> **Open-source notes (read §21–§22 first).** This document lives in a public repo. Any concrete scoring weights, thresholds, or blocklists are **example defaults only** — real production values belong in a gitignored private config, never committed. **No secrets in the repo, ever.**

---

## 0. One-line positioning

A self-hosted, privacy-friendly web analytics platform stacking three capabilities:

1. **Full-dimension analytics** — PV/UV per page across multiple sites and subdomains; referrers, UTM and all tracking params; bounce rate; dwell time; custom events (incl. payment amount); session- and user-level full-path attribution.
2. **Invalid-traffic detection** — three layers: client signals (single point) + session features (stitching) + population statistics (batch). Every hit gets a 0–100 score and a record of which signals fired. Includes cross-site detection.
3. **Ad protection (optional)** — loads ad code only when traffic is judged trustworthy; progressive verdict (accurate blocking from the second page onward) reduces the drag of invalid traffic on ad accounts.

Data is consumed by three parties: the site-owner dashboard, an external ranking/scoring system (optional), and AI analysis reports.

---

## 1. Domain & endpoint layout

Split into **exposed** (embedded on measured sites; may end up on blocklists over time) and **internal** (dashboard/API; never embedded). Addresses below are reference deployment values — adapt to your own domain.

| Class | Component | Address | Notes |
|---|---|---|---|
| Exposed | SDK script | `https://js.pvuv.ai/f.js` (versioned `/f.v1.js`) | Static, long cache, CDN |
| Exposed | Ingest | `POST https://in.pvuv.ai/in` | Hot path, minimal & fast |
| Exposed | Fast verdict | `POST https://in.pvuv.ai/v` | Ad-load decision |
| Internal | Query API | `https://api.pvuv.ai/v1/...` | Shared by dashboard/ranking/AI |
| Internal | Console | `https://pvuv.ai/` (apex) | Owner login, dashboards |

**Design points**

- Exposed subdomains (`js`, `in`) are isolated from internal (`api`, apex console): if an exposed subdomain hits a blocklist, the dashboard and API are unaffected.
- The API uses the `api.pvuv.ai` subdomain — no separate registered domain needed (it is not embedded on measured sites, so it won't be blocklisted; the address is a route binding, so moving it to a standalone domain later is a zero-code change).
- Naming avoids blocklist keywords (stat/track/analytics/collect/event/pixel/count). Script `f.js`, ingest `/in`, verdict `/v` are all neutral.
- A `data-api` attribute lets owners point the SDK at a self-hosted reverse proxy (see §12).

**Embed snippet**

```html
<script defer src="https://js.pvuv.ai/f.js"
        data-site="Ab3xK9pQ"
        data-adguard="balanced"
        data-adclient="ca-pub-xxxxxxxxxxxxxxxx"></script>
```

Optional attributes: `data-spa="true"` (listen to pushState routing), `data-api` (custom ingest address), `data-exclude="/admin/*"` (path exclusion), `data-sensors="off"` (disable mobile sensor signals for compliance, see §4.6).

---

## 2. Tech stack (Cloudflare suite)

- **Workers**: ingest (`/in` `/v`), api (`/v1/*`), console, consumer (Queue consumer — scoring & persistence), cron (scheduled rollups & batch analysis).
- **D1**: primary database (SQLite). Raw event tables are partitioned by month to work around single-DB size limits.
- **Queue**: `/in` enqueues on receipt; the consumer batch-writes to D1 to absorb spikes.
- **KV**: blocklist, site-config cache (for edge reads at `/v`). HMAC keys via Workers Secrets.
- **Cron Triggers**: hourly rollup + profile updates; daily population analysis + blocklist refresh + AI reports.
- **R2** (M2+, optional): archive old-month raw events, host static assets.
- **Static hosting**: `js.pvuv.ai` via Workers Static Assets or R2 + CDN, `f.js` long-cached.

**Data flow**

```
browser (f.js)
  → in.pvuv.ai/in  (Worker: validate + server-side enrichment + realtime first-pass scoring)
  → Queue
  → consumer Worker (batch-write D1 events / incrementally update sessions)
  → Cron hourly → rollup pre-aggregation tables
  → Cron daily → population analysis → re-verdict + write KV blocklist (loops back to /v)
```

---

## 3. Identity system (foundation)

Four ID layers: `site_id → visitor_id → session_id → user_id`.

- **site_id**: assigned at site registration, 8-char random string. One site can bind multiple domains/subdomains (`allowed_domains` whitelist, prevents spoofing/data injection).
- **visitor_id**: UUID, generated on first visit. Written to a first-party cookie `_pv_id` (`domain=.example.com` to share across subdomains), backed up in localStorage. 13-month lifetime.
- **session_id**: UUID. A new session starts on any of: 30 min inactivity / UTM change / calendar-day rollover. Stored in cookie `_pv_sid` + last-active timestamp.
- **user_id**: bound after `identify()`. The `identities` table maintains a user↔visitor map, merging one user's multiple visitor_ids across devices/sessions.
- **First-touch attribution snapshot**: on first visit, referrer + UTM are stored in cookie `_pv_ft` (never overwritten). Conversion events carry both first-touch and last-touch attribution.
- **Verdict-state cookie** `_pv_v`: HMAC-signed; holds current verdict, pages seen, whether interaction occurred, and previous-page dwell — tamper-proof on the client, used by `/v` for re-checks.

---

## 4. Collection SDK (f.js)

### 4.1 Automatic collection (zero-config)

- **pageview**: on load + on SPA route change (`data-spa`).
- **page_leave**: `visibilitychange` + `pagehide`, sent via `sendBeacon`, carrying `duration_ms` (true visible dwell) and `scroll_depth`. Bounce rate and dwell time are computed from this event.
- **outbound_click**: external-link clicks.

### 4.2 JS API

```js
pvuv.track('signup', { plan: 'free' });
pvuv.track('purchase', { revenue: 49.9, currency: 'USD', order_id: 'x', product: 'pro_yearly' });
pvuv.identify('user_123', { plan: 'pro' });
pvuv.reset();
```

`revenue` + `currency` are reserved fields; the server converts to `revenue_usd` at the daily FX rate and stores a copy for cross-site/ranking comparison.

### 4.3 Collected fields

URL (server parses path/hostname/UTM/click_id), referrer, the three IDs, screen width/height, language, custom properties, `duration_ms`/`scroll_depth`, and whether/when the first interaction occurred.

### 4.4 Authenticity signal collection (field names obfuscated as x1/x2…)

> Weights are in §6.2 and are **example defaults**; real values live in a private config (§21).

**Cheap checks (every time, microseconds):** `navigator.webdriver`; automation residue globals (`_phantom`/`__nightmare`/`$cdc_*`/`callPhantom`); Chrome UA but `window.chrome` missing; empty `navigator.languages`; desktop UA but `plugins.length===0`; screen contradictions (screen equals innerWidth/Height exactly / 800×600 / colorDepth===0); device contradictions (mobile UA but maxTouchPoints===0; abnormal hardwareConcurrency/deviceMemory); timezone contradiction (Intl timeZone vs server `cf.timezone`); language contradiction.

**Expensive checks (sampled via `requestIdleCallback`, cached):** WebGL renderer (SwiftShader/llvmpipe/Mesa OffScreen = software rendering); canvas render hash (detects one environment masquerading as many visitors); permission contradiction (Notification.permission=denied but permissions.query returns prompt).

**Behavioral signals (record only whether-it-happened + first-time, no trajectories):** first mousemove/touchstart/scroll/keydown; whether page_leave was sent; honeypot link (CSS-hidden; invisible to humans, some crawlers follow it).

### 4.5 adguard ad-protection module

After a passing verdict, **dynamically inject** `adsbygoogle.js` (decide *whether* to inject only; **never modify** Google's script behavior — a policy red line). Logic in §7.

### 4.6 Mobile sensor signals (signal, not fingerprint — privacy-safe)

**Platform reality (2026).** On iOS (Safari and all iOS browsers), accessing DeviceMotion/DeviceOrientation has required `requestPermission()` since iOS 13 — it must be triggered by a user gesture and shows a prompt; the Generic Sensor API (Accelerometer/Gyroscope) is unsupported on iOS entirely. On Android Chrome, a same-origin top-level document in a secure context with the page visible can read these **without a prompt**.

**Principles for this project:**

- **Never prompt for permission just for analytics**, and never collect raw sensor streams for fingerprinting. (Sensor data is a well-documented covert-fingerprinting / side-channel source; silent collection crosses privacy-compliance lines and accelerates blocklist inclusion.)
- Use only as a **coarse, passive, Android-only** bot signal: briefly listen to `devicemotion` (no prompt) and extract only booleans —
  - `has_motion`: mobile UA but zero motion events during the window → suspicious.
  - `motion_static`: `accelerationIncludingGravity` perfectly constant across samples, no micro-jitter → emulator/headless trait.
- Store only these two flags; no raw readings, no sensor fingerprint.
- Skip sensor signals on iOS; rely on other signals.
- Implementation: `try/catch` + permissions-policy detection, fail silently; gated by `data-sensors="off"` (on by default; can be turned off in compliance-sensitive regions).
- New bot_flags bits: `0x1000 mobile UA but no motion data (Android)`, `0x2000 motion readings perfectly static`.

---

## 5. Ingest endpoint /in

```
POST https://in.pvuv.ai/in
Content-Type: text/plain        ← avoids CORS preflight, halves request count
Body: JSON (single or array; SDK batches ≤10 events or every 3s)
```

**Single event shape**

```json
{
  "s": "Ab3xK9pQ", "e": "pageview",
  "u": "https://a.com/pricing?utm_source=x", "r": "https://google.com/",
  "vid": "...", "sid": "...", "uid": "...",
  "sw": 1920, "sh": 1080, "lang": "zh-CN",
  "p": { "...": "..." }, "d": 45200,
  "x": { "x1": 0, "x2": 1, "...": "..." },
  "ts": 1752000000000
}
```

**Server-side enrichment (not sent by client, anti-forgery):** geo (`request.cf`); ASN (`cf.asn` → datacenter DB → asn_type); UA parse (browser/os/device_type); IP stored only as a truncated SHA256 hash + /24 segment hash; URL parsed into UTM and click_id (gclid/fbclid/ttclid/msclkid/ref) as dedicated columns, the rest into `extra_params`.

**Validation:** compare `Origin`/`Referer` against the site's `allowed_domains`; drop on mismatch.

**Realtime first-pass scoring:** write all four anti-fraud fields (§6.2), `score_stage='realtime'`. Keep the endpoint minimal and fast; heavy analysis runs on the consumer.

---

## 6. Invalid-traffic detection (three layers)

> **Open-source note.** This section describes architecture and the signal catalog (client-side anti-fraud cannot be hidden from anyone reading the code; openness aids transparency and auditing). But **concrete weights, thresholds, and blocklists** are evadable tuning parameters — keep them in a private config; commit only example defaults (§21).

### 6.1 Three signal layers

1. **Server-side signals (most reliable):** datacenter ASN, known crawler/script UA, request-header completeness (missing or contradictory Sec-Fetch / Sec-CH-UA), protocol layer (HTTP/TLS version), timing regularity.
2. **Client environment signals:** see §4.4 and §4.6.
3. **Behavioral signals (hardest to fake, highest weight):** presence of interaction, missing page_leave, dwell distribution, honeypot trigger.

### 6.2 Scoring & persisted fields

| Field | Type | Meaning |
|---|---|---|
| `bot_score` | INTEGER | 0–100 |
| `verdict` | TEXT | clean / suspect / bot / crawler |
| `bot_flags` | INTEGER | bitmap of fired signals (one INT = 32 bits) |
| `score_stage` | TEXT | realtime / session / batch |

**bot_flags bit definitions & example weights** (weights are initial defaults only; externalize to config)

| Value | Signal | Example weight |
|---|---|---|
| 0x0001 | webdriver=true | hard → 100 |
| 0x0002 | automation residue | hard → 100 |
| 0x0004 | UA/ClientHints contradiction | +25 |
| 0x0008 | datacenter ASN | +35 |
| 0x0010 | Sec-Fetch header missing | +25 |
| 0x0020 | timezone/IP contradiction | +20 |
| 0x0040 | zero interaction, no page_leave | +20 |
| 0x0080 | software-rendered WebGL | +15 |
| 0x0100 | mechanical timing regularity | +15 |
| 0x0200 | matches blocklisted cluster | +40 |
| 0x0400 | honeypot triggered | hard → 100 |
| 0x0800 | screen/device contradiction | +10 each |
| 0x1000 | mobile UA but no motion data (Android) | +15 |
| 0x2000 | motion readings perfectly static | +10 |
| — | residential/mobile ASN + interaction + page_leave | trust credit −10 each |

**Example bands:** 0–29 clean │ 30–69 suspect │ 70+ bot. Verified crawlers are classified separately. `score_stage` records which pass assigned the score, so the UI can show the "first-pass → batch re-verdict" change.

### 6.3 Session layer (hourly Cron)

Stitch events into sessions; compute session-level features (inter-page interval, path pattern, zero-interaction/no-leave); correct the verdict (`score_stage='session'`).

### 6.4 Population layer batch analysis (daily Cron) — find "the same hand"

Single hits look real; batch fraud reveals itself in group statistics.

**Timing regularity:** per-visitor inter-event coefficient of variation CV (humans >1, timer-driven scripts approach 0); a 24-hour diurnal curve in the target timezone (cosine similarity to historical baseline); autocorrelation of hourly PV series to find fixed periods.

**Distribution-shape tests** (real traffic is long-tailed; fabricated is flat or over-concentrated): compute entropy and concentration over UA / resolution / dwell / session depth / landing page / return ratio, compare to baseline. Beware both extremes — too tidy and too random are both abnormal.

**Cluster analysis:** fingerprint clusters `GROUP BY fp_hash HAVING COUNT(DISTINCT visitor_id) > threshold`; IP-segment clusters (/24 contribution share + ASN surges); behavior-sequence clusters (path + per-page dwell discretized into a signature string); cookie-reset detection (same IP segment + same fingerprint but ever-changing visitor_id, each appearing once).

**Baseline & anomaly:** per-site per-dimension rolling baseline (EWMA + MAD, outlier-robust). PV/UV surge with simultaneous shift in source/geo/device structure → suspicious; a utm_campaign appearing out of nowhere with large volume but zero conversions → suspicious. New sites without a baseline fall back to a peer-group baseline.

**Cross-site analysis:** the same fingerprint/IP segment sweeping multiple sites in a short window → global block. Three safeguards for the cross-site blocklist: prefer fingerprint clusters + behavioral evidence (use bare IP cautiously — CGNAT/campus networks cause false positives); entries carry TTL and decay (default 7–30 days; permanent only for hard-signal proof); share verdicts only, not behavioral data.

**Output:** confirmed clusters are written to the KV blocklist (loops back to `/v`); historical events of confirmed clusters are re-verdicted in batch (`score_stage='batch'`), and affected rollups are recomputed incrementally.

### 6.5 Implementation notes

It's essentially `GROUP BY + aggregate + HAVING` (D1's comfort zone); entropy/CV operators run in the Worker in JS and store results as columns; per-visitor interval stats use **Welford's online algorithm** for incremental updates; path-signature clustering is sharded per site.

### 6.6 Handling strategy

Bot: auto-excluded (not in the clean bucket). Suspect: counted but down-weighted and flagged; reviewed by hand before settlement. Auto-reverdict thresholds are set conservatively; gray areas are left for humans — a false positive on real traffic hurts credibility more than letting a bot through.

---

## 7. Ad protection (adguard progressive verdict)

### 7.1 Core idea

Fast allow/block on the first page is the "first pass"; each additional in-session event adds evidence; from the second page it's a "re-check". A fraudster gets at most one homepage impression, never sustained impressions.

### 7.2 Decision path

```
page load → f.js local hard checks (<1ms)
  ├ hard signal hit → never load ads
  ├ signed cookie (_pv_v, last verdict clean) → load immediately
  └ new visitor → in parallel:
       ① POST in.pvuv.ai/v fast verdict (edge, target <80ms)
       ② listen for first human interaction
     decide by mode:
       loose: only ①, load if no response within 300ms (fail-open, protect revenue)
       balanced (default): ① passes OR ② occurs → load
       strict: ① passes AND ② occurs → load
```

The verdict is HMAC-signed into `_pv_v`, so returning visitors incur zero latency.

### 7.3 Progressive blocking points

| Stage | Block point |
|---|---|
| First session | From page 2 (behavioral evidence) |
| Return visit | Page 1 (cookie holds verdict) |
| Clear cookie, return | Page 1 (fingerprint/IP-segment cluster in KV blocklist) |
| Switch sites and re-farm | Page 1 (cross-site blocklist applies globally) |

The block point is the "next page"; already-loaded ads are not pulled (avoids layout shift, no benefit).

### 7.4 Key details

- "Load after interaction" itself filters most bots, and ads don't participate in first paint → improves LCP/INP (free Core Web Vitals gains).
- **Verified crawlers: allow the page, don't load ads.** Googlebot and Mediapartners-Google must crawl content normally but never need the ad script anyway.
- Suspect gray area: load but delayed + require stronger interaction evidence (e.g. inject only after scrolling past one screen).
- **Fail-open fallback:** verdict timeout / f.js error / KV down → always default to loading ads. Better to miss a block than to cost the owner revenue.
- **Boundary:** used only to filter invalid traffic; no "load only for high-click-propensity users" style manipulation; never modify Google's script. This is a protection layer, not an exemption; its core added value is blocking + bad-traffic source attribution.

### 7.5 Thresholds belong to the owner (platform provides capability + impact estimate)

Three presets (loose/balanced/strict) + custom (score slider + per-signal toggles). **Shadow mode:** newly onboarded sites record-only for the first 7 days, showing "at the current tier this would have blocked X%, with this source distribution"; any threshold change previews a backtested impact before taking effect. Each tier shows a live estimated block rate and estimated false-positive rate (estimated from "share of blocked traffic that shows human interaction traits").

---

## 8. Fast verdict endpoint /v

```
POST https://in.pvuv.ai/v
Body: { s, vid, sid, x{...}, state (from signed cookie) }
```

All lookups are edge-local: `cf.asn` for datacenter, request-header completeness, KV blocklist. Target <80ms. The request carries a signed-cookie session-state summary, so the second-page verdict stacks behavioral evidence. Returns verdict + whether to allow ads; writes back `_pv_v`.

---

## 9. Storage architecture & database schema

### 9.1 Layers

- **Raw layer:** `events_YYYYMM` monthly-partitioned; `sessions`; `identities`; `visitor_profiles`.
- **Aggregate layer:** `rollup_page_daily`, `rollup_source_daily`, `rollup_site_daily`. Dashboards hit aggregate tables 95% of the time.

### 9.2 D1 schema (M1 DDL)

```sql
-- users
CREATE TABLE users (
  user_id     TEXT PRIMARY KEY,
  email       TEXT UNIQUE,
  name        TEXT,
  created_at  INTEGER NOT NULL,
  status      TEXT DEFAULT 'active'
);

-- sites
CREATE TABLE sites (
  site_id         TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  owner_id        TEXT NOT NULL,
  allowed_domains TEXT NOT NULL,             -- JSON array
  adguard_mode    TEXT DEFAULT 'off',        -- off/loose/balanced/strict/custom
  adguard_config  TEXT,                      -- JSON custom thresholds/toggles
  adclient        TEXT,                      -- ca-pub-xxx
  settings        TEXT,
  created_at      INTEGER NOT NULL,
  status          TEXT DEFAULT 'active'
);

-- raw events (monthly-partitioned; example 202607)
CREATE TABLE events_202607 (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id       TEXT NOT NULL,
  event         TEXT NOT NULL,
  visitor_id    TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  user_id       TEXT,
  url           TEXT NOT NULL,
  hostname      TEXT NOT NULL,
  path          TEXT NOT NULL,
  referrer      TEXT,
  ref_domain    TEXT,
  utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, utm_term TEXT, utm_content TEXT,
  click_id TEXT, click_id_type TEXT,
  extra_params TEXT,
  country TEXT, region TEXT, city TEXT,
  browser TEXT, os TEXT, device_type TEXT,
  screen_w INTEGER, screen_h INTEGER,
  lang TEXT,
  ip_hash TEXT, ip24_hash TEXT,
  asn INTEGER, asn_type TEXT,
  fp_hash TEXT,
  duration_ms INTEGER, scroll_depth INTEGER, had_interaction INTEGER DEFAULT 0,
  revenue REAL, revenue_usd REAL, currency TEXT,
  props TEXT,
  ft_source TEXT, ft_medium TEXT, ft_campaign TEXT, ft_referrer TEXT,
  bot_score INTEGER DEFAULT 0,
  verdict TEXT DEFAULT 'clean',
  bot_flags INTEGER DEFAULT 0,
  score_stage TEXT DEFAULT 'realtime',
  ts INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_ev0_site_ts ON events_202607(site_id, ts);
CREATE INDEX idx_ev0_visitor ON events_202607(site_id, visitor_id);
CREATE INDEX idx_ev0_session ON events_202607(session_id);
CREATE INDEX idx_ev0_verdict ON events_202607(site_id, verdict, ts);
CREATE INDEX idx_ev0_path    ON events_202607(site_id, path);

-- sessions
CREATE TABLE sessions (
  session_id   TEXT PRIMARY KEY,
  site_id      TEXT NOT NULL,
  visitor_id   TEXT NOT NULL,
  user_id      TEXT,
  entry_page   TEXT, exit_page TEXT,
  pageviews INTEGER DEFAULT 0, events_count INTEGER DEFAULT 0,
  duration_ms INTEGER DEFAULT 0, had_interaction INTEGER DEFAULT 0,
  is_bounce INTEGER,
  source TEXT, medium TEXT, campaign TEXT, referrer TEXT,
  country TEXT, device_type TEXT,
  bot_score INTEGER DEFAULT 0, verdict TEXT DEFAULT 'clean', bot_flags INTEGER DEFAULT 0,
  started_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL
);
CREATE INDEX idx_sess_site ON sessions(site_id, started_at);
CREATE INDEX idx_sess_visitor ON sessions(site_id, visitor_id);

-- identity map
CREATE TABLE identities (
  site_id TEXT NOT NULL, user_id TEXT NOT NULL, visitor_id TEXT NOT NULL,
  traits TEXT, first_seen INTEGER, last_seen INTEGER,
  PRIMARY KEY (site_id, user_id, visitor_id)
);

-- visitor profiles (incrementally updated by batch analysis)
CREATE TABLE visitor_profiles (
  site_id TEXT NOT NULL, visitor_id TEXT NOT NULL,
  events_count INTEGER DEFAULT 0, sessions_count INTEGER DEFAULT 0,
  interval_mean REAL, interval_m2 REAL, interval_cv REAL,
  active_hours INTEGER,
  fp_hash TEXT, ip24_hash TEXT, asn INTEGER,
  bot_score INTEGER DEFAULT 0, verdict TEXT DEFAULT 'clean',
  first_seen INTEGER, last_seen INTEGER,
  PRIMARY KEY (site_id, visitor_id)
);
CREATE INDEX idx_vp_fp   ON visitor_profiles(fp_hash);
CREATE INDEX idx_vp_ip24 ON visitor_profiles(ip24_hash);

-- daily rollups (with clean bucket)
CREATE TABLE rollup_page_daily (
  site_id TEXT, day TEXT, hostname TEXT, path TEXT,
  pv INTEGER DEFAULT 0, uv INTEGER DEFAULT 0, sessions INTEGER DEFAULT 0,
  bounces INTEGER DEFAULT 0, total_duration_ms INTEGER DEFAULT 0,
  pv_clean INTEGER DEFAULT 0, uv_clean INTEGER DEFAULT 0,
  PRIMARY KEY (site_id, day, hostname, path)
);
CREATE TABLE rollup_source_daily (
  site_id TEXT, day TEXT, source TEXT, medium TEXT, campaign TEXT,
  pv INTEGER DEFAULT 0, uv INTEGER DEFAULT 0, sessions INTEGER DEFAULT 0,
  conversions INTEGER DEFAULT 0, revenue_usd REAL DEFAULT 0,
  pv_clean INTEGER DEFAULT 0, uv_clean INTEGER DEFAULT 0,
  PRIMARY KEY (site_id, day, source, medium, campaign)
);
CREATE TABLE rollup_site_daily (
  site_id TEXT, day TEXT,
  pv INTEGER DEFAULT 0, uv INTEGER DEFAULT 0, sessions INTEGER DEFAULT 0,
  bounce_rate REAL, avg_duration_ms INTEGER,
  bot_count INTEGER DEFAULT 0, suspect_count INTEGER DEFAULT 0,
  crawler_count INTEGER DEFAULT 0, clean_count INTEGER DEFAULT 0,
  conversions INTEGER DEFAULT 0, revenue_usd REAL DEFAULT 0,
  PRIMARY KEY (site_id, day)
);

-- clusters / anomalies / AI (M2+, tables created in M1 as placeholders)
CREATE TABLE cluster_flags (
  cluster_id TEXT PRIMARY KEY, site_id TEXT,
  type TEXT, member_count INTEGER, evidence TEXT,
  action TEXT DEFAULT 'observe', created_at INTEGER, expires_at INTEGER
);
CREATE TABLE anomaly_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT, day TEXT, dimension TEXT,
  baseline REAL, actual REAL, deviation REAL,
  related_cluster TEXT, evidence TEXT,
  status TEXT DEFAULT 'pending', created_at INTEGER
);
CREATE TABLE ai_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT, period TEXT, kind TEXT,
  content TEXT, data_snapshot TEXT, created_at INTEGER
);
```

### 9.3 Key definitions

- **Bounce rate (inverse definition, à la GA4):** a session with a second pageview, or dwell ≥10s, or any custom event = an engaged session; bounce rate = 1 − engagement rate.
- **Clean bucket:** rollups track both total and clean (excluding bot/crawler). Dashboards default to clean, switchable. Verified crawlers counted separately.
- **Retention:** raw events kept 30–90 days for drill-down; older data keeps only aggregates and cluster records. Attribution/fingerprints stored as hashes only, never raw fingerprint values.

---

## 10. Query API

Base: `https://api.pvuv.ai/v1`

```
GET /sites/:id/overview?period=30d
GET /sites/:id/timeseries?metric=pv&interval=day
GET /sites/:id/breakdown?dim=page|source|utm_campaign|country|device&period=...&filter=...
GET /sites/:id/funnel?steps=pageview:/pricing,signup,purchase
GET /sites/:id/visitors/:vid/sessions
GET /sites/:id/sessions/:sid/events
GET /sites/:id/visitors/:vid/profile
GET /sites/:id/attribution?event=purchase&model=first|last|last_non_direct
GET /sites/:id/quality?period=30d
GET /sites/:id/traffic?verdict=bot&min_score=70&period=...
```

Breakdown supports multi-dimension combined filtering. External ranking systems and AI analysis reuse the same API. Auth: owners query only their own site; external systems/AI use a server-side token.

---

## 11. Console (pvuv.ai)

### 11.1 Traffic dashboard

Overview metric cards, time-series, source/page/UTM/geo/device breakdowns, funnels, visitor→session→event drill-down timeline.

### 11.2 Traffic-quality panel

**Overview:** clean/suspect/bot/crawler donut; daily bot-share trend; one-line alert.
**List:** filterable/sortable detail (score-range slider, verdict, specific flag, source, UTM, country, time range; default sorted by score desc, red/amber/green scale).
**Drill-down** (behavior reconstruction for high-score traffic): ① verdict-evidence card (each fired signal + measured vs normal value); ② session timeline (mechanical equidistant page intervals, abnormally regular paths flagged red); ③ population linkage (`this fingerprint links N visitors across M sites`).

### 11.3 Restrained framing

Verified crawlers classified separately, not mixed into bot share; suspect shown amber (uncertain, not confirmed); avoid a wall of red that makes newcomers think they're being flooded.

### 11.4 Permissions

Owners can view/filter/export data, but **re-verdict authority stays with the platform** (via population analysis + human review); owners cannot manually re-verdict (otherwise ad-protection data loses meaning).

### 11.5 Ad-protection panel

Block-volume trend, block-reason distribution, **top source channels of blocked traffic** (highest action value), shadow-mode backtest, mode switching.

---

## 12. Reverse proxy / first-party option (advanced, blocklist-resistant)

Third-party analytics domains eventually hit blocklists at scale. Advanced option: owners reverse-proxy `f.js` and the ingest endpoint through a Cloudflare Worker on their own domain, turning requests into true first-party ones and largely immunizing against blockers. Point the SDK's `data-api` at the self-hosted proxy. The repo ships a proxy-Worker config template and docs. Default is direct embed; those who want accuracy configure the proxy.

---

## 13. AI-powered analysis

Scheduled (daily/weekly Cron) + on-demand (dashboard button). Assemble structured JSON (traffic trends, top-source changes, high-bounce pages, funnel drop-offs, anomaly/cluster evidence), call the Claude API, and store reports in `ai_reports`. Fixed output format: **data anomaly → attribution judgment → 3 actionable recommendations** (each with expected impact + priority). Feed anomaly/review evidence JSON to the model to produce a plain-language "why flagged as suspicious" explanation for the review UI. The API key goes through Workers Secrets, never into the repo.

---

## 14. External ranking / scoring integration (optional)

The platform bundles no specific program mechanics, but the Query API (§10) is sufficient to support an external ranking/scoring system:

- Sites join the data flow simply by embedding f.js.
- Ranking/scoring uses **filtered (clean) data**; anomaly detail is retained for human review.
- Optionally distinguish "internal/trusted-source traffic" from "external organic traffic" so trusted mutual visits don't affect rankings.
- Settlement: bots auto-excluded, suspects down-weighted + human-reviewed.

This is an optional adapter layer; the core platform does not depend on it.

---

## 15. Anti-fraud engineering notes (summary)

1. Detection field names are obfuscated (x1/x2…); weights and verdict logic live server-side; weights/thresholds externalized to a private config.
2. Expensive checks run via `requestIdleCallback` so they don't slow the measured site's Core Web Vitals.
3. Fingerprints are used only for scoring, not cross-site visitor linking; raw fingerprints never persisted — only hashes and conclusions.
4. Verified crawlers are classified separately; Googlebot requires reverse-DNS verification against spoofing.
5. Scoring runs on the Queue consumer (combining a visitor's historical events for timing analysis); `/in` stays minimal.
6. Mobile sensors are used only as a coarse signal, Android-only, passive, and disableable (§4.6).
7. Goal: don't aim to be unbeatable — make forgery uneconomical, with human review as the backstop for real-device/real-human farming.

---

## 16. Privacy & compliance

- IP stored only as a truncated SHA256 hash + /24 segment hash, never plaintext.
- Device fingerprints stored only as hashes and conclusions, never raw values; no cross-site visitor profiling (anti-fraud use only).
- Verdict-evidence cards show conclusions and trigger values only, never a full fingerprint.
- Sensors are used only as a coarse anti-fraud signal — no raw streams, no sensor fingerprint; a `data-sensors="off"` toggle is provided.
- **Compliance note (for deployers):** in GDPR/ePrivacy jurisdictions, device fingerprints and sensor signals may fall under consent requirements. The project ships data-minimizing defaults and disable toggles; specific compliance responsibility rests with each deployer per their jurisdiction (a cookieless mode and fingerprint/sensor opt-outs should be documented).
- No ads by default, no selling data to third parties; data belongs to each deployer.

---

## 17. Milestones

| Milestone | Scope |
|---|---|
| **M1** (first deployable) | f.js (collection + hard checks + adguard progressive load + Android sensor signals); `/in` (with realtime first-pass scoring, writes four fields); `/v` fast verdict; D1 base tables; minimal console (PV/UV/sources/top pages + traffic-quality overview) |
| **M2** | Sessions/dwell/bounce, full UTM dimensions, rollup acceleration, population analysis (fingerprint/IP-segment clusters + blocklist loop), shadow mode, reverse-proxy option |
| **M3** | identify + custom events + revenue + funnel attribution; distribution tests + baseline anomalies |
| **M4** | AI reports + full anti-fraud + external ranking integration + human-review UI |

---

## 18. M1 delivery scope (Claude Code's first milestone)

**Goal:** a minimal deployable loop for internal testing.

Must-have:
1. **f.js**: pageview + page_leave (duration/scroll) auto-collection; cheap hard checks + Android sensor signals; adguard balanced-mode progressive load (hard-signal block + load-after-interaction); cookie state machine (`_pv_id`/`_pv_sid`/`_pv_ft`/`_pv_v`, HMAC-signed); batched reporting (text/plain).
2. **ingest Worker (in.pvuv.ai)**: `/in` whitelist validation + server-side enrichment + realtime first-pass scoring (writes all 4 fields) + enqueue; `/v` fast verdict.
3. **consumer Worker**: batch-write events from Queue + incrementally update sessions/identities/visitor_profiles.
4. **cron Worker**: hourly rollup (page/source/site daily, with clean bucket).
5. **api Worker (api.pvuv.ai)**: overview / timeseries / breakdown / quality / traffic / visitor profile.
6. **console (pvuv.ai)**: login, site registration (issue site_id + embed snippet), traffic dashboard, traffic-quality overview + high-score drill-down.
7. **D1 schema**: create all tables from §9.2 (including M2+ tables as placeholders).

May skip in M1 (create tables / stub endpoints only): population batch analysis, distribution tests, AI reports, funnels, shadow-mode backtest.

---

## 19. Repository layout (monorepo, preserve directory hierarchy)

```
pvuv.ai/
├── LICENSE                        # AGPL-3.0 (see §22)
├── README.md                      # bilingual: intro / architecture / deploy
├── CONTRIBUTING.md
├── SECURITY.md
├── .gitignore                     # node_modules/.dev.vars/.env/config.local.*/dist scratch
├── PROJECT_PLAN.md                # this document (EN)
├── PROJECT_PLAN.zh-CN.md          # Chinese version
├── config.example.toml            # example weights/thresholds (real values in config.local.*, gitignored)
├── wrangler.toml                  # placeholder account_id / binding names, no secrets
├── package.json
├── sdk/
│   ├── src/f.ts
│   ├── build.mjs
│   └── dist/f.js                  # deploys to js.pvuv.ai
├── workers/
│   ├── ingest/   (src/index.ts, enrich.ts, score.ts, wrangler.toml)   # in.pvuv.ai
│   ├── consumer/ (src/index.ts, wrangler.toml)
│   ├── api/      (src/index.ts, wrangler.toml)                          # api.pvuv.ai
│   ├── console/  (src/index.ts, public/, wrangler.toml)                 # pvuv.ai
│   └── cron/     (src/rollup.ts, src/batch.ts, wrangler.toml)
├── shared/
│   ├── schema.sql
│   ├── flags.ts                   # bot_flags bit definitions (shared front/back)
│   ├── ids.ts                     # ID generation / cookies / HMAC
│   └── asn.ts                     # datacenter ASN detection
└── migrations/
```

**Conventions:** prefer single-file plain HTML for the console frontend to avoid framework debugging overhead; never add `<meta name="keywords">` to any HTML `<head>`; KV names `BLOCKLIST`/`SITE_CONFIG`, Queue `INGEST_QUEUE`, HMAC keys via Workers Secrets; preserve the directory hierarchy in delivered archives (don't flatten).

---

## 20. Non-goals / boundaries

- Don't modify Google's ad script; only decide whether to inject (policy red line).
- No manipulative logic like "load only for high-click-propensity users".
- Don't chase 100% block rate; make forgery uneconomical + human review as backstop.
- Doesn't replace Google's server-side IVT judgment; it's a protection layer, not an exemption.
- No raw sensor streams; no sensor/cross-site visitor fingerprinting.

---

## 21. Open-source note: externalize evadable parameters

A public repo can't hide client-side logic from anyone reading the code, so the project uses a "code open, tuning private" strategy:

- **Committed:** architecture, signal catalog, endpoints, schema, example default weights/thresholds (`config.example.toml`).
- **Not committed (gitignored):** production weights/thresholds/blocklist/tuning (`config.local.*`), any secret, `.dev.vars`, real `wrangler` account_id.
- The scoring engine reads weights from config; code hardcodes no production values; each deployer can tune privately without exposing it to fraudsters.
- A public anti-fraud architecture aids community auditing and trust and fits the privacy-tool positioning; the real asymmetric advantage lies in private tuning + a cross-deployment blocklist, not in hiding the algorithm.

---

## 22. License & security

**License: AGPL-3.0.** Rationale: it permits self-hosting and free use, but anyone (including those offering it as a SaaS) who modifies it must open-source their changes — preventing others from turning this project into a closed-source commercial competitor, while not affecting self-hosting users. Open-source analytics tools that also commercialize (Plausible / Umami / PostHog) all use this license.

**Pre-open-source security checklist (confirm every item):**
- [ ] No secrets anywhere in the repo (HMAC key, Cloudflare token, AI API key, `.dev.vars`)
- [ ] `.gitignore` includes `node_modules`, `.dev.vars`, `.env`, `config.local.*`, `dist` scratch
- [ ] `wrangler.toml` uses placeholders; real account_id / binding IDs stay out of the repo
- [ ] All secrets go through `wrangler secret put`
- [ ] No secrets in commit history (scan with `git log -p` / gitleaks; if ever committed, rotate before open-sourcing)
- [ ] `SECURITY.md` provides a vulnerability-reporting channel
- [ ] README states compliance boundaries and deployer responsibility (§16)
