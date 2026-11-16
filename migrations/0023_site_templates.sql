-- ============================================================================
-- Site templates: per-owner presets for one-call site provisioning.
--
-- An external launcher that brings up a new site every day wants the same
-- settings each time — the owner's timezone, engagement threshold, ad-guard
-- tier, AdSense client — plus the same handful of saved funnels. A template
-- holds those once; `POST /v1/sites {"template": "<id or name>"}` applies it,
-- with any field in the request still overriding the template.
--
-- Every setting column is NULLABLE and NULL means "not set — use the normal
-- default at creation" (owner timezone, 15s, off, none), so a template can pin
-- only what it cares about. `funnels` is a JSON list of {name, steps} in the
-- same step format as funnels.steps; they are created on the new site by name,
-- idempotently.
-- ============================================================================

CREATE TABLE IF NOT EXISTS site_templates (
  template_id     TEXT PRIMARY KEY,
  owner_id        TEXT NOT NULL,
  name            TEXT NOT NULL,
  timezone        TEXT,
  engaged_seconds INTEGER,
  adguard_mode    TEXT,
  adclient        TEXT,
  funnels         TEXT NOT NULL DEFAULT '[]',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_site_templates_owner_name ON site_templates(owner_id, name COLLATE NOCASE);
