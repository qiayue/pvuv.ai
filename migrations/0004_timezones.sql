-- Per-site display timezone + a user-level default for new sites.
-- Analytics are aggregated by each site's LOCAL calendar day (this timezone),
-- which is why it is fixed at creation and never changed: changing it would
-- invalidate every existing daily rollup for the site. The user default just
-- pre-fills the site-creation form.
ALTER TABLE users ADD COLUMN timezone TEXT DEFAULT 'UTC';
ALTER TABLE sites ADD COLUMN timezone TEXT DEFAULT 'UTC';
