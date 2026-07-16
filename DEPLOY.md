# Deploying pvuv.ai to Cloudflare

> 中文版 / Chinese: [`DEPLOY.zh-CN.md`](./DEPLOY.zh-CN.md)

This guide takes you from a fresh clone to a working deployment: five Workers,
a D1 database, two KV namespaces, a Queue, and the collection SDK. It matches
the code in this repository exactly — every command has been written against
the current `wrangler.toml` files.

**What you'll end up with** (addresses are examples — use your own domain):

| Component | Address | Worker |
|---|---|---|
| Ingest + fast verdict | `https://in.example.com/in`, `/v` | `workers/ingest` |
| Queue consumer | (no route — consumes `pvuv-ingest`) | `workers/consumer` |
| Query API | `https://api.example.com/v1/...` | `workers/api` |
| Console (dashboards) | `https://example.com/` | `workers/console` |
| Scheduled rollups | (no route — cron triggers) | `workers/cron` |
| SDK `f.js` | `https://example.com/f.js` (M1; see step 8) | served by console |

---

## 0. Prerequisites

- A **Cloudflare account** with the **Workers Paid plan** ($5/mo) — required
  because the ingest pipeline uses [Cloudflare Queues](https://developers.cloudflare.com/queues/).
  D1, KV, and Workers usage itself fit comfortably in included quotas for small/medium sites.
- A **domain added to Cloudflare** (its DNS zone must be on your account) for
  the routes `in.<domain>`, `api.<domain>`, and the console host.
- **Node.js 18+** and npm.
- Log in once: `npx wrangler login`, then note your account id from
  `npx wrangler whoami`.

## 1. Clone and install

```bash
git clone https://github.com/qiayue/pvuv.ai.git
cd pvuv.ai
npm install        # postinstall generates shared/config.gen.ts from config.example.toml
```

## 2. (Optional but recommended) private scoring config

Scoring weights and thresholds are read from config, never hardcoded. The
repo ships example defaults; production values belong in a gitignored file:

```bash
cp config.example.toml config.local.toml   # gitignored — tune privately
npm run config:gen                          # regenerate after every edit
```

If you skip this, the example defaults are used. Either way `config:gen`
runs automatically on `npm install` and before SDK builds.

## 3. Create the Cloudflare resources

```bash
npx wrangler d1 create pvuv-db                 # note the database_id it prints
npx wrangler kv namespace create BLOCKLIST     # note the id
npx wrangler kv namespace create SITE_CONFIG   # note the id
npx wrangler queues create pvuv-ingest
npx wrangler queues create pvuv-ingest-dlq     # dead-letter queue
```

## 4. Fill in the placeholders

Every `wrangler.toml` ships with `PLACEHOLDER_*` values. Replace them with
the ids from step 3 (from the repo root):

```bash
ACCOUNT_ID=...        # from `npx wrangler whoami`
D1_ID=...             # from `wrangler d1 create`
KV_BLOCKLIST_ID=...   # from `wrangler kv namespace create BLOCKLIST`
KV_SITE_CONFIG_ID=... # from `wrangler kv namespace create SITE_CONFIG`

sed -i "s/PLACEHOLDER_ACCOUNT_ID/$ACCOUNT_ID/" wrangler.toml workers/*/wrangler.toml
sed -i "s/PLACEHOLDER_D1_DATABASE_ID/$D1_ID/" wrangler.toml workers/*/wrangler.toml
sed -i "s/PLACEHOLDER_KV_BLOCKLIST_ID/$KV_BLOCKLIST_ID/" workers/*/wrangler.toml
sed -i "s/PLACEHOLDER_KV_SITE_CONFIG_ID/$KV_SITE_CONFIG_ID/" workers/*/wrangler.toml
```

> **Do not commit real ids to a public fork.** They are not secrets, but the
> project convention (PROJECT_PLAN.md §21–§22) keeps them out of the repo.
> Deploy from a private clone, or keep these edits uncommitted.

## 5. Set your domains

The route patterns default to `pvuv.ai`. Point them at your own zone:

- `workers/ingest/wrangler.toml` → `pattern = "in.example.com/*", zone_name = "example.com"`
- `workers/api/wrangler.toml` → `pattern = "api.example.com/*", zone_name = "example.com"`
- `workers/console/wrangler.toml` → `pattern = "example.com/*", zone_name = "example.com"`
  (or a subdomain like `console.example.com/*` — but then adjust the embed
  snippet's `data-api`, see step 9)
- `workers/console/wrangler.toml` `[vars] ADMIN_EMAILS` → your admin email(s),
  comma-separated. This build is **single-tenant**: everyone listed shares one
  site list (your own sites); anyone else is refused. Login is OAuth-only —
  you'll configure a provider in step 7.

Routes only fire for hostnames proxied by Cloudflare. If `in.` / `api.` have
no DNS records yet, add proxied placeholder records in the Cloudflare DNS
dashboard: type `AAAA`, name `in` (and `api`), content `100::`, proxy **on**.

## 6. Create the database schema

```bash
npm run db:migrate:remote     # = wrangler d1 migrations apply pvuv-db --remote
```

This creates all tables from `shared/schema.sql`, including the M2+
placeholder tables. (New monthly `events_YYYYMM` partitions are created
automatically by the consumer as time passes — no manual action needed.)

## 7. Deploy the Workers, then set secrets

```bash
npm run deploy:all
```

Then set the secrets. **Use the same `HMAC_KEY` value for all three
workers** — the console signs session cookies that the api worker verifies,
and the ingest worker signs the `_pv_v` verdict cookie:

```bash
openssl rand -base64 32        # generate one key, reuse it below

npx wrangler secret put HMAC_KEY  -c workers/ingest/wrangler.toml
npx wrangler secret put HMAC_KEY  -c workers/api/wrangler.toml
npx wrangler secret put HMAC_KEY  -c workers/console/wrangler.toml
npx wrangler secret put API_TOKEN -c workers/api/wrangler.toml   # for external/server-side API access
```

Secrets take effect immediately; no redeploy needed. Until `HMAC_KEY` is set,
`/in` and `/v` deliberately return 500 rather than run with a missing key.

**Console login is OAuth-only** — set up Google and/or GitHub before you can
sign in (next section covers it in detail). At minimum, for Google:

```bash
# set GOOGLE_CLIENT_ID in workers/console/wrangler.toml [vars], then:
npx wrangler secret put GOOGLE_CLIENT_SECRET -c workers/console/wrangler.toml
```

## 8. Build and host the SDK

```bash
npm run build:sdk                                   # → sdk/dist/f.js (~3 KB gzipped)
cp sdk/dist/f.js workers/console/public/f.js
npm run deploy:console
```

`f.js` is now served at `https://example.com/f.js`.

> **Note (M1).** The reference architecture serves the SDK from an isolated
> `js.` subdomain so that ad-blocker listings of exposed hosts never touch
> your dashboards (PROJECT_PLAN.md §1). Serving it from the console apex is
> the simple M1 path; moving it to `js.<domain>` (Workers Static Assets or
> R2) or a first-party reverse proxy (§12) needs no code changes later.

## 9. Register your first site

1. Open `https://example.com/login.html`, sign in with Google or GitHub
   (the email must be in `ADMIN_EMAILS`).
2. Click **New site**: name, the domain(s) the site runs on
   (e.g. `blog.example.org, www.blog.example.org`), adguard mode, optional
   AdSense client id, and the **timezone**. All stats (today / this month /
   daily rollups) are aggregated by this timezone's calendar day. It defaults
   to your account default (set it under the ⚙ gear → *Default timezone*) and
   **cannot be changed after the site is created** — pick the one you want to
   report in. Owners in any timezone can measure sites in any timezone; the
   choice only affects how days are drawn.
3. Copy the embed snippet it prints. It looks like:

```html
<script defer src="https://example.com/f.js"
        data-site="Ab3xK9pQ"
        data-api="https://in.example.com"
        data-adguard="balanced"
        data-adclient="ca-pub-xxxxxxxxxxxxxxxx"></script>
```

`data-api` must point at your ingest host — the SDK's built-in default is the
reference domain `in.pvuv.ai`, so self-hosted deployments should always set
it (the console generates it from your console hostname; adjust it if your
ingest host differs).

## 10. Verify

**Easiest: the built-in self-check.** Sign in to the console and open
**Self-check** (top bar), or go to `https://<your-console>/health.html`. It
walks every part of the deployment — database, migrations, secrets, config,
KV, the ingest endpoint, a real end-to-end test event (ingest → Queue →
consumer → D1, with enrichment + scoring), and the `/v` verdict — and tells
you exactly what to fix for anything that fails. It uses a hidden
`__pvuv_selftest` site, so your real analytics stay untouched.

Or check manually:

```bash
# ingest is alive (400 "bad json" on an empty body = worker up and reachable):
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://in.example.com/in
# with a body but a foreign Origin you'll get 204 (event silently dropped);
# a request with no Origin/Referer at all gets 403

# watch live logs while you visit your site:
npx wrangler tail -c workers/ingest/wrangler.toml
npx wrangler tail -c workers/consumer/wrangler.toml
```

Then visit a page that has the snippet and check, in the browser dev tools,
that `POST /in` returns **204**. Data timeline:

- **Immediately**: events appear in the console's *High-score traffic*
  drill-down (it reads raw events).
- **Within the hour**: metric cards / charts / breakdowns fill in — they read
  the pre-aggregated rollups, which the cron worker recomputes at `:05` every
  hour.

## Google / GitHub login (required)

The console is **OAuth-only** — sign in with Google and/or GitHub; there is no
password login. A provider appears on the sign-in page only when both its
client id and secret are set, so you must configure at least one.

**Single-tenant / admin allowlist.** OAuth is authentication, not open
registration. Only emails listed in `ADMIN_EMAILS` (comma-separated, in
`workers/console/wrangler.toml`) may sign in; anyone else is refused with
"not an admin". Every admin shares **one** site list (your own sites) — a
verified email is the identity, so Google and GitHub under the same address
are the same account. (Running a true multi-tenant instance where strangers
register their own separate accounts is out of scope for this open-source
build.)

**Google:** in [Google Cloud Console](https://console.cloud.google.com/) →
APIs & Services → Credentials, create an OAuth client (type: Web application)
with authorized redirect URI `https://<your-console-domain>/api/auth/google/callback`.
Then:

```bash
# set GOOGLE_CLIENT_ID in workers/console/wrangler.toml [vars], and:
npx wrangler secret put GOOGLE_CLIENT_SECRET -c workers/console/wrangler.toml
npm run deploy:console
```

**GitHub:** in GitHub → Settings → Developer settings → OAuth Apps → New OAuth
App, set Authorization callback URL
`https://<your-console-domain>/api/auth/github/callback`. Then:

```bash
# set GITHUB_CLIENT_ID in workers/console/wrangler.toml [vars], and:
npx wrangler secret put GITHUB_CLIENT_SECRET -c workers/console/wrangler.toml
npm run deploy:console
```

Redeploy the console after changing `[vars]`; secrets take effect immediately.

## Customize the homepage

Your deployment's `/` is a public landing page. Three tiers, no forking needed:

1. **Name + description (no code).** Console → sign in → *Homepage settings*:
   set your site name and description; the default page renders them
   (server-side, also in `<title>` and `<meta name="description">`).
2. **Fully custom page.** Create `workers/console/public/home.html` with any
   HTML you like and redeploy the console — it replaces the default homepage
   entirely. The file is **gitignored**, so your landing copy never enters
   the public repo and `git pull` never conflicts. This is also how the
   official pvuv.ai homepage is expected to work. The attribution footer is
   appended to the page automatically by the worker — you don't need to
   (and shouldn't) write it into your HTML yourself.
3. **Default.** Do nothing and you get the minimal shipped page.

Whichever tier you use, the homepage carries the footer attribution links
(pvuv.ai + GitHub); free deployments must keep them — see README
"Attribution".
The default page is intentionally sparse so that thousands of deployments
don't publish identical landing copy (duplicate content in search engines).

## First-party reverse proxy (optional, blocker-resistant)

By default the SDK loads from your console and reports to `in.<domain>` — a
third-party host that ad/tracker blockers eventually list. For maximum accuracy
you can serve `f.js` and the reporting endpoints as **first-party** requests on
the measured site's own domain via `workers/proxy` (§12). It is NOT part of
`npm run deploy:all` — deploy it separately.

1. Edit `workers/proxy/wrangler.toml`: set the `route` to a path prefix on your
   measured domain (e.g. `example.com/_pv/*`), and the `[vars]` `UPSTREAM_INGEST`
   / `UPSTREAM_ASSETS` to your ingest host and console.
2. Share a secret between the proxy and ingest so ingest trusts the forwarded
   client context (real IP/ASN/geo) — without it a proxied request would look
   like it came from Cloudflare and mis-score:
   ```bash
   openssl rand -base64 32   # one value, set on BOTH workers
   npx wrangler secret put PROXY_TOKEN -c workers/proxy/wrangler.toml
   npx wrangler secret put PROXY_TOKEN -c workers/ingest/wrangler.toml
   ```
3. Deploy: `npm run deploy:proxy` (and redeploy ingest so it picks up the secret).
4. Point the embed at the proxy — first-party src + data-api:
   ```html
   <script defer src="https://example.com/_pv/f.js"
           data-site="Ab3xK9pQ" data-api="https://example.com/_pv"></script>
   ```

The proxy forwards the real client IP/ASN/timezone/geo as signed `x-pv-*`
headers; ingest trusts them ONLY when `x-pv-proxy` matches `PROXY_TOKEN`, so a
direct client can't spoof its IP. If `PROXY_TOKEN` is unset on ingest, forwarded
headers are ignored (direct embed keeps working unchanged).

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `/in` returns 500 | `HMAC_KEY` secret not set on the ingest worker |
| `/in` returns 204 but no data | The page's `Origin` host doesn't match the site's `allowed_domains` (mismatches are dropped silently by design) — check the domains you registered; note the KV site cache refreshes within 5 minutes of a site edit |
| `/in` returns 403 | Request has no `Origin`/`Referer` header (server-to-server calls are rejected) |
| Cards empty, drill-down has data | Rollups run hourly at `:05` — wait for the next run |
| Can't sign in / "not an admin" | your email isn't in `ADMIN_EMAILS`, or no OAuth provider is configured |
| API returns 401 | Missing/wrong `Authorization: Bearer <API_TOKEN>` or console session cookie |
| Queue errors on deploy | Queues need the Workers Paid plan; both `pvuv-ingest` and `pvuv-ingest-dlq` must exist |

## Local development

No Cloudflare resources needed — everything runs in miniflare:

```bash
npm install
npx wrangler d1 migrations apply pvuv-db --local --persist-to .wrangler/dev

# seed a site for testing (console flow works too):
npx wrangler d1 execute pvuv-db --local --persist-to .wrangler/dev --command \
  "INSERT INTO sites (site_id,name,owner_id,allowed_domains,adguard_mode,created_at)
   VALUES ('Ab3xK9pQ','dev','admin','[\"localhost\"]','balanced',0)"

# ingest + consumer share a local queue when run in ONE dev session:
npx wrangler dev -c workers/ingest/wrangler.toml -c workers/consumer/wrangler.toml \
  --persist-to .wrangler/dev --port 8788 --var HMAC_KEY:dev-key

# console (separate terminal is fine — but stop other dev sessions using the
# same persist dir before starting a new one):
npx wrangler dev -c workers/console/wrangler.toml --persist-to .wrangler/dev \
  --port 8790 --var HMAC_KEY:dev-key --var ADMIN_EMAILS:you@example.com \
  --var GOOGLE_CLIENT_ID:... --var GOOGLE_CLIENT_SECRET:...

# trigger the hourly rollup locally:
npx wrangler dev -c workers/cron/wrangler.toml --persist-to .wrangler/dev \
  --port 8791 --test-scheduled
curl "http://localhost:8791/__scheduled?cron=5+*+*+*+*"
```

Point a test page's snippet at `data-api="http://localhost:8788"`.

## Updating a deployment

```bash
git pull
npm install                   # regenerates config.gen.ts
npm run db:migrate:remote     # applies any new migrations (no-op otherwise)
npm run build:sdk && cp sdk/dist/f.js workers/console/public/f.js
npm run deploy:all
```
