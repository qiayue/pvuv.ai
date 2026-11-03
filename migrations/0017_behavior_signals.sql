-- ============================================================================
-- Behavior signals for AI funnel analysis (frustration/error deltas).
--
-- Carried by the periodic page_pulse events and by page_leave — incremental
-- deltas that survive a lost leave beacon (mobile tab kills, crashes):
--   err_count  — JS errors / unhandled rejections since the last report
--   rage_count — rage-click bursts (>=3 fast clicks on the same element)
--   dead_count — clicks on interactive-looking elements with no effect
--
-- Click summaries ride in the existing `props` JSON ({"ck":[{s,n},…]}) and
-- form_start / form_submit are auto events; abandonment is DERIVED server-side
-- (starts − submits), so nothing about it depends on the leave beacon.
--
-- This migration alters the initial partition it can name; all other
-- partitions are repaired by shared/events.ts EVENT_LATE_COLUMNS via the
-- consumer/cron ensureEventColumns pass.
-- ============================================================================

ALTER TABLE events_202607 ADD COLUMN err_count INTEGER;
ALTER TABLE events_202607 ADD COLUMN rage_count INTEGER;
ALTER TABLE events_202607 ADD COLUMN dead_count INTEGER;
