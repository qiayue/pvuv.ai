-- Population/batch analysis (M2, §6.4–6.5).
--
-- interval_n: number of inter-event intervals accumulated into the Welford
-- stats (interval_mean/interval_m2). Welford's parallel-merge formula needs the
-- sample count to combine yesterday's aggregate with today's batch exactly;
-- without it the merge would be approximate. events_count can't stand in for it
-- (intervals only exist between consecutive events actually observed together).
ALTER TABLE visitor_profiles ADD COLUMN interval_n INTEGER NOT NULL DEFAULT 0;
