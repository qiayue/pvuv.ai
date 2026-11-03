-- ============================================================================
-- Crawler categorisation (PROJECT_PLAN.md §6.6) — descriptive metadata only.
--
-- The deployer imports a public bot directory (Cloudflare Radar's bots-and-
-- agents catalogue or a mirror of it) in the console; the consumer matches each
-- event's User-Agent against it and records which KIND of crawler it was —
-- search / ai_training / seo / advertising / monitoring / …
--
-- This column NEVER feeds scoring, verdicts or the ad-guard decision. It exists
-- so an owner can see the composition of their crawler traffic (a search engine
-- that sends visitors is not the same thing as a training scraper) before any
-- policy is built on top of it.
--
-- Future monthly partitions get the column from shared/events.ts (template).
-- The one-time maintenance in workers/cron/src/rollup.ts adds it to any
-- back-month partition this migration cannot name.
-- ============================================================================

ALTER TABLE events_202607 ADD COLUMN bot_category TEXT;

CREATE INDEX IF NOT EXISTS idx_ev202607_botcat ON events_202607(site_id, bot_category, ts);
