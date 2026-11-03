-- ============================================================================
-- Three additions in one migration:
--
-- 1. sessions.channel — GA4-style default channel group (organic_search /
--    paid_search / organic_social / paid_social / email / ai / video /
--    referral / direct). Computed by the consumer from the session's first
--    event (shared/channel.ts); backfilled below for existing sessions with a
--    coarser SQL mirror of the same rules (no click-id on sessions, so paid
--    detection here leans on medium alone).
--
-- 2. sites.public_token — non-NULL enables the read-only public dashboard for
--    that site at /public.html?site=<id>&k=<token>. Random, owner-revocable
--    (disable = set NULL, re-enable mints a new token).
--
-- 3. Core Web Vitals columns on the events partitions (lcp_ms / cls / inp_ms /
--    fcp_ms / ttfb_ms), reported once per page load on the first page_leave.
--    This migration alters the initial partition it can name; every other
--    partition (past or future) is repaired by shared/events.ts
--    EVENT_LATE_COLUMNS via the consumer/cron ensureEventColumns pass.
-- ============================================================================

ALTER TABLE sessions ADD COLUMN channel TEXT;

-- Backfill. Order matters: first match wins via CASE. Paid → email → ai →
-- search → video → social → direct → referral. LIKE patterns mirror the
-- suffix-match semantics of shared/channel.ts for the common domains.
UPDATE sessions SET channel = CASE
  WHEN LOWER(COALESCE(medium, '')) IN ('cpc','ppc','sem','paid','cpm','cpv','cpa','display','banner','retargeting','paid_social','paidsocial') THEN
    CASE WHEN LOWER(COALESCE(source, '')) LIKE '%facebook%' OR LOWER(COALESCE(source, '')) LIKE '%instagram%'
           OR LOWER(COALESCE(source, '')) LIKE '%tiktok%' OR LOWER(COALESCE(source, '')) LIKE '%twitter%'
      THEN 'paid_social' ELSE 'paid_search' END
  WHEN LOWER(COALESCE(medium, '')) IN ('email','e-mail','newsletter','mail') THEN 'email'
  WHEN source IS NULL OR source = '' THEN 'direct'
  WHEN LOWER(source) LIKE '%chatgpt.com' OR LOWER(source) LIKE '%chat.openai.com' OR LOWER(source) LIKE '%perplexity.ai'
    OR LOWER(source) LIKE '%claude.ai' OR LOWER(source) LIKE '%gemini.google.com' OR LOWER(source) LIKE '%copilot.microsoft.com'
    OR LOWER(source) LIKE '%deepseek.com' OR LOWER(source) LIKE '%kimi.%' OR LOWER(source) LIKE '%doubao.com'
    OR LOWER(source) LIKE '%metaso.cn' THEN 'ai'
  WHEN LOWER(source) LIKE '%google.%' OR LOWER(source) LIKE '%bing.com' OR LOWER(source) LIKE '%baidu.com'
    OR LOWER(source) LIKE '%duckduckgo.com' OR LOWER(source) LIKE '%yandex.%' OR LOWER(source) LIKE '%yahoo.com'
    OR LOWER(source) LIKE '%sogou.com' OR LOWER(source) LIKE '%so.com' OR LOWER(source) LIKE '%naver.com'
    OR LOWER(source) LIKE '%ecosia.org' OR LOWER(source) = 'google' OR LOWER(source) = 'bing' OR LOWER(source) = 'baidu' THEN 'organic_search'
  WHEN LOWER(source) LIKE '%youtube.com' OR LOWER(source) LIKE '%youtu.be' OR LOWER(source) LIKE '%bilibili.com'
    OR LOWER(source) LIKE '%vimeo.com' OR LOWER(source) LIKE '%twitch.tv' THEN 'video'
  WHEN LOWER(source) LIKE '%facebook.com' OR LOWER(source) LIKE '%instagram.com' OR LOWER(source) LIKE '%twitter.com'
    OR LOWER(source) LIKE '%x.com' OR LOWER(source) = 't.co' OR LOWER(source) LIKE '%linkedin.com'
    OR LOWER(source) LIKE '%reddit.com' OR LOWER(source) LIKE '%tiktok.com' OR LOWER(source) LIKE '%weibo.%'
    OR LOWER(source) LIKE '%zhihu.com' OR LOWER(source) LIKE '%xiaohongshu.com' OR LOWER(source) LIKE '%t.me'
    OR LOWER(source) LIKE '%v2ex.com' OR LOWER(source) LIKE '%juejin.cn' OR LOWER(source) LIKE '%ycombinator.com'
    OR LOWER(source) = 'facebook' OR LOWER(source) = 'twitter' OR LOWER(source) = 'x' THEN 'organic_social'
  ELSE 'referral'
END
WHERE channel IS NULL;

ALTER TABLE sites ADD COLUMN public_token TEXT;

ALTER TABLE events_202607 ADD COLUMN lcp_ms INTEGER;
ALTER TABLE events_202607 ADD COLUMN cls REAL;
ALTER TABLE events_202607 ADD COLUMN inp_ms INTEGER;
ALTER TABLE events_202607 ADD COLUMN fcp_ms INTEGER;
ALTER TABLE events_202607 ADD COLUMN ttfb_ms INTEGER;
