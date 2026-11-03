-- Shadow mode (§7): a new site records verdicts but doesn't block ads for its
-- first `adguard.shadow_days`. shadow_until = the instant enforcement begins
-- (created_at + shadow_days). NULL = enforce immediately (e.g. legacy sites).
-- /v checks now < shadow_until → always ok:1 (ads load) while still scoring.
ALTER TABLE sites ADD COLUMN shadow_until INTEGER;
