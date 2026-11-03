-- Deployment-level settings (homepage name/description, future prefs).
-- Key/value so later settings need no schema change.
CREATE TABLE instance_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at INTEGER
);
