-- entry_host lets the hourly rollup attribute a session's bounce to the
-- correct (hostname, path) rollup_page_daily row. Without it, a site served
-- on multiple hostnames has the same path's bounces counted into every
-- hostname row. (sessions carry only entry_page = path otherwise.)
ALTER TABLE sessions ADD COLUMN entry_host TEXT;
