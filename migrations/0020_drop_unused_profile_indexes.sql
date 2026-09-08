-- ============================================================================
-- Drop two indexes on visitor_profiles that nothing ever reads.
--
-- idx_vp_fp (fp_hash) and idx_vp_ip24 (ip24_hash) were created for the
-- population/cluster analysis, but that analysis groups fingerprints and IP
-- segments over the EVENTS tables, never over visitor_profiles. Every actual
-- read of visitor_profiles goes through its primary key (site_id, visitor_id):
-- the consumer's upsert, the daily batch's correlated UPDATEs and the API's
-- profile lookup.
--
-- The cost was paid on every single event. Because both columns appear in the
-- upsert's DO UPDATE SET list, SQLite rewrites both index entries on every
-- event even when COALESCE leaves the value unchanged — production measured
-- 3.05 rows written per upsert (the row plus these two indexes) across ~108k
-- upserts, and on the reference dataset the two indexes together were 54% of
-- the size of the table they index.
--
-- If a future query ever looks a profile up BY fingerprint or IP segment,
-- re-create the index it needs — this migration is trivially reversible.
-- ============================================================================

DROP INDEX IF EXISTS idx_vp_fp;
DROP INDEX IF EXISTS idx_vp_ip24;
