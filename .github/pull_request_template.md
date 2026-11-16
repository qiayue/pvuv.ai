<!--
Title must be a Conventional Commit header, e.g. `feat(console): portfolio overview for many sites`.
Branch must be `<type>/<kebab-description>`. See docs/CONVENTIONS.md (中文：docs/CONVENTIONS.zh-CN.md).
-->

## What

<!-- What changes, in a few bullets. -->

## Why

<!-- The problem or goal. Link the issue: Closes #… -->

## How it was tested

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] Manually: <!-- what you clicked / called -->

## Screenshots

<!-- UI changes: before / after. Delete this section otherwise. -->

## Migrations & deploy

<!-- New migrations, new vars/secrets, wrangler.toml changes, order of deploys. Write "None" if none. -->

## Risk & rollback

<!-- What could break, and how to undo it. -->

## Checklist

- [ ] One logical change; branch and title follow docs/CONVENTIONS.md
- [ ] `CHANGELOG.md` updated under `## [Unreleased]` (user-visible changes)
- [ ] Docs updated in both languages (README / DEPLOY / docs/API.md / PROJECT_PLAN)
- [ ] Schema change → new migration + `shared/schema.sql`
- [ ] UI text in all 7 console languages
- [ ] No secrets, real IDs or private integrator names
