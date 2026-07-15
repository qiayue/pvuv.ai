-- Two bounce-rate definitions + per-site engagement threshold.
--
-- engaged_seconds: the GA4 "engaged session" dwell threshold, chosen per site at
-- creation (default 15s; GA4's own default is 10s and it's configurable up to
-- 60s). The consumer uses it to decide sessions.is_bounce. Set at creation and
-- treated as fixed (changing it would not retroactively re-bucket old sessions).
ALTER TABLE sites ADD COLUMN engaged_seconds INTEGER NOT NULL DEFAULT 15;

-- rollup_site_daily.bounce_rate stays the GA4 engagement-based rate; add the
-- single-page (UA/Plausible/Similarweb style) rate alongside it so the dashboard
-- can show either. Recomputed each rollup from sessions (pageviews <= 1).
ALTER TABLE rollup_site_daily ADD COLUMN bounce_rate_single REAL;
