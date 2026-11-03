-- ============================================================================
-- Personal API tokens (PROJECT_PLAN.md §10) — the credential MCP clients, the
-- CLI and third-party integrations authenticate with.
--
-- The pre-existing API_TOKEN worker secret stays supported, but it is a single
-- deployment-wide credential with full read access to every site: it cannot be
-- scoped, revoked individually, attributed, or rotated without breaking every
-- consumer at once. That is the wrong shape for a token that ends up pasted
-- into a chatbot config or sitting in a shell profile.
--
-- These tokens are per-owner, optionally narrowed to a single site, revocable
-- one at a time, and stored only as an HMAC — the plaintext is shown once at
-- creation and is unrecoverable afterwards.
-- ============================================================================

CREATE TABLE api_tokens (
  token_id    TEXT PRIMARY KEY,          -- public identifier (safe to display/log)
  owner_id    TEXT NOT NULL,             -- users.user_id; the token acts as this owner
  name        TEXT NOT NULL,             -- human label, e.g. "Claude Desktop"
  token_hash  TEXT NOT NULL,             -- HMAC(HMAC_KEY, plaintext); never the token itself
  prefix      TEXT NOT NULL,             -- first chars of the plaintext, for identification in lists
  site_id     TEXT,                      -- NULL = all of this owner's sites; else restricted to one
  created_at  INTEGER NOT NULL,
  last_used_at INTEGER,                  -- refreshed lazily, for spotting unused/stale tokens
  revoked_at  INTEGER                    -- non-NULL = permanently unusable
);

-- the hot path: authenticate by hash on every API request
CREATE UNIQUE INDEX idx_api_tokens_hash ON api_tokens(token_hash);
CREATE INDEX idx_api_tokens_owner ON api_tokens(owner_id, created_at);
