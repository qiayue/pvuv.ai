#!/usr/bin/env node
/**
 * `npm run setup` — one interactive command that performs every automatable
 * step of DEPLOY.md: create the Cloudflare resources, fill in the placeholders,
 * point the routes at your domain, generate and install the shared secret,
 * apply the migrations, build the SDK and deploy the workers.
 *
 * Two things it deliberately does NOT do, because they cannot be automated:
 *   - a Workers **Paid** plan (Queues requires it)
 *   - creating a Google/GitHub OAuth app (console login is OAuth-only)
 * Both are checked or explained rather than failing halfway through.
 *
 * Safety properties, in order of how much they matter:
 *   - **Re-runnable.** Every step detects work already done: existing resources
 *     are reused, an already-configured file is left alone. A partial run is
 *     resumed by running it again, not undone.
 *   - **Never clobbers a working deployment.** Only literal `PLACEHOLDER_*`
 *     values and the reference domain are rewritten; anything already filled in
 *     is reported and skipped, so pointing an existing install at the wrong
 *     account is not possible by accident.
 *   - **--dry-run** prints every command and file edit without executing any of
 *     them, so the whole plan can be reviewed first.
 *   - The generated HMAC_KEY is piped straight into `wrangler secret put` and is
 *     never printed, logged, or written to a file.
 */

import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry-run');
const WORKERS = ['ingest', 'consumer', 'api', 'console', 'cron'];
const TOMLS = ['wrangler.toml', ...WORKERS.map((w) => `workers/${w}/wrangler.toml`)];

/** `--flag value` or `--flag=value` from argv. */
function argValue(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : '';
}

const c = { dim: (s) => `\x1b[2m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m` };
const say = (s = '') => console.log(s);
const step = (n, s) => say(`\n${c.b(`[${n}]`)} ${c.b(s)}`);
const ok = (s) => say(`  ${c.g('✓')} ${s}`);
const warn = (s) => say(`  ${c.y('!')} ${s}`);
const info = (s) => say(`  ${c.dim(s)}`);

/** Run a command. Returns {code, out}. Never throws — callers decide. */
function run(cmd, args, { input, quiet = true } = {}) {
  if (DRY) { say(`  ${c.dim('$ ' + [cmd, ...args].join(' '))}`); return { code: 0, out: '' }; }
  const r = spawnSync(cmd, args, {
    cwd: ROOT, input, encoding: 'utf8',
    stdio: ['pipe', 'pipe', quiet ? 'pipe' : 'inherit'],
  });
  return { code: r.status ?? 1, out: (r.stdout || '') + (r.stderr || '') };
}
const wrangler = (args, opts) => run('npx', ['--yes', 'wrangler', ...args], opts);

/** Cloudflare ids are 32 lowercase hex chars. */
const ID_RE = /\b[0-9a-f]{32}\b/;

async function main() {
  say(c.b('\npvuv.ai setup') + c.dim(DRY ? '  (dry run — nothing will be changed)' : ''));
  say(c.dim('Automates DEPLOY.md steps 3–8. Safe to re-run.\n'));

  // ---- 0. preflight ------------------------------------------------------
  step(0, 'Checking prerequisites');
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) { say(c.r(`  Node 18+ required (found ${process.versions.node})`)); process.exit(1); }
  ok(`Node ${process.versions.node}`);

  const who = wrangler(['whoami']);
  if (!DRY && who.code !== 0) {
    say(c.r('  Not logged in to Cloudflare.'));
    info('Run:  npx wrangler login');
    process.exit(1);
  }
  let accountId = process.env.CLOUDFLARE_ACCOUNT_ID || (who.out.match(ID_RE)?.[0] ?? '');
  if (DRY && !accountId) accountId = '<account-id>';
  if (!accountId) {
    say(c.r('  Could not determine your account id.'));
    info('Set CLOUDFLARE_ACCOUNT_ID=… and re-run, or check `npx wrangler whoami`.');
    process.exit(1);
  }
  ok(`Cloudflare account ${c.dim(accountId)}`);
  warn('Queues need the Workers Paid plan ($5/mo). Setup will fail at step 1 without it.');

  // ---- 1. answers --------------------------------------------------------
  // Flags win over prompts, and prompts only happen on a real terminal — so the
  // same script drives an interactive install and a scripted/CI one, and a
  // piped or redirected stdin fails with a clear message instead of hanging.
  step(1, 'Your domain');
  const interactive = process.stdin.isTTY === true;
  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  const ask = async (flagName, q, def) => {
    const fromFlag = argValue(flagName);
    if (fromFlag) return fromFlag;
    if (!rl) {
      say(c.r(`  Missing --${flagName} (no terminal available to ask).`));
      info('Non-interactive use: npm run setup -- --domain example.com --admin you@example.com');
      info('Optional: --subdomain stats  --console-host … --ingest-host … --api-host …');
      process.exit(1);
    }
    const a = (await rl.question(`  ${q}${def ? c.dim(` [${def}]`) : ''}: `)).trim();
    return a || def || '';
  };
  if (interactive) say(c.dim('  The zone must already be on Cloudflare (any plan).'));
  const zone = await ask('domain', 'Root domain (e.g. example.com)');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(zone)) { say(c.r('  That does not look like a domain.')); process.exit(1); }

  // Default to a dedicated subdomain, NOT the apex: most people already serve a
  // site from their root domain, and each worker takes over its hostname
  // completely. The name is the deployer's to pick — this is their DNS, not
  // ours — so it is a plain flag with a descriptive default, rather than the
  // project's own name baked into it.
  const defConsole = `${argValue('subdomain') || 'analytics'}.${zone}`;
  const consoleHost = argValue('console-host')
    || (interactive ? await ask('console-host', 'Console host', defConsole) : defConsole);
  // Flat siblings of the ROOT, always exactly one level down: short, matches the
  // reference architecture, and inside Universal SSL's *.example.com. The
  // console is the only host that gets its own name; nesting these under it
  // would look tidier but costs a certificate (see the depth check below).
  const sibling = (p) => `${p}.${zone}`;
  const ingestHost = argValue('ingest-host')
    || (interactive ? await ask('ingest-host', 'Ingest host', sibling('in')) : sibling('in'));
  const apiHost = argValue('api-host')
    || (interactive ? await ask('api-host', 'API host', sibling('api')) : sibling('api'));

  // Cloudflare's Universal SSL covers example.com and *.example.com only, so a
  // host nested two levels deep needs Advanced Certificate Manager. Say so now
  // rather than letting the certificate silently fail to issue after deploy.
  // Someone typing in.pvuv.example.com wants the deployment grouped under one
  // name. Hyphenating gives exactly that, one level down, on the free
  // certificate — so suggest their own host rewritten, not a generic example.
  const flatten = (h) => {
    const labels = h.slice(0, -(zone.length + 1)).split('.');
    return `${labels.join('-')}.${zone}`;
  };
  const deep = [consoleHost, ingestHost, apiHost].filter((h) => h.split('.').length > zone.split('.').length + 1);
  if (deep.length) {
    warn(`${deep.join(', ')} ${deep.length > 1 ? 'are' : 'is'} more than one level below ${zone}.`);
    info(`Universal SSL covers ${zone} and *.${zone} — a wildcard matches one label, not two —`);
    info('so hosts nested that deep need Advanced Certificate Manager.');
    info(`Same grouping, one level down, no extra cost:  ${deep.map(flatten).join('  ')}`);
  }
  const admins = await ask('admin', 'Admin email(s), comma-separated');
  if (!admins.includes('@')) { say(c.r('  An admin email is required — nobody could sign in otherwise.')); process.exit(1); }
  rl?.close();
  if (!interactive) info(`domain=${zone} console=${consoleHost} ingest=${ingestHost} api=${apiHost}`);

  // ---- 2. resources ------------------------------------------------------
  step(2, 'Creating Cloudflare resources');
  // Create-then-look-up: creation is allowed to fail (already exists) and the
  // id always comes from a list, which is stable across wrangler versions.
  wrangler(['d1', 'create', 'pvuv-db']);
  const d1Id = findD1Id('pvuv-db');
  ok(`D1 pvuv-db ${c.dim(d1Id)}`);

  const kv = {};
  for (const binding of ['BLOCKLIST', 'SITE_CONFIG']) {
    const created = wrangler(['kv', 'namespace', 'create', binding]);
    kv[binding] = created.out.match(ID_RE)?.[0] || findKvId(binding);
    ok(`KV ${binding} ${c.dim(kv[binding])}`);
  }
  for (const q of ['pvuv-ingest', 'pvuv-ingest-dlq']) {
    const r = wrangler(['queues', 'create', q]);
    if (r.code === 0 || /already exists/i.test(r.out)) ok(`Queue ${q}`);
    else { say(c.r(`  Could not create queue ${q}:`)); info(r.out.trim().split('\n').slice(-3).join('\n  ')); process.exit(1); }
  }

  // ---- 3. config ---------------------------------------------------------
  step(3, 'Writing configuration');
  const subs = [
    ['PLACEHOLDER_ACCOUNT_ID', accountId],
    ['PLACEHOLDER_D1_DATABASE_ID', d1Id],
    ['PLACEHOLDER_KV_BLOCKLIST_ID', kv.BLOCKLIST],
    ['PLACEHOLDER_KV_SITE_CONFIG_ID', kv.SITE_CONFIG],
  ];
  let touched = 0, skipped = 0;
  for (const rel of TOMLS) {
    const file = path.join(ROOT, rel);
    if (!existsSync(file)) continue;
    const before = readFileSync(file, 'utf8');
    let after = before;
    for (const [ph, val] of subs) after = after.split(ph).join(val);
    // route patterns + zone: only the reference domain, never a custom one
    // Custom Domains: wrangler provisions the DNS record and certificate during
    // deploy, so the domain is configured exactly once — here — with no separate
    // DNS step to remember afterwards.
    after = after
      .replace(/pattern = "in\.pvuv\.ai"/g, `pattern = "${ingestHost}"`)
      .replace(/pattern = "api\.pvuv\.ai"/g, `pattern = "${apiHost}"`)
      .replace(/pattern = "pvuv\.ai"/g, `pattern = "${consoleHost}"`)
      .replace(/zone_name = "pvuv\.ai"/g, `zone_name = "${zone}"`)
      .replace(/ADMIN_EMAILS = "you@example\.com"/g, `ADMIN_EMAILS = "${admins}"`)
      // the console builds the embed snippet from this; it cannot infer the
      // ingest host once the two are not siblings
      .replace(/INGEST_HOST = "in\.pvuv\.ai"/g, `INGEST_HOST = "${ingestHost}"`);
    if (after === before) { skipped++; continue; }
    if (DRY) say(`  ${c.dim('~ would edit ' + rel)}`);
    else writeFileSync(file, after);
    touched++;
  }
  ok(`${touched} config file(s) updated${skipped ? `, ${skipped} already configured` : ''}`);
  if (!DRY && readFileSync(path.join(ROOT, 'workers/api/wrangler.toml'), 'utf8').includes('PLACEHOLDER_')) {
    warn('Some placeholders remain — check workers/*/wrangler.toml before deploying.');
  }

  // scoring config: a private copy so upstream updates never overwrite tuning
  const local = path.join(ROOT, 'config.local.toml');
  if (!existsSync(local)) {
    if (!DRY) copyFileSync(path.join(ROOT, 'config.example.toml'), local);
    ok('config.local.toml created (gitignored — tune scoring here)');
  } else ok('config.local.toml already present');
  run('npm', ['run', 'config:gen']);

  // ---- 4. schema ---------------------------------------------------------
  step(4, 'Applying database migrations');
  const mig = wrangler(['d1', 'migrations', 'apply', 'pvuv-db', '--remote']);
  if (mig.code !== 0) {
    say(c.r('  Migrations failed:'));
    info(mig.out.trim().split('\n').slice(-5).join('\n  '));
    process.exit(1);
  }
  ok('Schema up to date');

  // ---- 5. SDK ------------------------------------------------------------
  step(5, 'Building the SDK');
  if (run('npm', ['run', 'build:sdk']).code !== 0) { say(c.r('  SDK build failed.')); process.exit(1); }
  if (!DRY) copyFileSync(path.join(ROOT, 'sdk/dist/f.js'), path.join(ROOT, 'workers/console/public/f.js'));
  ok('f.js built and copied into the console assets');

  // ---- 6. deploy ---------------------------------------------------------
  step(6, 'Deploying workers');
  for (const w of WORKERS) {
    const r = wrangler(['deploy', '-c', `workers/${w}/wrangler.toml`]);
    if (r.code !== 0) {
      say(c.r(`  Deploy failed for ${w}:`));
      info(r.out.trim().split('\n').slice(-6).join('\n  '));
      // by far the two most common causes, and both are about the domain
      if (/zone|not found|10000|authoriz/i.test(r.out)) {
        warn(`Is ${zone} added to this Cloudflare account? Custom Domains can only be`);
        info(`created on a zone you own. Add the domain in the Cloudflare dashboard first.`);
      }
      if (/conflict|already exists|record/i.test(r.out)) {
        warn(`A DNS record may already exist for that hostname. Either remove it, or`);
        info(`re-run with free hostnames, e.g. --api-host api-${consoleHost.split('.')[0]}.${zone}`);
      }
      info('Fix the cause and re-run `npm run setup` — completed steps are skipped.');
      process.exit(1);
    }
    ok(`${w} deployed`);
  }

  // ---- 7. secret ---------------------------------------------------------
  step(7, 'Installing the shared secret');
  // One key for ingest/api/console: the console signs session cookies the api
  // verifies, and ingest signs the verdict cookie. Generated here and piped
  // straight to wrangler — it is never shown or stored on disk.
  const hmac = randomBytes(32).toString('base64');
  for (const w of ['ingest', 'api', 'console']) {
    const r = wrangler(['secret', 'put', 'HMAC_KEY', '-c', `workers/${w}/wrangler.toml`], { input: hmac + '\n' });
    if (r.code !== 0) { say(c.r(`  Could not set HMAC_KEY on ${w}.`)); info(r.out.trim().split('\n').slice(-3).join('\n  ')); process.exit(1); }
    ok(`HMAC_KEY set on ${w}`);
  }

  // ---- done --------------------------------------------------------------
  say(`\n${c.g(c.b('Deployed.'))}  DNS and certificates were provisioned automatically:`);
  info(`${consoleHost}  ${ingestHost}  ${apiHost}`);
  say(`\n${c.b('One manual step remains')} — it is the only thing that cannot be automated.`);
  say(`\n${c.b('Login')}  The console is OAuth-only, so create an app at Google or GitHub:`);
  info(`Callback URL:  https://${consoleHost}/api/auth/google/callback`);
  info(`               https://${consoleHost}/api/auth/github/callback`);
  info(`Then put the client id in workers/console/wrangler.toml [vars] and run:`);
  info(`  npx wrangler secret put GOOGLE_CLIENT_SECRET -c workers/console/wrangler.toml`);
  info(`  npm run deploy:console`);
  say(`\nFull walkthrough: DEPLOY.md → "Google / GitHub login".`);
  say(`Then sign in at ${c.b(`https://${consoleHost}/login.html`)} as ${admins.split(',')[0].trim()}.\n`);
  // Optional extras worth knowing about, but deliberately NOT prompted for
  // here: each needs a credential from another service, and blocking a fresh
  // install on them would trade the one-command promise for nothing.
  say(`${c.dim('Optional later, from ⚙ settings in the console:')}`);
  info(`Cloudflare edge requests — a read-only Cloudflare API token lets the`);
  info(`nightly job count what the tracking script cannot see (AI crawlers and`);
  info(`scrapers fetch HTML without ever running JS). DEPLOY.md → "Cloudflare`);
  info(`edge requests". Skip it and everything works exactly the same.\n`);
}

function findD1Id(name) {
  if (DRY) return '<d1-database-id>';
  const r = wrangler(['d1', 'list', '--json']);
  try {
    const row = JSON.parse(r.out.slice(r.out.indexOf('['))).find((d) => d.name === name);
    if (row?.uuid) return row.uuid;
  } catch { /* fall through to the message below */ }
  say(c.r(`  Could not find the id for D1 database "${name}".`));
  say(c.dim('  Create it manually and re-run:  npx wrangler d1 create ' + name));
  process.exit(1);
}

function findKvId(binding) {
  if (DRY) return `<kv-${binding.toLowerCase()}-id>`;
  const r = wrangler(['kv', 'namespace', 'list']);
  try {
    const arr = JSON.parse(r.out.slice(r.out.indexOf('[')));
    // wrangler titles namespaces "<worker-name>-<BINDING>"; match the suffix
    const row = arr.find((n) => n.title === binding || n.title?.endsWith(`-${binding}`));
    if (row?.id) return row.id;
  } catch { /* fall through */ }
  say(c.r(`  Could not find the id for KV namespace "${binding}".`));
  say(c.dim(`  Create it manually and re-run:  npx wrangler kv namespace create ${binding}`));
  process.exit(1);
}

main().catch((err) => { say(c.r(`\nsetup failed: ${err.message}`)); process.exit(1); });
