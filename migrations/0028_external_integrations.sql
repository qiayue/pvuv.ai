-- ============================================================================
-- External integrations (portfolio P3): ad revenue and search data pulled from
-- Google AdSense, Google Search Console and Adsterra by the cron worker, plus
-- the console's own ads.txt checks. See docs/INTEGRATIONS.md.
--
-- Credentials are stored ONLY as AES-GCM ciphertext (key derived from the
-- HMAC_KEY secret via HKDF — shared/external/crypto.ts). Nothing in these
-- tables is ever returned to the browser except labels and status.
-- ============================================================================

-- one row per connected provider ('google' | 'adsterra')
CREATE TABLE IF NOT EXISTS ext_credentials (
  provider      TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL,
  ciphertext    TEXT NOT NULL,              -- v1.<iv>.<ct>, never plaintext
  account_label TEXT,                       -- e.g. the Google account email (display only)
  scopes        TEXT,                       -- granted scopes (space separated)
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- per data source ('adsense' | 'gsc' | 'adsterra' | 'ads_txt') sync bookkeeping
CREATE TABLE IF NOT EXISTS ext_sync_status (
  source        TEXT PRIMARY KEY,
  last_run_at   INTEGER,
  last_ok_at    INTEGER,
  last_error    TEXT,
  error_count   INTEGER NOT NULL DEFAULT 0, -- consecutive failures (drives backoff)
  backoff_until INTEGER,                    -- quota/rate errors: skip runs until then
  stats         TEXT                        -- JSON: last run counters / account alerts
);

-- external "properties" (AdSense site, Search Console property, Adsterra
-- domain, ads.txt-checked hostname) and their mapping to a pvuv site
CREATE TABLE IF NOT EXISTS ext_properties (
  source        TEXT NOT NULL,
  property_id   TEXT NOT NULL,              -- adsense domain | gsc siteUrl | adsterra domain id | hostname
  label         TEXT,                       -- human label (domain / property url)
  domain        TEXT,                       -- normalized hostname used for auto-mapping
  site_id       TEXT,                       -- mapped pvuv site (NULL = unmapped)
  mapping       TEXT NOT NULL DEFAULT 'auto', -- auto | manual | ignored
  state         TEXT,                       -- source-specific status (lower-case)
  ads_txt       TEXT,                       -- ads_txt source: ok | missing | mismatch | error
  indexed_pages INTEGER,                    -- gsc: pages with >=1 impression in 28 days (lower bound)
  detail        TEXT,                       -- JSON, source-specific
  error         TEXT,                       -- last per-property error (sync continues)
  checked_at    INTEGER,                    -- last successful refresh of this property
  updated_at    INTEGER,
  PRIMARY KEY (source, property_id)
);
CREATE INDEX IF NOT EXISTS idx_ext_properties_site ON ext_properties(site_id, source);

-- daily metrics per property; site_id denormalized from the mapping at write
-- time (re-stamped when a mapping changes) so the portfolio reads one index.
-- revenue: original currency as reported; revenue_usd when the API gives it.
CREATE TABLE IF NOT EXISTS ext_daily (
  source        TEXT NOT NULL,              -- adsense | adsterra | gsc
  property_id   TEXT NOT NULL,
  day           TEXT NOT NULL,              -- YYYY-MM-DD (the network's reporting day)
  site_id       TEXT,
  impressions   INTEGER DEFAULT 0,
  clicks        INTEGER DEFAULT 0,
  pageviews     INTEGER,                    -- adsense page views
  revenue       REAL,
  currency      TEXT,
  revenue_usd   REAL,
  position      REAL,                       -- gsc average position
  updated_at    INTEGER,
  PRIMARY KEY (source, property_id, day)
);
CREATE INDEX IF NOT EXISTS idx_ext_daily_site ON ext_daily(site_id, day);
