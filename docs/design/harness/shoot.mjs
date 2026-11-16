// Screenshots of the P2 portfolio screens with mocked data.
//   NODE_PATH=$(npm root -g) node docs/design/harness/shoot.mjs
// Serves the repo over http (console assets at their deployed paths), renders
// docs/design/harness/p2.html for drawer / cards / heatmap / bulk and the real
// settings.html with /api/* mocked, and writes docs/design/screens/p2-*.png.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = resolve(new URL('../../..', import.meta.url).pathname);
const PUB = join(ROOT, 'workers/console/public');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const LANG = process.env.LANG_UI || 'zh';

const server = http.createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  for (const base of [PUB, ROOT]) {
    const f = join(base, p);
    if (!f.startsWith(base)) continue;
    try { if ((await stat(f)).isFile()) { res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' }); res.end(await readFile(f)); return; } } catch { /* next */ }
  }
  res.writeHead(404); res.end('not found');
});
await new Promise((r) => server.listen(0, r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const out = (n) => join(ROOT, 'docs/design/screens', `p2-${n}.png`);

async function page(w, h) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
  await ctx.addInitScript((lang) => localStorage.setItem('pvuv.lang', lang), LANG);
  return ctx.newPage();
}
for (const [show, w, h] of [['drawer', 1440, 960], ['cards', 1440, 900], ['heatmap', 1440, 900], ['bulk', 1200, 560]]) {
  const pg = await page(w, h);
  pg.on('pageerror', (e) => console.error(show, e.message));
  await pg.goto(`${origin}/docs/design/harness/p2.html?show=${show}&lang=${LANG}`);
  await pg.waitForTimeout(show === 'drawer' ? 700 : 300);
  if (show === 'bulk') { await pg.click('[data-bulk="tag"]'); await pg.fill('.p2-pop input', '小游戏'); }
  await pg.screenshot({ path: out(show) });
  console.log('wrote', out(show));
}

// settings.html against mocked endpoints
const MOCK = {
  '/api/home': { name: 'pvuv.ai', description: '', primary_domain: '', logo_light: '', logo_dark: '', favicon: '' },
  '/api/me': { user: 'admin', timezone: 'Asia/Shanghai', ingest_host: '' },
  '/api/settings/portfolio': { growth_uv_7d: 1000, growth_min_delta_pct: -10, decline_pct: 30, ivt_pct: 20,
    defaults: { growth_uv_7d: 1000, growth_min_delta_pct: -10, decline_pct: 30, ivt_pct: 20 } },
  '/api/sites': { sites: [{ site_id: 'Ab3xK9pQ', name: 'Pixel Golf' }] },
  '/api/tokens': { tokens: [
    { token_id: 't1', name: 'CLI', prefix: 'pvuv_8kQ2', site_id: null, permission: 'read', last_used_at: Date.UTC(2026, 10, 15) },
    { token_id: 't2', name: 'Site launcher', prefix: 'pvuv_Zr71', site_id: null, permission: 'write', last_used_at: Date.UTC(2026, 10, 16) },
    { token_id: 't3', name: 'crawler reports', prefix: 'pvuv_q0Pd', site_id: 'Ab3xK9pQ', permission: 'ingest', last_used_at: null }] },
  '/api/templates': { templates: [] },
  '/api/settings/ai': { provider: 'openai', model: '', base_url: '', lang: 'zh', key_set: false },
  '/api/settings/cfedge': { token_set: false, status: null },
  '/api/settings/botdir': { imported: false },
  '/api/storage': { est_total_mb: 812.4, total_events: 1043210, sessions: 220311, profiles: 81233, retention: { raw_events_days: 90 }, partitions: [] },
};
for (const sec of ['portfolio', 'tokens']) {
  const pg = await page(1440, 900);
  pg.on('pageerror', (e) => console.error('settings', e.message));
  await pg.route('**/api/**', (route) => {
    const p = new URL(route.request().url()).pathname;
    route.fulfill({ status: MOCK[p] ? 200 : 404, contentType: 'application/json', body: JSON.stringify(MOCK[p] || { error: 'not mocked' }) });
  });
  await pg.goto(`${origin}/settings.html#${sec}`);
  await pg.waitForTimeout(400);
  const name = sec === 'portfolio' ? 'settings' : 'settings-tokens';
  await pg.screenshot({ path: out(name) });
  console.log('wrote', out(name));
}
await browser.close();
server.close();
