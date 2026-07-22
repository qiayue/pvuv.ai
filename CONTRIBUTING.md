# Contributing to pvuv.ai

Thanks for your interest in contributing! This project is under active
development toward its first deployable milestone (M1). Contributions of code,
docs, translations, and bug reports are all welcome.

## Before you start

1. **Read the build spec.** [`PROJECT_PLAN.md`](./PROJECT_PLAN.md) (or
   [`PROJECT_PLAN.zh-CN.md`](./PROJECT_PLAN.zh-CN.md)) is the source of truth for
   architecture, schema, endpoints, and milestones. Proposals should fit it — or
   explain clearly why it should change.
2. **Check the roadmap.** See which milestone (M1–M4) your change belongs to. M1
   is intentionally narrow; features beyond it may be deferred.
3. **Open an issue first for anything non-trivial.** A quick discussion before a
   large PR saves everyone time, especially for schema or interface changes.

## Development setup

**Prerequisites:** Node.js 18+, a Cloudflare account, `wrangler`
(`npm i -g wrangler`).

```bash
git clone https://github.com/qiayue/pvuv.ai.git
cd pvuv.ai
npm install
cp config.example.toml config.local.toml   # tune locally; gitignored
```

Most components run locally with `wrangler dev`. Put local-only variables in
`.dev.vars` (gitignored) — never in tracked files. For local D1, use
`wrangler d1 execute pvuv --local --file=./shared/schema.sql`.

## Ground rules

- **Never commit secrets or real IDs.** No HMAC keys, Cloudflare tokens, API
  keys, `.dev.vars`, `config.local.*`, or real `account_id`. CI and reviewers
  will reject anything that looks like a leaked credential. See
  [`SECURITY.md`](./SECURITY.md).
- **Keep tuning out of the repo.** Detection *architecture* is public; concrete
  production weights/thresholds/blocklists belong in `config.local.*`. Don't
  hardcode them.
- **Respect the boundaries.** The ad-protection layer decides *whether* to
  inject ad code — it must never modify a third-party ad script, and must
  fail-open. No manipulative "load only for high-value users" logic. Privacy
  defaults are data-minimizing (hashed IPs, no raw fingerprints); don't regress
  them.
- **Preserve the monorepo layout** (`sdk/`, `workers/*`, `shared/`,
  `migrations/`). Don't flatten directory structure.
- **No `<meta name="keywords">`** in any generated HTML page. Other meta tags are
  fine.

## Pull requests

- Branch from `main`; keep PRs focused (one logical change).
- Describe *what* and *why*; link the related issue.
- If you change the D1 schema, include a migration in `migrations/` and update
  `shared/schema.sql` and the relevant `PROJECT_PLAN.md` section.
- Match the existing code style; run the linter/formatter if the repo defines
  one.
- Update docs (README / PROJECT_PLAN) when behavior or interfaces change. If you
  touch one language version of a doc, note the other so it can be kept in sync.

## Translations & docs

Documentation is bilingual (English primary + `*.zh-CN.md`). Improvements to
either language, or new-language versions (e.g. `*.ja.md`), are welcome. Keep
section structure aligned across languages so they can be cross-referenced.

## Licensing of contributions

By contributing, you agree that your contributions are licensed under the
project's [MIT License](./LICENSE). Only submit code you have the right to
contribute.

## Code of conduct

Be respectful and constructive. Assume good faith, keep discussion technical,
and help newcomers where you can.
