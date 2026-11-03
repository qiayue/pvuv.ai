-- Self-referral cleanup (sources).
--
-- A session whose FIRST event carried an internal referrer — typical after the
-- 30-min idle / calendar-day session rollover mid-visit, or an SPA route
-- change — was attributed to the site's own domain as an external "source",
-- so a site appeared as its own top referrer in the Sources panel.
--
-- Ingest now nulls ref_domain for same-site referrers (event hostname or any
-- whitelisted domain, exact or subdomain). This backfills history: a session
-- whose source equals its own entry host (or is a subdomain of it) becomes
-- direct. UTM-attributed sessions are untouched (a UTM source value would not
-- equal the entry host).
--
-- rollup_source_daily is not rewritten here: the hourly rollup regenerates
-- today + yesterday from the corrected sessions, and no read path consumes
-- older source rollups (the Sources panel reads the live sessions table).
UPDATE sessions SET source = NULL
WHERE source IS NOT NULL
  AND entry_host IS NOT NULL
  AND (source = entry_host OR source LIKE '%.' || entry_host);
