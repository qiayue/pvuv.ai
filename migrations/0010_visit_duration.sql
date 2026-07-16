-- Second, Plausible/UA-style session-duration definition alongside the GA4
-- engagement-time one we already store.
--
-- avg_duration_ms (existing) = sum of true visible dwell across ALL pages of a
--   session, including the exit page and single-page visits. Higher; it is the
--   real engaged reading time (close to GA4 "average engagement time").
-- visit_duration_ms (new)    = last_pageview_at − started_at, i.e. the gap
--   between the first and last pageview of a session. The exit page contributes
--   0 and a single-page visit (bounce) is 0, exactly like Plausible / UA
--   "visit duration". Lower; comparable to those tools.
--
-- last_pageview_at is maintained by the consumer (updated only on 'pageview'
-- events); visit_duration_ms is the per-day average the rollup derives from it.
ALTER TABLE sessions ADD COLUMN last_pageview_at INTEGER;
ALTER TABLE rollup_site_daily ADD COLUMN visit_duration_ms INTEGER;
