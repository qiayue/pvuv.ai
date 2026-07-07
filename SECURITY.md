# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

If you discover a security issue, report it privately using GitHub's
[private vulnerability reporting](https://github.com/qiayue/pvuv.ai/security/advisories/new)
(Security → Report a vulnerability on this repository). If that is unavailable,
contact the maintainer through the address listed on the GitHub profile
[@qiayue](https://github.com/qiayue).

Please include:
- a description of the issue and its impact,
- steps to reproduce (a minimal proof of concept if possible),
- affected component (SDK / ingest / api / console / cron) and version or commit.

We aim to acknowledge reports within a few days and to coordinate a fix and
disclosure timeline with you. Please give us reasonable time to address the
issue before any public disclosure.

## Scope

This project handles analytics data and anti-fraud logic. Reports of particular
interest include, but are not limited to:

- **Ingest spoofing / data injection** — bypassing `allowed_domains` validation,
  forging events, or corrupting a site's data.
- **Verdict / cookie tampering** — forging or replaying the signed `_pv_v`
  verdict cookie, or otherwise defeating HMAC integrity.
- **Anti-fraud evasion at scale** — practical techniques to fake trustworthy
  traffic that would undermine ad protection or rankings. (Note: the general
  architecture is public by design; we're interested in concrete, scalable
  bypasses, not the fact that client-side checks are visible.)
- **Secret or PII exposure** — any path that leaks secrets, plaintext IPs, or
  raw fingerprints.
- **Auth / access-control flaws** — one site owner reading another's data via
  the query API.
- **Injection / XSS** in the console.

## Out of scope

- Missing security headers with no demonstrated impact.
- Denial of service from unrealistic request volumes.
- Issues requiring a compromised deployer machine or leaked Cloudflare account.
- Reports that a self-hosted deployer has misconfigured their own instance
  (e.g. committed secrets, disabled validation).

## For deployers

Before running pvuv.ai in production, review the pre-open-source security
checklist in [`PROJECT_PLAN.md` §22](./PROJECT_PLAN.md): keep all secrets in
`wrangler secret`, never commit `.dev.vars` / `config.local.*` / real account
IDs, and scan history for accidentally committed secrets (rotate if found).
