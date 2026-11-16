/**
 * pvuv.ai console — portfolio cards & heatmap views (portfolio stream P2).
 *
 *   window.pvuvViews = { cards(el, sites, ctx), heatmap(el, sites, ctx) }
 *
 * Both render into `el` from the portfolio contract's `sites[]` (already
 * filtered / sorted by the caller) and need no extra request. `ctx` =
 * { period, t, te, esc, fmt, ui } plus optional `onOpen(site)`; without it a
 * click opens window.pvuvDrawer when present, else the site report.
 *
 *  - cards: small multiples — avatar, stage chip, clean visitors + change,
 *    organic / IVT, 14-day area sparkline. "Shared y-scale" (remembered in
 *    localStorage) draws every sparkline against the largest site of the page,
 *    so sizes compare; off, each card uses its own max, so shapes compare.
 *  - heatmap: site × day CSS grid, coloured by daily health (ok/warn/bad) or
 *    by the percentile of the day's visitors across all listed site-days;
 *    days without data are gaps. Row summary on the right.
 * Both paginate at 100 sites.
 */
(function () {
  'use strict';

  // ── tiny shared kit (also defined, identically, by drawer.js) ──────────────
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
  var PAGE = 100;
  var LS_SCALE = 'pvuv.p2.cardsSharedScale', LS_HM = 'pvuv.p2.heatmapMode';
  function ls(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }
  function openSite(site, ctx) {
    if (ctx && typeof ctx.onOpen === 'function') return ctx.onOpen(site);
    if (window.pvuvDrawer) return window.pvuvDrawer.open(site, ctx);
    location.href = '/site.html?id=' + encodeURIComponent(site.site_id);
  }
  var SEV = { critical: 0, high: 1, normal: 2 };
  function worst(site) {
    var a = site.attention || [];
    var best = null;
    for (var i = 0; i < a.length; i++) if (best == null || (SEV[a[i].severity] ?? 3) < best) best = SEV[a[i].severity] ?? 3;
    return best;
  }
  function pager(el, page, total, onGo, ctx) {
    var pages = Math.ceil(total / PAGE);
    if (pages <= 1) return;
    var p = document.createElement('div');
    p.className = 'p2-pager';
    p.innerHTML = '<span>' + K.esc(K.fill(K.tr(ctx, '{from}–{to} of {n}'), { from: page * PAGE + 1, to: Math.min(total, (page + 1) * PAGE), n: total })) + '</span>'
      + '<button type="button" class="p2-btn sm" data-pg="-1"' + (page ? '' : ' disabled') + '>‹ ' + K.esc(K.tr(ctx, 'Previous')) + '</button>'
      + '<button type="button" class="p2-btn sm" data-pg="1"' + (page < pages - 1 ? '' : ' disabled') + '>' + K.esc(K.tr(ctx, 'Next')) + ' ›</button>';
    p.addEventListener('click', function (e) { var b = e.target.closest('[data-pg]'); if (b) onGo(page + Number(b.dataset.pg)); });
    el.appendChild(p);
  }

  var ATTN_SHORT = {
    no_data_24h: 'No data in 24 h', crawl_overdue: 'Not crawled yet', organic_overdue: 'No organic visitors yet',
    declining: 'Declining', ivt_high: 'High invalid traffic', ivt_spike: 'Invalid traffic spike',
  };
  function attnLabel(ctx, a, s) {
    var p = Object.assign({ days_live: s.days_live, ivt_pct: s.ivt_pct, delta_pct: s.delta_pct, adguard_mode: s.adguard_mode }, a.params || {});
    if (typeof p.delta_pct === 'number') p.delta_pct = Math.abs(p.delta_pct).toFixed(0);
    if (typeof p.ivt_pct === 'number') p.ivt_pct = p.ivt_pct.toFixed(1).replace(/\.0$/, '');
    if (p.adguard_mode) p.adguard_mode = K.tr(ctx, p.adguard_mode);
    return K.fill(K.tk(ctx, 'attn.' + a.code, K.tr(ctx, ATTN_SHORT[a.code] || a.code.replace(/_/g, ' '))), p);
  }

  // ── cards: small multiples ────────────────────────────────────────────────
  function cards(el, sites, ctx, page) {
    ctx = ctx || {}; sites = sites || []; page = page || 0;
    var t = function (x) { return K.tr(ctx, x); }, esc = K.esc;
    var shared = ls(LS_SCALE) === '1';
    var slice = sites.slice(page * PAGE, (page + 1) * PAGE);
    var gmax = 1;
    if (shared) slice.forEach(function (s) { (s.series || []).forEach(function (p) { if (p && p.uv > gmax) gmax = p.uv; }); });
    el.innerHTML = '';
    el.classList.add('p2');
    var bar = document.createElement('div');
    bar.className = 'p2-vbar';
    bar.innerHTML = '<span>' + esc(K.fill(t('{n} sites'), { n: sites.length })) + '</span><span class="sp"></span>'
      + '<span class="p2-seg" role="group" aria-label="' + esc(t('Sparkline scale')) + '">'
      + '<button type="button" data-scale="0" aria-pressed="' + !shared + '"' + (shared ? '' : ' class="on"') + '>' + esc(t('Own y-scale')) + '</button>'
      + '<button type="button" data-scale="1" aria-pressed="' + shared + '"' + (shared ? ' class="on"' : '') + '>' + esc(t('Shared y-scale')) + '</button></span>';
    bar.addEventListener('click', function (e) { var b = e.target.closest('[data-scale]'); if (b) { ls(LS_SCALE, b.dataset.scale); cards(el, sites, ctx, page); } });
    el.appendChild(bar);
    if (!sites.length) { el.insertAdjacentHTML('beforeend', '<p class="p2-empty">' + esc(t('No sites match.')) + '</p>'); return; }
    var grid = document.createElement('div');
    grid.className = 'p2-cards';
    grid.innerHTML = slice.map(function (s, i) {
      var vals = (s.series || []).map(function (p) { return p ? p.uv : null; });
      var neg = s.delta_pct != null && s.delta_pct < 0;
      var att = (s.attention || []).slice().sort(function (x, y) { return (SEV[x.severity] ?? 3) - (SEV[y.severity] ?? 3); })[0];
      var attLine = att ? '<div class="att' + (att.severity === 'critical' ? '' : ' w') + '">' + esc(attnLabel(ctx, att, s)) + '</div>' : '';
      return '<button type="button" class="p2-card" data-i="' + i + '" aria-label="' + esc(s.name) + '">'
        + '<div class="top">' + K.avatar(s) + '<div class="tx"><div class="nm">' + esc(s.name || s.site_id) + (s.starred ? ' <span class="p2-star">★</span>' : '') + '</div>'
        + '<div class="dm">' + esc((s.domains || [])[0] || '') + '</div></div></div>'
        + '<div>' + K.stageChip(ctx, s.status === 'archived' ? 'archived' : s.stage) + '</div>'
        + '<div class="kpi"><b>' + K.num(s.uv) + '</b>' + (s.delta_pct == null ? '<small class="p2-mut">' + esc(t('new')) + '</small>' : K.delta(s.delta_pct)) + '</div>'
        + '<div class="spark">' + K.spark(vals, { w: 300, h: 36, neg: neg, max: shared ? gmax : undefined, label: t('14-day trend') }) + '</div>'
        + '<div class="meta"><span>' + esc(t('Organic')) + ' ' + K.num(s.organic_uv) + '</span><span' + (s.ivt_pct > 20 ? ' class="bad"' : '') + '>' + esc(t('IVT')) + ' ' + K.pct(s.ivt_pct) + '</span>'
        + (s.days_live != null ? '<span>' + esc(K.fill(t('{n} d'), { n: s.days_live })) + '</span>' : '') + '</div>'
        + attLine
        + '</button>';
    }).join('');
    grid.addEventListener('click', function (e) { var c = e.target.closest('.p2-card'); if (c) openSite(slice[Number(c.dataset.i)], ctx); });
    el.appendChild(grid);
    pager(el, page, sites.length, function (p) { cards(el, sites, ctx, p); el.scrollIntoView({ block: 'start' }); }, ctx);
  }

  // ── heatmap: site × day ───────────────────────────────────────────────────
  // light greys → blue; amber warn, red bad (contract: one blue data accent)
  var HEALTH = { ok: '#a9c8fb', warn: '#f5cf87', bad: '#ef9a9a' };
  var RAMP = ['#eeeef1', '#dce7fc', '#bed3fa', '#94b8f7', '#6699f3', '#3b82f6'];
  function heatmap(el, sites, ctx, page) {
    ctx = ctx || {}; sites = sites || []; page = page || 0;
    var t = function (x) { return K.tr(ctx, x); }, esc = K.esc;
    var mode = ls(LS_HM) === 'uv' ? 'uv' : 'health';
    var slice = sites.slice(page * PAGE, (page + 1) * PAGE);
    // day columns: the longest series wins (all sites share the period)
    var n = 0, days = [];
    sites.forEach(function (s) { var len = Math.max((s.series || []).length, (s.health || []).length); if (len > n) { n = len; days = (s.series || []).map(function (p) { return p && p.day; }); } });
    n = Math.max(n, 1);
    // uv percentile across every non-null site-day of the whole list, so the
    // colour means the same thing on every page
    var all = [];
    sites.forEach(function (s) { (s.series || []).forEach(function (p) { if (p && p.uv != null) all.push(p.uv); }); });
    all.sort(function (a, b) { return a - b; });
    function rank(v) {
      if (!all.length) return 0;
      var lo = 0, hi = all.length;
      while (lo < hi) { var mid = (lo + hi) >> 1; if (all[mid] < v) lo = mid + 1; else hi = mid; }
      return lo / Math.max(1, all.length - 1);
    }
    el.innerHTML = '';
    el.classList.add('p2');
    var bar = document.createElement('div');
    bar.className = 'p2-vbar';
    var legend = mode === 'health'
      ? ['ok', 'warn', 'bad'].map(function (k) { return '<span class="p2-hm-legend"><i style="background:' + HEALTH[k] + '"></i>' + esc(t(k === 'ok' ? 'Healthy' : k === 'warn' ? 'Warning' : 'Problem')) + '</span>'; }).join('')
      : '<span class="p2-hm-legend">' + esc(t('low')) + ' ' + RAMP.map(function (c) { return '<i style="background:' + c + '"></i>'; }).join('') + ' ' + esc(t('high')) + '</span>';
    bar.innerHTML = '<span>' + esc(K.fill(t('{n} sites'), { n: sites.length })) + '</span>' + legend
      + '<span class="p2-hm-legend"><i style="box-shadow:inset 0 0 0 1px var(--p2-line)"></i>' + esc(t('no data')) + '</span><span class="sp"></span>'
      + '<span class="p2-seg" role="group" aria-label="' + esc(t('Colour by')) + '"><button type="button" data-m="health"' + (mode === 'health' ? ' class="on" aria-pressed="true"' : ' aria-pressed="false"') + '>' + esc(t('Health')) + '</button>'
      + '<button type="button" data-m="uv"' + (mode === 'uv' ? ' class="on" aria-pressed="true"' : ' aria-pressed="false"') + '>' + esc(t('Visitors percentile')) + '</button></span>';
    bar.addEventListener('click', function (e) { var b = e.target.closest('[data-m]'); if (b) { ls(LS_HM, b.dataset.m); heatmap(el, sites, ctx, page); } });
    el.appendChild(bar);
    if (!sites.length) { el.insertAdjacentHTML('beforeend', '<p class="p2-empty">' + esc(t('No sites match.')) + '</p>'); return; }

    var wrap = document.createElement('div');
    wrap.className = 'p2-hm';
    var cols = 'minmax(180px, 240px) repeat(' + n + ', minmax(18px, 1fr)) minmax(150px, auto)';
    var h = '<div class="p2-hm-grid" role="grid" style="grid-template-columns:' + cols + '">'
      + '<div class="h" role="columnheader" style="padding-left:12px">' + esc(t('Site')) + '</div>';
    for (var d = 0; d < n; d++) {
      var lab = days[d] ? String(days[d]).slice(8) : '';
      h += '<div class="h day" role="columnheader" title="' + esc(days[d] || '') + '">' + esc(lab) + '</div>';
    }
    h += '<div class="h sum" role="columnheader">' + esc(mode === 'health' ? t('Healthy days') : t('Visitors · change')) + '</div>';
    slice.forEach(function (s, i) {
      h += '<div class="nm" role="rowheader" data-i="' + i + '" tabindex="0">' + K.avatar(s, 'sm') + '<span>' + (s.starred ? '<span class="p2-star">★</span> ' : '') + esc(s.name || s.site_id) + '</span></div>';
      var ok = 0, known = 0;
      for (var j = 0; j < n; j++) {
        var cell;
        if (mode === 'health') {
          var hv = (s.health || [])[j];
          if (hv && hv !== 'none') { known++; if (hv === 'ok') ok++; }
          cell = hv && HEALTH[hv] ? '<i style="background:' + HEALTH[hv] + '"></i>' : '<i class="gap"></i>';
          h += '<div class="c" role="gridcell" title="' + esc((days[j] || '') + ' · ' + t(hv && hv !== 'none' ? (hv === 'ok' ? 'Healthy' : hv === 'warn' ? 'Warning' : 'Problem') : 'no data')) + '">' + cell + '</div>';
        } else {
          var p = (s.series || [])[j];
          var v = p ? p.uv : null;
          cell = v == null ? '<i class="gap"></i>' : '<i style="background:' + RAMP[Math.min(RAMP.length - 1, Math.floor(rank(v) * RAMP.length))] + '"></i>';
          h += '<div class="c" role="gridcell" title="' + esc((days[j] || '') + ' · ' + (v == null ? t('no data') : K.num(v))) + '">' + cell + '</div>';
        }
      }
      h += '<div class="sum" role="gridcell">' + (mode === 'health'
        ? (known ? '<span class="' + (ok / known >= .8 ? 'p2-up' : ok / known >= .5 ? '' : 'p2-dn') + '">' + ok + ' / ' + known + '</span>' : '<span class="p2-mut">–</span>')
        : '<span>' + K.num(s.uv) + '</span>' + (s.delta_pct == null ? '<span class="p2-mut">' + esc(t('new')) + '</span>' : K.delta(s.delta_pct)))
        + '</div>';
    });
    h += '</div>';
    wrap.innerHTML = h;
    var go = function (e) { var c = e.target.closest('.nm'); if (c) openSite(slice[Number(c.dataset.i)], ctx); };
    wrap.addEventListener('click', go);
    wrap.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(e); });
    el.appendChild(wrap);
    pager(el, page, sites.length, function (p) { heatmap(el, sites, ctx, p); el.scrollIntoView({ block: 'start' }); }, ctx);
  }

  window.pvuvViews = {
    cards: function (el, sites, ctx) { cards(el, sites, ctx, 0); },
    heatmap: function (el, sites, ctx) { heatmap(el, sites, ctx, 0); },
  };
})();
