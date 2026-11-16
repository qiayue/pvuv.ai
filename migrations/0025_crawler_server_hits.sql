-- ============================================================================
-- Server-side crawler reporting — the `server` source of the crawler metric
-- (0024), next to `beacon` and `edge`.
--
-- A site served by a Worker reports every crawler request it answers with
-- POST /v1/sites/{id}/crawler_hits, authenticated by a site-scoped ingest-only
-- token (api_tokens.permission = 'ingest', allowed since 0022). Those hits are
-- written ONLY here (shared/crawler_hits.ts):
--   * rollup_crawler_daily rows with source = 'server' (accumulated, not
--     replaced — the cron's beacon/edge rewrites never touch them)
--   * rollup_crawler_server_page_daily (paths; its own table because the
--     hourly beacon recompute replaces a day's rollup_crawler_page_daily whole)
--   * crawler_milestones (first_source may now be 'server')
--
-- NOTHING here feeds events, PV/UV, scoring, verdicts or the ad-guard decision.
-- ============================================================================

-- server source only (NULL for beacon/edge): hits answered with status >= 400,
-- and hits the reporting Worker marked as Cloudflare-verified (self-asserted)
ALTER TABLE rollup_crawler_daily ADD COLUMN error_hits INTEGER;
ALTER TABLE rollup_crawler_daily ADD COLUMN verified_hits INTEGER;

CREATE TABLE IF NOT EXISTS rollup_crawler_server_page_daily (
  site_id TEXT NOT NULL,
  day     TEXT NOT NULL,               -- YYYY-MM-DD in the site's timezone
  engine  TEXT NOT NULL,
  path    TEXT NOT NULL,               -- query string stripped, <= 512 chars
  hits    INTEGER DEFAULT 0,
  PRIMARY KEY (site_id, day, engine, path)
);
