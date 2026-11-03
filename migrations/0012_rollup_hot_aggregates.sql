-- ============================================================================
-- Query/storage optimization (PROJECT_PLAN.md §9.3): denormalize the hot
-- per-day tallies that the dashboard's heaviest endpoints previously recomputed
-- by full-scanning raw event partitions on every load.
--
-- With these columns the hourly rollup pre-aggregates them once; alerts and
-- adguard-impact then read completed days straight from rollup_site_daily and
-- only touch raw events for the current (still-open) day. All are plain
-- SUMMABLE counts (never DISTINCT), so summing across days stays exact.
--   * dc_pv / zero_pv / fake_pv / search_ref_pv  → the alerts flag tallies
--   * {clean,suspect,bot,crawler}_eng_pv         → adguard fp_rate (pageviews
--     whose session had a real interaction — replaces a per-period events↔
--     sessions JOIN done live on every dashboard load)
-- ============================================================================

ALTER TABLE rollup_site_daily ADD COLUMN dc_pv          INTEGER DEFAULT 0;
ALTER TABLE rollup_site_daily ADD COLUMN zero_pv        INTEGER DEFAULT 0;
ALTER TABLE rollup_site_daily ADD COLUMN fake_pv        INTEGER DEFAULT 0;
ALTER TABLE rollup_site_daily ADD COLUMN search_ref_pv  INTEGER DEFAULT 0;
ALTER TABLE rollup_site_daily ADD COLUMN clean_eng_pv   INTEGER DEFAULT 0;
ALTER TABLE rollup_site_daily ADD COLUMN suspect_eng_pv INTEGER DEFAULT 0;
ALTER TABLE rollup_site_daily ADD COLUMN bot_eng_pv     INTEGER DEFAULT 0;
ALTER TABLE rollup_site_daily ADD COLUMN crawler_eng_pv INTEGER DEFAULT 0;

-- Pageview-range scans (alerts / quality / adguard reasons / breakdown / funnel
-- / overview) all filter site_id + event='pageview' + a ts range. The existing
-- (site_id, ts) index can't skip non-pageview rows; this one covers the exact
-- predicate. Future monthly partitions get it from shared/events.ts (template).
CREATE INDEX IF NOT EXISTS idx_ev202607_site_ev_ts ON events_202607(site_id, event, ts);
