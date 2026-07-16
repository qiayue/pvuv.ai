-- ============================================================================
-- pvuv.ai D1 schema — PROJECT_PLAN.md §9.2 (M1 DDL, incl. M2+ placeholders)
-- ============================================================================
-- Canonical schema (the full current shape). Applied incrementally via the
-- files in migrations/ — 0001_init.sql plus later additions. Keep in sync:
--   wrangler d1 migrations apply pvuv-db --local | --remote
--
-- Raw events are monthly-partitioned (events_YYYYMM). This file creates the
-- initial month; the consumer worker creates subsequent months on demand from
-- the same template (index prefix idx_evYYYYMM_*).
-- ============================================================================

-- deployment-level settings (homepage name/description, future prefs)
-- (added by migrations/0002_instance_settings.sql)
CREATE TABLE instance_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at INTEGER
);

-- users
CREATE TABLE users (
  user_id     TEXT PRIMARY KEY,
  email       TEXT UNIQUE,
  name        TEXT,
  created_at  INTEGER NOT NULL,
  status      TEXT DEFAULT 'active',
  timezone    TEXT DEFAULT 'UTC'             -- user default for new sites (added by 0004)
);

-- sites
CREATE TABLE sites (
  site_id         TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  owner_id        TEXT NOT NULL,
  allowed_domains TEXT NOT NULL,             -- JSON array
  adguard_mode    TEXT DEFAULT 'off',        -- off/loose/balanced/strict/custom
  adguard_config  TEXT,                      -- JSON custom thresholds/toggles
  adclient        TEXT,                      -- ca-pub-xxx
  settings        TEXT,
  created_at      INTEGER NOT NULL,
  status          TEXT DEFAULT 'active',
  timezone        TEXT DEFAULT 'UTC',        -- display/aggregation tz, IMMUTABLE (added by 0004)
  engaged_seconds INTEGER NOT NULL DEFAULT 15 -- GA4 engagement dwell threshold, set at creation (added by 0006)
);

-- raw events (monthly-partitioned; initial month 202607)
CREATE TABLE events_202607 (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  eid           TEXT,                            -- dedup key (added by 0005)
  site_id       TEXT NOT NULL,
  event         TEXT NOT NULL,
  visitor_id    TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  user_id       TEXT,
  url           TEXT NOT NULL,
  hostname      TEXT NOT NULL,
  path          TEXT NOT NULL,
  referrer      TEXT,
  ref_domain    TEXT,
  utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, utm_term TEXT, utm_content TEXT,
  click_id TEXT, click_id_type TEXT,
  extra_params TEXT,
  country TEXT, region TEXT, city TEXT,
  browser TEXT, os TEXT, device_type TEXT,
  screen_w INTEGER, screen_h INTEGER,
  lang TEXT,
  ip_hash TEXT, ip24_hash TEXT,
  asn INTEGER, asn_type TEXT,
  fp_hash TEXT,
  duration_ms INTEGER, scroll_depth INTEGER, had_interaction INTEGER DEFAULT 0,
  revenue REAL, revenue_usd REAL, currency TEXT,
  props TEXT,
  ft_source TEXT, ft_medium TEXT, ft_campaign TEXT, ft_referrer TEXT,
  bot_score INTEGER DEFAULT 0,
  verdict TEXT DEFAULT 'clean',
  bot_flags INTEGER DEFAULT 0,
  score_stage TEXT DEFAULT 'realtime',
  ts INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_ev202607_eid ON events_202607(eid);
CREATE INDEX idx_ev202607_site_ts ON events_202607(site_id, ts);
CREATE INDEX idx_ev202607_visitor ON events_202607(site_id, visitor_id);
CREATE INDEX idx_ev202607_session ON events_202607(session_id);
CREATE INDEX idx_ev202607_verdict ON events_202607(site_id, verdict, ts);
CREATE INDEX idx_ev202607_path    ON events_202607(site_id, path);

-- sessions
CREATE TABLE sessions (
  session_id   TEXT PRIMARY KEY,
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
  started_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL
);
CREATE INDEX idx_sess_site ON sessions(site_id, started_at);
CREATE INDEX idx_sess_visitor ON sessions(site_id, visitor_id);

-- identity map
CREATE TABLE identities (
  site_id TEXT NOT NULL, user_id TEXT NOT NULL, visitor_id TEXT NOT NULL,
  traits TEXT, first_seen INTEGER, last_seen INTEGER,
  PRIMARY KEY (site_id, user_id, visitor_id)
);

-- visitor profiles (incrementally updated by batch analysis)
CREATE TABLE visitor_profiles (
  site_id TEXT NOT NULL, visitor_id TEXT NOT NULL,
  events_count INTEGER DEFAULT 0, sessions_count INTEGER DEFAULT 0,
  interval_mean REAL, interval_m2 REAL, interval_cv REAL,
  interval_n INTEGER NOT NULL DEFAULT 0,  -- Welford sample count (added by 0007)
  active_hours INTEGER,
  fp_hash TEXT, ip24_hash TEXT, asn INTEGER,
  bot_score INTEGER DEFAULT 0, verdict TEXT DEFAULT 'clean',
  first_seen INTEGER, last_seen INTEGER,
  PRIMARY KEY (site_id, visitor_id)
);
CREATE INDEX idx_vp_fp   ON visitor_profiles(fp_hash);
CREATE INDEX idx_vp_ip24 ON visitor_profiles(ip24_hash);

-- daily rollups (with clean bucket)
CREATE TABLE rollup_page_daily (
  site_id TEXT, day TEXT, hostname TEXT, path TEXT,
  pv INTEGER DEFAULT 0, uv INTEGER DEFAULT 0, sessions INTEGER DEFAULT 0,
  bounces INTEGER DEFAULT 0, total_duration_ms INTEGER DEFAULT 0,
  pv_clean INTEGER DEFAULT 0, uv_clean INTEGER DEFAULT 0,
  PRIMARY KEY (site_id, day, hostname, path)
);
CREATE TABLE rollup_source_daily (
  site_id TEXT, day TEXT, source TEXT, medium TEXT, campaign TEXT,
  pv INTEGER DEFAULT 0, uv INTEGER DEFAULT 0, sessions INTEGER DEFAULT 0,
  conversions INTEGER DEFAULT 0, revenue_usd REAL DEFAULT 0,
  pv_clean INTEGER DEFAULT 0, uv_clean INTEGER DEFAULT 0,
  PRIMARY KEY (site_id, day, source, medium, campaign)
);
CREATE TABLE rollup_site_daily (
  site_id TEXT, day TEXT,
  pv INTEGER DEFAULT 0, uv INTEGER DEFAULT 0, sessions INTEGER DEFAULT 0,
  bounce_rate REAL,               -- GA4 engagement-based bounce (1 − engaged)
  bounce_rate_single REAL,        -- single-page bounce (UA/Plausible style; added by 0006)
  avg_duration_ms INTEGER,
  bot_count INTEGER DEFAULT 0, suspect_count INTEGER DEFAULT 0,
  crawler_count INTEGER DEFAULT 0, clean_count INTEGER DEFAULT 0,
  conversions INTEGER DEFAULT 0, revenue_usd REAL DEFAULT 0,
  PRIMARY KEY (site_id, day)
);

-- clusters / anomalies / AI (M2+, created in M1 as placeholders)
CREATE TABLE cluster_flags (
  cluster_id TEXT PRIMARY KEY, site_id TEXT,
  type TEXT, member_count INTEGER, evidence TEXT,
  action TEXT DEFAULT 'observe', created_at INTEGER, expires_at INTEGER
);
CREATE TABLE anomaly_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT, day TEXT, dimension TEXT,
  baseline REAL, actual REAL, deviation REAL,
  related_cluster TEXT, evidence TEXT,
  status TEXT DEFAULT 'pending', created_at INTEGER
);
CREATE TABLE ai_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT, period TEXT, kind TEXT,
  content TEXT, data_snapshot TEXT, created_at INTEGER
);
