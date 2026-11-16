/**
 * pvuv.ai console — site preview drawer (portfolio stream P2).
 *
 *   window.pvuvDrawer = { open(site, ctx), close(), isOpen() }
 *
 * `site` is one entry of the portfolio contract's `sites[]`
 * (docs/design/portfolio-ui.md §3.1). `ctx` = { period, t, te, esc, fmt, ui }
 * plus two optional hooks: `onChange(site)` after a label / status / ad-guard
 * change made here, and `apiBase` (default '/api'). Everything else the drawer
 * shows is fetched from existing per-site endpoints:
 *   /api/sites/:id/timeseries?metric=uv&period=30d   clean visitors + invalid share per day
 *   /api/sites/:id/crawlers?period=7d&search=1        per-engine crawl table
 *   /api/sites/:id/experiments?period=30d             running experiments
 * and writes through POST /api/sites/:id/adguard, PUT /api/sites/:id/labels and
 * POST /api/sites/bulk (archive / restore).
 *
 * Modal side pane: Esc and the scrim close it, Tab is trapped inside, focus
 * returns to whatever opened it. No dependency on the overview page.
 */
(function () {
  'use strict';

  // ── tiny shared kit (also defined, identically, by views.js) ──────────────
  function makeKit() {
    var I = function () { return window.PVI18N; };
    function tr(ctx, s) { return ctx && typeof ctx.t === 'function' ? ctx.t(s) : (I() ? I().t(s) : s); }
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
    /** translate a key with an English fallback when the key itself comes back */
    function tk(ctx, key, en) { var v = tr(ctx, key); return v === key ? (en == null ? key : en) : v; }
    function fill(s, p) { return String(s).replace(/\{(\w+)\}/g, function (m, k) { return p && p[k] != null ? p[k] : m; }); }
    function num(n) { return n == null || isNaN(n) ? '–' : Number(n).toLocaleString('en-US'); }
    function pct(n, d) { return n == null || isNaN(n) ? '–' : Number(n).toFixed(d == null ? 1 : d) + '%'; }
    /** neutral bordered initial tile (contract: no coloured avatars) */
    function avatar(site, cls) {
      var name = (site && (site.name || (site.domains || [])[0])) || '?';
      var ch = Array.from(String(name).trim())[0] || '?';
      return '<span class="p2-av' + (cls ? ' ' + cls : '') + '" aria-hidden="true">' + esc(ch.toUpperCase()) + '</span>';
    }
    var STAGE = { setup: 'Awaiting install', awaiting_crawl: 'Awaiting crawl', crawled: 'Crawled', organic: 'Organic traffic', growing: 'Stable growth', declining: 'Declining', archived: 'Archived' };
    function stageChip(ctx, stage) {
      if (!stage) return '';
      return '<span class="p2-stage s-' + esc(stage) + '"><i></i>' + esc(tr(ctx, STAGE[stage] || stage)) + '</span>';
    }
    function delta(d) {
      if (d == null || isNaN(d)) return '';
      var up = d >= 0;
      return '<small class="' + (up ? 'p2-up' : 'p2-dn') + '">' + (up ? '+' : '−') + Math.abs(d).toFixed(Math.abs(d) < 10 ? 1 : 0).replace(/\.0$/, '') + '%</small>';
    }
    /** thin 1.5px line sparkline, no fill; red when the period's change is negative */
    function spark(vals, o) {
      o = o || {};
      var w = o.w || 300, h = o.h || 36;
      var v = (vals || []).map(function (x) { return x == null || isNaN(x) ? 0 : Number(x); });
      if (v.length < 2) v = [0, 0].concat(v).slice(-2);
      var max = o.max != null ? o.max : Math.max.apply(null, v.concat([1]));
      var line = v.map(function (x, i) { return (i / (v.length - 1) * w).toFixed(1) + ',' + (h - 2 - (max ? x / max : 0) * (h - 5)).toFixed(1); }).join(' ');
      return '<svg viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" role="img" aria-label="' + esc(o.label || '') + '">'
        + '<polyline fill="none" stroke="' + (o.neg ? 'var(--p2-down)' : 'var(--p2-accent)') + '" stroke-width="1.5" vector-effect="non-scaling-stroke" stroke-linejoin="round" points="' + line + '"/></svg>';
    }
    var ICONS = {
      x: '<path d="M6 6l12 12M18 6L6 18"/>',
      star: '<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/>',
      alert: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17.2v.1"/>',
      tag: '<path d="M3.5 12.5V4.5h8l9 9-8 8z"/><path d="M8 8.5v.1"/>',
      archive: '<path d="M4 5h16v4H4z"/><path d="M5.5 9v10h13V9M10 13h4"/>',
      restore: '<path d="M4 12a8 8 0 1 0 2.4-5.7L4 8.5"/><path d="M4 4v4.5h4.5"/>',
      download: '<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19h14"/>',
      shield: '<path d="M12 3.5l7 3v5.5c0 4.2-3 7.4-7 8.5-4-1.1-7-4.3-7-8.5V6.5z"/>',
      arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
      eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
      search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
      spark: '<path d="M12 3.5l1.8 5.2 5.2 1.8-5.2 1.8L12 17.5l-1.8-5.2L5 10.5l5.2-1.8z"/>',
    };
    function icon(n) { return '<svg class="p2-i" viewBox="0 0 24 24" aria-hidden="true">' + (ICONS[n] || '') + '</svg>'; }
    function toast(msg, isErr) {
      var el = document.createElement('div');
      el.className = 'p2-toast' + (isErr ? ' err' : '');
      el.setAttribute('role', 'status');
      el.textContent = msg;
      document.body.appendChild(el);
      setTimeout(function () { el.remove(); }, 3200);
    }
    function api(ctx, path, opts) {
      var base = (ctx && ctx.apiBase) || '/api';
      opts = opts || {};
      var init = { method: opts.method || 'GET', credentials: 'same-origin', headers: {} };
      if (opts.body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
      return fetch(base + path, init).then(function (r) {
        if (r.status === 401) { location.href = '/login.html'; throw new Error('auth'); }
        return r.json().catch(function () { return {}; }).then(function (d) {
          if (!r.ok) { var e = new Error(d && d.error || ('HTTP ' + r.status)); e.status = r.status; throw e; }
          return d;
        });
      });
    }
    return { tr: tr, tk: tk, esc: esc, fill: fill, num: num, pct: pct, avatar: avatar, stageChip: stageChip, delta: delta, spark: spark, icon: icon, toast: toast, api: api, STAGE: STAGE };
  }
  var K = window.__pvuvP2Kit || (window.__pvuvP2Kit = makeKit());

  // ── attention → text + one-click fixes ────────────────────────────────────
  var SEV = { critical: 0, high: 1, normal: 2 };
  var ATTN_EN = {
    no_data_24h: 'No events received in the last 24 hours — check the embed snippet.',
    crawl_overdue: 'Live for {days_live} days and no search engine has crawled it yet.',
    organic_overdue: 'First crawled {days} days ago, still no organic-search visitor.',
    declining: 'Clean visitors down {delta_pct}% over 28 days.',
    ivt_high: 'Invalid traffic at {ivt_pct}% while ad protection is “{adguard_mode}”.',
    ivt_spike: 'Invalid traffic jumped to {ivt_pct}%.',
  };
  function attnText(ctx, a, site) {
    var p = Object.assign({ days_live: site.days_live, ivt_pct: site.ivt_pct, delta_pct: site.delta_pct, adguard_mode: site.adguard_mode }, a.params || {});
    if (p.adguard_mode) p.adguard_mode = K.tr(ctx, p.adguard_mode);
    if (typeof p.delta_pct === 'number') p.delta_pct = Math.abs(p.delta_pct).toFixed(0);
    if (typeof p.ivt_pct === 'number') p.ivt_pct = p.ivt_pct.toFixed(1).replace(/\.0$/, '');
    return K.fill(K.tk(ctx, 'attn.' + a.code, ATTN_EN[a.code] ? K.tr(ctx, ATTN_EN[a.code]) : a.code.replace(/_/g, ' ')), p);
  }
  /** fixes per attention code: [{label, primary?, href?|run?}] */
  function fixes(ctx, a, site) {
    var rep = '/site.html?id=' + encodeURIComponent(site.site_id);
    var out = [];
    if ((a.code === 'ivt_high' || a.code === 'ivt_spike') && (site.adguard_mode || 'off') === 'off') {
      out.push({ label: K.tr(ctx, 'Enable “Balanced” protection'), primary: true, run: 'adguard' });
    }
    if (a.code === 'ivt_high' || a.code === 'ivt_spike') out.push({ label: K.tr(ctx, 'View suspicious sources'), href: rep + '#suspicious' });
    if (a.code === 'no_data_24h') {
      out.push({ label: K.tr(ctx, 'Run self-check'), primary: true, href: '/health.html' });
      out.push({ label: K.tr(ctx, 'Open full report'), href: rep });
    }
    if (a.code === 'crawl_overdue' || a.code === 'organic_overdue') out.push({ label: K.tr(ctx, 'Crawler report'), href: rep + '#indexing' });
    if (a.code === 'declining') out.push({ label: K.tr(ctx, 'Sources report'), href: rep + '#sources' });
    return out;
  }

  // ── DOM ───────────────────────────────────────────────────────────────────
  var root = null, scrim = null, lastFocus = null, cur = null, seq = 0;

  function build() {
    if (root) return;
    scrim = document.createElement('div');
    scrim.className = 'p2-scrim';
    scrim.hidden = true;
    scrim.addEventListener('click', close);
    root = document.createElement('aside');
    root.className = 'p2-drawer';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-labelledby', 'p2-dr-title');
    root.tabIndex = -1;
    root.hidden = true;
    root.addEventListener('keydown', onKey);
    root.addEventListener('click', onClick);
    document.body.appendChild(scrim);
    document.body.appendChild(root);
  }

  function focusables() {
    return Array.prototype.filter.call(
      root.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'),
      function (el) { return el.offsetParent !== null || el === document.activeElement; });
  }
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key !== 'Tab') return;
    var f = focusables();
    if (!f.length) { e.preventDefault(); root.focus(); return; }
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === root)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  // keep focus inside while open, even if something outside grabs it
  function onFocusIn(e) { if (root && !root.hidden && !root.contains(e.target)) root.focus(); }

  function sortedAttention(site) {
    return (site.attention || []).slice().sort(function (a, b) { return (SEV[a.severity] ?? 3) - (SEV[b.severity] ?? 3); });
  }

  function render() {
    var ctx = cur.ctx, s = cur.site, t = function (x) { return K.tr(ctx, x); }, esc = K.esc;
    var domain = (s.domains || [])[0] || '';
    var tags = (s.tags || []).map(function (tg) {
      return '<span class="p2-tag">' + esc(tg) + '<button type="button" data-untag="' + esc(tg) + '" aria-label="' + esc(t('Remove tag') + ' ' + tg) + '">×</button></span>';
    }).join('');
    var att = sortedAttention(s).map(function (a, i) {
      var f = fixes(ctx, a, s);
      return '<div class="p2-callout ' + esc(a.severity || 'normal') + '" role="alert"><div class="msg">' + K.icon('alert') + '<span>' + esc(attnText(ctx, a, s)) + '</span></div>'
        + (f.length ? '<div class="acts">' + f.map(function (x, j) {
          return x.href
            ? '<a class="p2-btn sm' + (x.primary ? ' strong' : '') + '" href="' + esc(x.href) + '">' + esc(x.label) + '</a>'
            : '<button type="button" class="p2-btn sm' + (x.primary ? ' strong' : '') + '" data-fix="' + esc(x.run) + '" data-i="' + i + '-' + j + '">' + esc(x.label) + '</button>';
        }).join('') + '</div>' : '') + '</div>';
    }).join('');
    var archived = s.status === 'archived';
    root.innerHTML =
      '<div class="p2-dr-head">' + K.avatar(s, 'lg')
      + '<div style="min-width:0;flex:1"><h2 id="p2-dr-title">' + esc(s.name || s.site_id) + (s.starred ? ' <span class="p2-star" aria-label="' + esc(t('Starred')) + '">★</span>' : '') + ' ' + K.stageChip(ctx, archived ? 'archived' : s.stage) + '</h2>'
      + '<div class="sub">' + esc(domain) + (s.days_live != null ? ' · ' + esc(K.fill(t('live {n} days'), { n: s.days_live })) : '') + '</div></div>'
      + '<button type="button" class="p2-x" data-close aria-label="' + esc(t('Close')) + '">' + K.icon('x') + '</button></div>'
      + '<div class="p2-dr-body">'
      + att
      + '<div class="p2-kpis">'
      + kpi('eye', t('Clean visitors'), K.num(s.uv), K.delta(s.delta_pct))
      + kpi('search', t('Organic search'), K.num(s.organic_uv), '')
      + kpi('spark', t('From AI assistants'), K.num(s.ai_uv), '')
      + '</div>'
      + '<section class="p2-sec"><h3>' + esc(t('Clean visitors vs invalid traffic · 30 days')) + '</h3>'
      + '<div class="p2-legend"><span><i style="background:var(--p2-accent)"></i>' + esc(t('Clean visitors')) + '</span><span><i style="background:var(--p2-down)"></i>' + esc(t('Invalid traffic share')) + '</span></div>'
      + '<div class="p2-chart" id="p2-dr-chart"><div class="p2-skel" style="height:150px"></div></div></section>'
      + '<section class="p2-sec"><h3>' + esc(t('Search-engine crawls')) + ' <span class="p2-mut">' + esc(t('last 7 days')) + '</span></h3><div id="p2-dr-crawl"><div class="p2-skel"></div></div></section>'
      + '<section class="p2-sec"><h3>' + esc(t('Experiments')) + '</h3><div id="p2-dr-exp"><div class="p2-skel"></div></div></section>'
      + '<section class="p2-sec"><h3>' + esc(t('Tags')) + '</h3><div class="p2-tags-edit">' + tags
      + '<input type="text" id="p2-dr-tag" maxlength="32" placeholder="' + esc(t('Add tag…')) + '" aria-label="' + esc(t('Add tag')) + '"></div></section>'
      + '</div>'
      + '<div class="p2-dr-foot">'
      + '<a class="p2-btn primary" href="/site.html?id=' + encodeURIComponent(s.site_id) + '">' + esc(t('Open full report')) + K.icon('arrow') + '</a>'
      + '<button type="button" class="p2-btn" data-act="star" aria-pressed="' + (s.starred ? 'true' : 'false') + '">' + K.icon('star') + esc(t(s.starred ? 'Starred' : 'Star')) + '</button>'
      + '<button type="button" class="p2-btn' + (archived ? '' : ' danger') + '" data-act="' + (archived ? 'restore' : 'archive') + '">' + K.icon(archived ? 'restore' : 'archive') + esc(t(archived ? 'Restore' : 'Archive')) + '</button>'
      + '</div>';
  }
  function kpi(ic, l, n, d) { return '<div class="p2-kpi"><div class="l">' + K.icon(ic) + K.esc(l) + d + '</div><div class="n">' + n + '</div></div>'; }

  // ── async sections ────────────────────────────────────────────────────────
  function loadDetails(my) {
    var ctx = cur.ctx, id = encodeURIComponent(cur.site.site_id);
    // uv points also carry pv + invalid (suspect + bot) per day, so one rollup
    // read gives both lines; /quality would add a raw flag scan for nothing here
    K.api(ctx, '/sites/' + id + '/timeseries?metric=uv&interval=day&period=30d')
      .then(function (d) { if (my === seq) drawChart(d); })
      .catch(function () { if (my === seq) fail('p2-dr-chart'); });
    K.api(ctx, '/sites/' + id + '/crawlers?period=7d&search=1&limit=5')
      .then(function (d) { if (my === seq) drawCrawl(d); })
      .catch(function () { if (my === seq) fail('p2-dr-crawl'); });
    K.api(ctx, '/sites/' + id + '/experiments?period=30d')
      .then(function (d) { if (my === seq) drawExp(d); })
      .catch(function () { if (my === seq) fail('p2-dr-exp'); });
  }
  function fail(id) { var el = document.getElementById(id); if (el) el.innerHTML = '<p class="p2-empty">' + K.esc(K.tr(cur.ctx, 'failed')) + '</p>'; }

  function drawChart(ts) {
    var el = document.getElementById('p2-dr-chart');
    if (!el) return;
    var ctx = cur.ctx;
    var pts = (ts && ts.points) || [];
    if (!pts.length || pts.every(function (p) { return !p.value && !p.pv; })) { el.innerHTML = '<p class="p2-empty">' + K.esc(K.tr(ctx, 'no data yet')) + '</p>'; return; }
    var days = pts.map(function (p) { return String(p.label || p.day || ''); });
    var uv = pts.map(function (p) { return Number(p.value) || 0; });
    var ivt = pts.map(function (p) { return p.pv ? (p.invalid || 0) / p.pv * 100 : null; });
    var W = 520, H = 150, padB = 18, padR = 34, ih = H - padB - 6;
    var max = Math.max.apply(null, uv.concat([1]));
    var x = function (i) { return uv.length < 2 ? 0 : i / (uv.length - 1) * (W - padR); };
    var y = function (v) { return 6 + ih - v / max * ih; };
    var yp = function (p) { return 6 + ih - p / 100 * ih; };
    var line = uv.map(function (v, i) { return x(i).toFixed(1) + ',' + y(v).toFixed(1); }).join(' ');
    var ivtPath = '', pen = false;
    ivt.forEach(function (p, i) {
      if (p == null) { pen = false; return; }
      ivtPath += (pen ? 'L' : 'M') + x(i).toFixed(1) + ',' + yp(p).toFixed(1);
      pen = true;
    });
    var grid = [0, .5, 1].map(function (f) {
      var yy = (6 + ih - f * ih).toFixed(1);
      return '<line x1="0" x2="' + (W - padR) + '" y1="' + yy + '" y2="' + yy + '" stroke="#ececef" stroke-dasharray="2 3"/>'
        + '<text x="' + (W - padR + 4) + '" y="' + (Number(yy) + 3) + '" fill="#8a8a93" font-size="9">' + (f * 100) + '%</text>';
    }).join('');
    var lbl = function (i) { return '<text x="' + x(i).toFixed(1) + '" y="' + (H - 4) + '" fill="#8a8a93" font-size="9" text-anchor="' + (i === 0 ? 'start' : i === uv.length - 1 ? 'end' : 'middle') + '">' + K.esc(/^\d{4}-/.test(days[i]) ? days[i].slice(5) : days[i]) + '</text>'; };
    el.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + K.esc(K.tr(ctx, 'Clean visitors vs invalid traffic · 30 days')) + '">'
      + '<defs><linearGradient id="p2drg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3b82f6" stop-opacity=".1"/><stop offset="1" stop-color="#3b82f6" stop-opacity="0"/></linearGradient></defs>'
      + grid
      + '<polygon fill="url(#p2drg)" points="0,' + (6 + ih) + ' ' + line + ' ' + x(uv.length - 1).toFixed(1) + ',' + (6 + ih) + '"/>'
      + '<polyline fill="none" stroke="#3b82f6" stroke-width="1.6" points="' + line + '"/>'
      + (ivtPath ? '<path d="' + ivtPath + '" fill="none" stroke="#dc2626" stroke-width="1.5"/>' : '')
      + lbl(0) + lbl(Math.floor((uv.length - 1) / 2)) + lbl(uv.length - 1)
      + '<text x="2" y="14" fill="#8a8a93" font-size="10">' + K.esc(K.num(max)) + '</text>'
      + '</svg>';
  }

  function rel(ctx, ts) {
    if (!ts) return '–';
    var d = Date.now() - ts;
    if (d < 3600e3) return K.tr(ctx, 'just now');
    if (d < 86400e3) return K.fill(K.tr(ctx, '{n} h ago'), { n: Math.floor(d / 3600e3) });
    var days = Math.floor(d / 86400e3);
    return days === 1 ? K.tr(ctx, 'yesterday') : K.fill(K.tr(ctx, '{n} days ago'), { n: days });
  }
  function drawCrawl(d) {
    var el = document.getElementById('p2-dr-crawl');
    if (!el) return;
    var ctx = cur.ctx, s = cur.site, esc = K.esc;
    var eng = (d && d.engines) || [];
    if (d && d.available === false || !eng.length) { el.innerHTML = '<p class="p2-empty">' + esc(K.tr(ctx, 'No search-engine crawl recorded yet.')) + '</p>'; return; }
    el.innerHTML = '<table class="p2-tbl"><thead><tr><th>' + esc(K.tr(ctx, 'Engine')) + '</th><th>' + esc(K.tr(ctx, 'First crawl')) + '</th><th>' + esc(K.tr(ctx, 'Latest')) + '</th><th class="num">' + esc(K.tr(ctx, '7 days')) + '</th></tr></thead><tbody>'
      + eng.map(function (e) {
        var day = s.created_at && e.first_seen_at ? Math.max(1, Math.floor((e.first_seen_at - s.created_at) / 86400e3) + 1) : null;
        return '<tr><td>' + esc(e.label || e.engine) + '</td><td>' + (day ? esc(K.fill(K.tr(ctx, 'day {n} after launch'), { n: day })) : '–')
          + '</td><td>' + esc(rel(ctx, e.last_seen_at)) + '</td><td class="num">' + K.num(e.hits) + '</td></tr>';
      }).join('') + '</tbody></table>';
  }
  function drawExp(d) {
    var el = document.getElementById('p2-dr-exp');
    if (!el) return;
    var ctx = cur.ctx, esc = K.esc;
    var xs = ((d && d.experiments) || []).filter(function (x) { return Date.now() - (x.last_seen || 0) < 3 * 86400e3; }).slice(0, 4);
    if (!xs.length) { el.innerHTML = '<p class="p2-empty">' + esc(K.tr(ctx, 'No running experiments.')) + '</p>'; return; }
    el.innerHTML = xs.map(function (x) {
      return '<div class="p2-exp"><b>' + esc(x.experiment) + '</b> <span class="p2-mut">· ' + K.num(x.visitors) + ' ' + esc(K.tr(ctx, 'visitors')) + ' · ' + esc(K.tr(ctx, 'last exposure')) + ' ' + esc(rel(ctx, x.last_seen)) + '</span>'
        + '<div class="vs">' + (x.variants || []).map(function (v) { return '<span class="p2-tag">' + esc(v.variant) + ' · ' + K.num(v.visitors) + '</span>'; }).join('') + '</div></div>';
    }).join('') + '<p class="p2-mut" style="font-size:12px;margin:8px 0 0">' + esc(K.tr(ctx, 'Pick a goal in the full report to see which variant wins.')) + '</p>';
  }

  // ── actions ───────────────────────────────────────────────────────────────
  function changed() {
    var ctx = cur.ctx;
    render(); loadDetails(seq);
    if (ctx && typeof ctx.onChange === 'function') { try { ctx.onChange(cur.site); } catch (e) { /* page hook */ } }
  }
  function putLabels(patch) {
    var ctx = cur.ctx, s = cur.site;
    return K.api(ctx, '/sites/' + encodeURIComponent(s.site_id) + '/labels', { method: 'PUT', body: patch }).then(function (d) {
      s.starred = d.starred; s.tags = d.tags; changed();
    }).catch(function (e) { K.toast(K.tr(ctx, 'save failed') + ': ' + e.message, true); });
  }
  function onClick(e) {
    var b = e.target.closest('button');
    if (!b || !root.contains(b)) return;
    var ctx = cur.ctx, s = cur.site, t = function (x) { return K.tr(ctx, x); };
    if (b.hasAttribute('data-close')) { close(); return; }
    if (b.dataset.untag != null) { putLabels({ tags: (s.tags || []).filter(function (x) { return x !== b.dataset.untag; }) }); return; }
    if (b.dataset.fix === 'adguard') {
      b.disabled = true;
      K.api(ctx, '/sites/' + encodeURIComponent(s.site_id) + '/adguard', { method: 'POST', body: { mode: 'balanced' } }).then(function () {
        s.adguard_mode = 'balanced';
        // the IVT alert stays (traffic is still invalid) but is no longer "unprotected"
        s.attention = (s.attention || []).map(function (a) {
          return a.code === 'ivt_high' ? Object.assign({}, a, { severity: 'high', params: Object.assign({}, a.params, { adguard_mode: 'balanced' }) }) : a;
        });
        K.toast(t('Ad protection set to “Balanced”.'));
        changed();
      }).catch(function (err) { b.disabled = false; K.toast(t('save failed') + ': ' + err.message, true); });
      return;
    }
    var act = b.dataset.act;
    if (act === 'star') { putLabels({ starred: !s.starred }); return; }
    if (act === 'archive' || act === 'restore') {
      if (act === 'archive' && !confirm(t('Archive this site? It stops collecting data; its history is kept and it can be restored.'))) return;
      b.disabled = true;
      K.api(ctx, '/sites/bulk', { method: 'POST', body: { site_ids: [s.site_id], action: act } }).then(function (d) {
        if (d.skipped && d.skipped.length) { K.toast(t('Not restored: a domain of this site now belongs to another active site.'), true); b.disabled = false; return; }
        s.status = act === 'archive' ? 'archived' : 'active';
        K.toast(t(act === 'archive' ? 'Site archived.' : 'Site restored.'));
        changed();
      }).catch(function (err) { b.disabled = false; K.toast(t('save failed') + ': ' + err.message, true); });
    }
  }
  function onTagKey(e) {
    if (e.target.id !== 'p2-dr-tag' || e.key !== 'Enter') return;
    e.preventDefault();
    var v = e.target.value.trim();
    if (!v) return;
    var s = cur.site;
    if ((s.tags || []).some(function (x) { return x.toLowerCase() === v.toLowerCase(); })) { e.target.value = ''; return; }
    putLabels({ tags: (s.tags || []).concat([v]) }).then(function () { var i = document.getElementById('p2-dr-tag'); if (i) i.focus(); });
  }

  // ── public API ────────────────────────────────────────────────────────────
  function open(site, ctx) {
    if (!site || !site.site_id) return;
    build();
    if (root.hidden) lastFocus = document.activeElement;
    cur = { site: Object.assign({}, site, { tags: (site.tags || []).slice(), attention: (site.attention || []).slice() }), ctx: ctx || {} };
    seq++;
    render();
    scrim.hidden = false; root.hidden = false;
    // next frame so the slide-in transition runs
    requestAnimationFrame(function () { scrim.classList.add('open'); root.classList.add('open'); });
    document.addEventListener('focusin', onFocusIn);
    root.removeEventListener('keydown', onTagKey);
    root.addEventListener('keydown', onTagKey);
    var first = root.querySelector('.p2-callout .p2-btn') || root.querySelector('[data-close]');
    (first || root).focus();
    loadDetails(seq);
  }
  function close() {
    if (!root || root.hidden) return;
    seq++;
    scrim.classList.remove('open'); root.classList.remove('open');
    document.removeEventListener('focusin', onFocusIn);
    root.hidden = true; scrim.hidden = true;
    if (lastFocus && typeof lastFocus.focus === 'function' && document.contains(lastFocus)) lastFocus.focus();
    lastFocus = null;
  }

  window.pvuvDrawer = { open: open, close: close, isOpen: function () { return !!(root && !root.hidden); } };
})();
