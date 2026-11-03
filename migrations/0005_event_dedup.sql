-- Event dedup key: makes event writes exactly-once under at-least-once queue
-- redelivery (consumer uses INSERT OR IGNORE on this UNIQUE index). Applies to
-- the initial partition; later months get eid + the unique index from the
-- shared DDL template (shared/events.ts) when the consumer creates them.
ALTER TABLE events_202607 ADD COLUMN eid TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ev202607_eid ON events_202607(eid);
