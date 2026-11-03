-- Key sessions on (site_id, session_id), not session_id alone.
--
-- The SDK stores _pv_sid at the widest registrable domain, so a visitor moving
-- between two sibling subdomains registered as SEPARATE sites (e.g.
-- blog.example.com and shop.example.com) carries the same session_id. With
-- session_id as the sole PRIMARY KEY, the consumer's ON CONFLICT(session_id)
-- merged the second site's session into the first. Composite key keeps them
-- distinct. Rebuild is required (SQLite can't alter a PRIMARY KEY in place).
CREATE TABLE sessions_new (
  session_id   TEXT NOT NULL,
  site_id      TEXT NOT NULL,
  visitor_id   TEXT NOT NULL,
  user_id      TEXT,
  entry_page   TEXT, exit_page TEXT, entry_host TEXT,
  pageviews INTEGER DEFAULT 0, events_count INTEGER DEFAULT 0,
  duration_ms INTEGER DEFAULT 0, had_interaction INTEGER DEFAULT 0,
  is_bounce INTEGER,
  source TEXT, medium TEXT, campaign TEXT, referrer TEXT,
  country TEXT, device_type TEXT,
  bot_score INTEGER DEFAULT 0, verdict TEXT DEFAULT 'clean', bot_flags INTEGER DEFAULT 0,
  started_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL,
  PRIMARY KEY (site_id, session_id)
);
INSERT INTO sessions_new (
  session_id, site_id, visitor_id, user_id, entry_page, exit_page, entry_host,
  pageviews, events_count, duration_ms, had_interaction, is_bounce,
  source, medium, campaign, referrer, country, device_type,
  bot_score, verdict, bot_flags, started_at, last_active_at
) SELECT
  session_id, site_id, visitor_id, user_id, entry_page, exit_page, entry_host,
  pageviews, events_count, duration_ms, had_interaction, is_bounce,
  source, medium, campaign, referrer, country, device_type,
  bot_score, verdict, bot_flags, started_at, last_active_at
FROM sessions;
DROP TABLE sessions;
ALTER TABLE sessions_new RENAME TO sessions;
CREATE INDEX idx_sess_site ON sessions(site_id, started_at);
CREATE INDEX idx_sess_visitor ON sessions(site_id, visitor_id);
