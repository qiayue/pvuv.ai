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
    var COLORS = ['#7c6cff', '#22b07d', '#e0663f', '#2f8cf0', '#d64f8a', '#c9a227', '#11a3a3', '#8a5cf6', '#5e6ad2'];
    function hash(s) { var h = 0; s = String(s || ''); for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }
    function avatar(site, cls) {
      var name = (site && (site.name || (site.domains || [])[0])) || '?';
      var ch = Array.from(String(name).trim())[0] || '?';
      return '<span class="p2-av' + (cls ? ' ' + cls : '') + '" style="background:' + COLORS[hash(site && site.site_id || name) % COLORS.length] + '" aria-hidden="true">' + esc(ch.toUpperCase()) + '</span>';
    }
    var STAGE = { setup: 'Awaiting install', awaiting_crawl: 'Awaiting crawl', crawled: 'Crawled', organic: 'Organic traffic', growing: 'Stable growth', declining: 'Declining', archived: 'Archived' };
    function stageChip(ctx, stage) {
      if (!stage) return '';
      return '<span class="p2-chip s-' + esc(stage) + '">' + esc(tr(ctx, STAGE[stage] || stage)) + '</span>';
    }
    function delta(d) {
      if (d == null || isNaN(d)) return '';
      var up = d >= 0;
      return '<small class="' + (up ? 'p2-up' : 'p2-dn') + '">' + (up ? '▲ ' : '▼ ') + Math.abs(d).toFixed(Math.abs(d) < 10 ? 1 : 0).replace(/\.0$/, '') + '%</small>';
    }
    var gid = 0;
    /** gradient area sparkline; values may contain null (drawn as 0) */
    function area(vals, o) {
      o = o || {};
      var w = o.w || 300, h = o.h || 44, c = o.color || '#9a8cff';
      var v = (vals || []).map(function (x) { return x == null || isNaN(x) ? 0 : Number(x); });
      if (v.length < 2) v = [0, 0].concat(v).slice(-2);
      var max = o.max != null ? o.max : Math.max.apply(null, v.concat([1]));
      var pts = v.map(function (x, i) { return [(i / (v.length - 1) * w), (h - 2 - (max ? x / max : 0) * (h - 6))]; });
      var line = pts.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' ');
      var id = 'p2g' + (++gid);
      return '<svg viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" role="img" aria-label="' + esc(o.label || '') + '">'
        + '<defs><linearGradient id="' + id + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="' + c + '" stop-opacity=".42"/><stop offset="1" stop-color="' + c + '" stop-opacity="0"/></linearGradient></defs>'
        + '<polygon fill="url(#' + id + ')" points="0,' + h + ' ' + line + ' ' + w + ',' + h + '"/>'
        + '<polyline fill="none" stroke="' + c + '" stroke-width="1.6" vector-effect="non-scaling-stroke" points="' + line + '"/></svg>';
    }
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
    return { tr: tr, tk: tk, esc: esc, fill: fill, num: num, pct: pct, avatar: avatar, stageChip: stageChip, delta: delta, area: area, toast: toast, api: api, STAGE: STAGE };
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
      + '<label><input type="checkbox" data-scale' + (shared ? ' checked' : '') + '> ' + esc(t('Shared y-scale')) + '</label>';
    bar.querySelector('[data-scale]').addEventListener('change', function (e) { ls(LS_SCALE, e.target.checked ? '1' : '0'); cards(el, sites, ctx, page); });
    el.appendChild(bar);
    if (!sites.length) { el.insertAdjacentHTML('beforeend', '<p class="p2-empty">' + esc(t('No sites match.')) + '</p>'); return; }
    var grid = document.createElement('div');
    grid.className = 'p2-cards';
    grid.innerHTML = slice.map(function (s, i) {
      var vals = (s.series || []).map(function (p) { return p ? p.uv : null; });
      var neg = s.delta_pct != null && s.delta_pct < 0;
      var w = worst(s);
      var dot = w == null ? '' : '<span class="dot" style="background:' + (w === 0 ? '#ef6b6b' : w === 1 ? '#e0a34a' : '#8b7cff') + '" title="' + esc(t('Needs attention')) + '"></span>';
      return '<button type="button" class="p2-card" data-i="' + i + '" aria-label="' + esc(s.name) + '">' + dot
        + '<div class="top">' + K.avatar(s) + '<div class="tx"><div class="nm">' + (s.starred ? '<span class="p2-star">★</span> ' : '') + esc(s.name || s.site_id) + '</div>'
        + '<div class="dm">' + esc((s.domains || [])[0] || '') + '</div></div>' + K.stageChip(ctx, s.status === 'archived' ? 'archived' : s.stage) + '</div>'
        + '<div class="kpi"><b>' + K.num(s.uv) + '</b>' + (s.delta_pct == null ? '<small class="p2-mut">' + esc(t('new')) + '</small>' : K.delta(s.delta_pct)) + '</div>'
        + '<div class="meta"><span>' + esc(t('Organic')) + ' ' + K.num(s.organic_uv) + '</span><span' + (s.ivt_pct > 20 ? ' class="bad"' : '') + '>' + esc(t('IVT')) + ' ' + K.pct(s.ivt_pct) + '</span>'
        + (s.days_live != null ? '<span>' + esc(K.fill(t('{n} d'), { n: s.days_live })) + '</span>' : '') + '</div>'
        + '<div class="spark">' + K.area(vals, { w: 300, h: 44, color: neg ? '#ff7a85' : '#9a8cff', max: shared ? gmax : undefined, label: t('14-day trend') }) + '</div>'
        + '</button>';
    }).join('');
    grid.addEventListener('click', function (e) { var c = e.target.closest('.p2-card'); if (c) openSite(slice[Number(c.dataset.i)], ctx); });
    el.appendChild(grid);
    pager(el, page, sites.length, function (p) { cards(el, sites, ctx, p); el.scrollIntoView({ block: 'start' }); }, ctx);
  }

  // ── heatmap: site × day ───────────────────────────────────────────────────
  var HEALTH = { ok: '#2a7a54', warn: '#8a6424', bad: '#8f3540' };
  var RAMP = ['#1b1a2e', '#2a2350', '#3d3175', '#55449e', '#7461c9', '#9a8cff'];
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
      + '<span class="p2-hm-legend"><i style="box-shadow:inset 0 0 0 1px #2a2d36"></i>' + esc(t('no data')) + '</span><span class="sp"></span>'
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
