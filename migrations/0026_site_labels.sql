-- Portfolio labels (docs/design/portfolio-ui.md §3.2): per-site star, free-form
-- tags and a private note for owners of many sites. One row per site, created
-- lazily on the first write; a site without a row is unstarred and untagged.
-- `tags` is a JSON array of strings. Read by the portfolio overview
-- (GET /api/portfolio, /v1/portfolio); written by the bulk / labels endpoints.
CREATE TABLE IF NOT EXISTS site_labels (
  site_id    TEXT PRIMARY KEY,
  starred    INTEGER DEFAULT 0,
  tags       TEXT DEFAULT '[]',
  notes      TEXT,
  updated_at INTEGER
);
