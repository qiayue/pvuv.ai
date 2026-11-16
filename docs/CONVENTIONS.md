# Branch, commit and pull-request conventions

> 中文版：[`CONVENTIONS.zh-CN.md`](./CONVENTIONS.zh-CN.md). Sections 1, 2 (PR
> title) and 5 are enforced by CI (`.github/workflows/pr-check.yml`); a PR
> that fails them cannot be merged.

## 1. Branch names

`<type>/<short-kebab-description>` — lowercase letters, digits and hyphens,
at most 50 characters.

| Type | For | Example |
|---|---|---|
| `feat` | a new feature | `feat/portfolio-overview` |
| `fix` | a bug fix | `fix/cron-daily-batch` |
| `perf` | a performance improvement | `perf/portfolio-batch-query` |
| `refactor` | restructuring, no behaviour change | `refactor/shared-site-helper` |
| `docs` | documentation only | `docs/deploy-integrations` |
| `test` | tests only | `test/crawler-hits-limits` |
| `ci` / `build` | CI, build, dependencies | `ci/pr-check` |
| `chore` | maintenance | `chore/bump-wrangler` |
| `style` | visual / UI styling only | `style/console-light-theme` |
| `revert` | reverting a change | `revert/portfolio-cache` |
| `release` | preparing a release | `release/v0.2.0` |
| `hotfix` | urgent production fix (from and back to `main`) | `hotfix/ingest-500` |

Not allowed:
- personal, tool or random names (`claude/…`, `codex/…`, `alice/test`, `dreamy-turing-…`)
- capitals, underscores, spaces, non-ASCII
- unrelated changes mixed on one branch

Branch from up-to-date `main`; delete the branch after it is merged.

## 2. Commit messages

[Conventional Commits](https://www.conventionalcommits.org/), as the history
already does:

```
<type>(<scope>): <summary>

<optional body: why, how, impact>

<optional footer: BREAKING CHANGE: …, Refs #12>
```

- **Type**: as above (no `hotfix` — urgent fixes are still `fix`).
- **Scope** (optional): `console` `api` `ingest` `consumer` `cron` `proxy`
  `sdk` `mcp` `cli` `shared` `batch` `funnel` `alerts` `deploy` `deps` `design`.
- **Summary**: imperative, lowercase start, no trailing period, ≤ 72
  characters — e.g. `fix(cron): run the daily batch from the hourly job when
  its schedule stops firing`.
- **Breaking changes**: `!` after the type/scope (`feat(api)!: …`) and a
  `BREAKING CHANGE:` footer with the upgrade path.
- One concern per commit; keep mass reformatting in its own commit.

## 3. Pull requests

1. **Title** = a valid commit header (`feat(console): portfolio overview for
   many sites`). PRs are squash-merged, so the title becomes the commit on
   `main`.
2. **Open as a draft**; mark it ready once checks pass and the template is filled in.
3. **One logical change.** Aim for under ~800 changed lines (excluding lock
   files, screenshots and generated files); explain in the description if a
   larger PR cannot be split.
4. **Fill in the template** (`.github/pull_request_template.md`): what, why,
   how it was tested, screenshots, migrations/deploy steps, risk and rollback.
5. **Green CI**: branch name, PR title, `npm run typecheck`, `npm test`.
6. **Schema**: a new, consecutively numbered `migrations/00NN_*.sql`, plus
   `shared/schema.sql` and the relevant `PROJECT_PLAN.md` section. Never edit
   a migration that has been merged.
7. **Docs & changelog**: user-visible changes add a line under
   `## [Unreleased]` in `CHANGELOG.md`; interface or behaviour changes update
   README / DEPLOY / `docs/API.md` in both languages.
8. **UI**: all 7 console languages, and before/after screenshots
   (`docs/design/screens/`).
9. **Safety**: no secrets, real account IDs or `.dev.vars`; no names of
   private integrators in code, docs or commit messages.
10. **Merging**: ≥ 1 approving review, green CI, no unresolved threads →
    **Squash and merge**, then delete the branch. A large multi-part feature
    may collect sub-PRs on a `feat/…` integration branch and merge that into
    `main` with a merge commit.

## 4. Splitting a large feature

- Create the integration branch `feat/<feature>` and a draft PR into `main`.
- Each part branches from it as `feat/<feature>-<part>` and opens a PR into
  the integration branch, never straight into `main`.
- Write the shared contract (API shape, file ownership, migration number
  ranges) in `docs/design/` before parallel work starts.

## 5. What CI checks

| Check | Rule |
|---|---|
| Branch | `^(feat\|fix\|perf\|refactor\|docs\|test\|ci\|build\|chore\|style\|revert\|release\|hotfix)/[a-z0-9]+(-[a-z0-9]+)*$`, ≤ 50 chars; `dependabot/…` exempt |
| PR title | `^(feat\|fix\|perf\|refactor\|docs\|test\|ci\|build\|chore\|style\|revert\|release)(\([a-z0-9-]+\))?!?: .+`, ≤ 100 chars |
| Code | `npm ci` → `npm run typecheck` → `npm test` (Node 22) |
