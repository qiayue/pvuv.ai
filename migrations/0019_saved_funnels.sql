-- ============================================================================
-- Saved conversion funnels.
--
-- The funnel used to live in the browser's localStorage: one per site, lost on
-- a new device, and invisible to everything that isn't the dashboard. Storing
-- it makes a funnel a first-class object of the site:
--
--   * several funnels per site (signup / checkout / onboarding …), named;
--   * the same definition on every device and for every admin;
--   * readable by the API and the MCP server, so an external agent can pull
--     "how is the checkout funnel doing" without being told the steps;
--   * available to the daily AI report, which is the point of collecting the
--     behaviour signals in the first place — the report can only advise on a
--     funnel it knows about.
--
-- `steps` is the same JSON the query layer takes: [{"type":"page","value":"/"},
-- {"type":"event","value":"signup"}] — 2..8 entries, validated on write.
-- ============================================================================

CREATE TABLE IF NOT EXISTS funnels (
  site_id    TEXT NOT NULL,
  funnel_id  TEXT NOT NULL,
  name       TEXT NOT NULL,
  steps      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (site_id, funnel_id)
);
CREATE INDEX IF NOT EXISTS idx_funnels_site ON funnels(site_id, updated_at);
