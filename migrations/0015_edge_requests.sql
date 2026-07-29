-- ============================================================================
-- Cloudflare edge request counts (optional) — PROJECT_PLAN.md §6.7
--
-- The JS beacon only ever sees requests that reached a real browser and ran
-- JavaScript. Everything else — AI crawlers, feed readers, scrapers, anything
-- that fetches HTML and never executes a script — is invisible to it by
-- construction.
--
-- If the deployer supplies a read-only Cloudflare API token, the daily cron
-- pulls per-day request counts from Cloudflare's GraphQL Analytics API
-- (httpRequestsAdaptiveGroups, available on every plan) and stores them here.
-- The interesting number is the GAP: edge HTML requests minus browser
-- pageviews, broken down by user agent.
--
-- Entirely optional. With no token these tables simply stay empty and every
-- other part of the product behaves exactly as before.
-- ============================================================================

-- one row per site per LOCAL day (the site's own timezone, same key as
-- rollup_site_daily) so edge counts line up with pageviews without arithmetic
CREATE TABLE rollup_edge_daily (
  site_id       TEXT NOT NULL,
  day           TEXT NOT NULL,          -- YYYY-MM-DD in the site's timezone
  requests      INTEGER DEFAULT 0,      -- all eyeball requests (assets included)
  html_requests INTEGER DEFAULT 0,      -- HTML responses only — comparable to pageviews
  zone_tag      TEXT,                   -- Cloudflare zone the numbers came from
  updated_at    INTEGER,
  PRIMARY KEY (site_id, day)
);

-- top user agents behind the HTML requests, so the gap has names attached
CREATE TABLE rollup_edge_agent_daily (
  site_id    TEXT NOT NULL,
  day        TEXT NOT NULL,
  user_agent TEXT NOT NULL,
  requests   INTEGER DEFAULT 0,
  PRIMARY KEY (site_id, day, user_agent)
);
CREATE INDEX idx_edge_agent_site_day ON rollup_edge_agent_daily(site_id, day, requests);
