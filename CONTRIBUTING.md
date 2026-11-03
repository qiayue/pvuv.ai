# Contributing to pvuv.ai

Thanks for your interest in contributing! v0.1.0 is the first open-source
release (see [`CHANGELOG.md`](./CHANGELOG.md)); the project is pre-1.0 and
still moving quickly. Contributions of code, docs, translations, and bug
reports are all welcome.

## Before you start

1. **Read the build spec.** [`PROJECT_PLAN.md`](./PROJECT_PLAN.md) (or
   [`PROJECT_PLAN.zh-CN.md`](./PROJECT_PLAN.zh-CN.md)) is the source of truth for
   architecture, schema, endpoints, and milestones. Proposals should fit it — or
   explain clearly why it should change.
2. **Check the roadmap.** The README's roadmap table shows which milestones
   (M1–M4) are done and what is still open — currency conversion, cross-device
   merge, attribution models, scheduled AI reports, WebGL/canvas fingerprinting
   and the human-review UI are good places to help.
3. **Open an issue first for anything non-trivial.** A quick discussion before a
   large PR saves everyone time, especially for schema or interface changes.

## Development setup

**Prerequisites:** Node.js 22+ (required by wrangler 4) and a Cloudflare
account. `wrangler` is a dev dependency — use it through `npx wrangler` or the
npm scripts.

```bash
git clone https://github.com/qiayue/pvuv.ai.git
cd pvuv.ai
npm install
cp config.example.toml config.local.toml   # tune locally; gitignored
```

Most components run locally with `npm run dev:<worker>` (e.g. `npm run
dev:ingest`, which wraps `wrangler dev`). Put local-only variables in
`.dev.vars` (gitignored) — never in tracked files. Create the local D1 schema
with `npm run db:migrate:local`.

## Ground rules

- **Never commit secrets or real IDs.** No HMAC keys, Cloudflare tokens, API
  keys, `.dev.vars`, `config.local.*`, or real `account_id`. Reviewers will
  reject anything that looks like a leaked credential. See
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
- Match the existing code style. Before opening a PR, run `npm run typecheck`,
  and `npm run build:sdk` if you touched `sdk/` or `shared/`.
- Add a line under an `Unreleased` heading in [`CHANGELOG.md`](./CHANGELOG.md)
  for any user-visible change.
- Update docs (README / DEPLOY / docs/API.md / PROJECT_PLAN) when behavior or
  interfaces change. If you
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
