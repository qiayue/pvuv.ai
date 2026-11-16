-- ============================================================================
-- Crawler / indexing signals — a SEPARATE metric for newly launched sites.
--
-- The early question for a new site is "has Googlebot (Bing, …) come yet, how
-- often, which pages". Raw crawler events cannot answer "first seen" for long:
-- retention trims bot/crawler rows after bot_events_days. These tables keep
-- the answer durably, at a cost of a few rows per site per day.
--
-- Filled by the cron worker (workers/cron/src/crawlers.ts):
--   * hourly rollup   — beacon crawler pageviews (crawlers that render JS)
--   * daily edge pull — Cloudflare's top user agents per day (any crawler,
--                       JS or not; only with the optional read-only CF token)
--   * a one-time, resumable backfill from data already present
-- All writes are idempotent (day rows replaced, milestones min/max-merged).
--
-- NOTHING here feeds PV/UV, scoring, verdicts or the ad-guard decision.
--
-- The events partitions gain a crawler_engine column (shared/events.ts
-- EVENT_LATE_COLUMNS). It is deliberately NOT added here: a migration can only
-- name partitions that existed when it was written, and the consumer/cron
-- repair adds it to every partition idempotently — an ALTER here would fail on
-- any partition that repair already reached.
-- ============================================================================

CREATE TABLE IF NOT EXISTS crawler_milestones (
  site_id       TEXT NOT NULL,
  engine        TEXT NOT NULL,          -- shared/crawlers.ts id: googlebot, bingbot, other_search, ...
  kind          TEXT NOT NULL,          -- search / ai / ads / seo / other
  first_seen_at INTEGER NOT NULL,       -- ms; edge-sourced = start of that local day
  last_seen_at  INTEGER NOT NULL,
  first_source  TEXT,                   -- beacon | edge
  first_path    TEXT,                   -- first page crawled (beacon only)
  updated_at    INTEGER,
  PRIMARY KEY (site_id, engine)
);
CREATE INDEX IF NOT EXISTS idx_crawler_ms_kind ON crawler_milestones(site_id, kind, first_seen_at);

CREATE TABLE IF NOT EXISTS rollup_crawler_daily (
  site_id  TEXT NOT NULL,
  day      TEXT NOT NULL,               -- YYYY-MM-DD in the site's timezone
  engine   TEXT NOT NULL,
  source   TEXT NOT NULL,               -- beacon | edge
  kind     TEXT NOT NULL,
  hits     INTEGER DEFAULT 0,
  pages    INTEGER,                     -- distinct paths (beacon only; NULL for edge)
  first_ts INTEGER, last_ts INTEGER,
  PRIMARY KEY (site_id, day, engine, source)
);

CREATE TABLE IF NOT EXISTS rollup_crawler_page_daily (
  site_id TEXT NOT NULL,
  day     TEXT NOT NULL,
  engine  TEXT NOT NULL,
  path    TEXT NOT NULL,
  hits    INTEGER DEFAULT 0,
  PRIMARY KEY (site_id, day, engine, path)
);
