/**
 * pvuv.ai console — shared UI helpers for the portfolio pages
 * (docs/design/portfolio-ui.md §4). Classic script: sets `window.pvuvUI`, so it
 * works on module and non-module pages alike, and is handed to other modules as
 * `ctx.ui`.
 *
 * Every renderer returns an HTML STRING (framework-free): use it with
 * innerHTML, or in Preact via the page's <Raw html=…/> wrapper. All text that
 * can come from a user (names, domains, tags) is escaped here.
 */
(function () {
  'use strict';
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var t = function (s) { return window.PVI18N ? window.PVI18N.t(s) : s; };
  /** symbolic key with English fallback */
  var tk = function (key, en) { return window.PVI18N ? window.PVI18N.tk(key, en) : en; };
  /** replace {name} placeholders */
  var fill = function (s, params) {
    return String(s).replace(/\{(\w+)\}/g, function (m, k) { return params && params[k] != null ? params[k] : m; });
  };

  // ── formatters ────────────────────────────────────────────────────────
  var nf = function () { try { return new Intl.NumberFormat(window.PVI18N ? window.PVI18N.lang : 'en'); } catch (e) { return new Intl.NumberFormat('en'); } };
  var fmt = {
    num: function (n) { return n == null ? '–' : nf().format(Math.round(n)); },
    compact: function (n) {
      if (n == null) return '–';
      var a = Math.abs(n);
      if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
      if (a >= 1e4) return (n / 1e3).toFixed(a >= 1e5 ? 0 : 1).replace(/\.0$/, '') + 'k';
      return nf().format(Math.round(n));
    },
    pct: function (n, digits) { return n == null ? '–' : (Math.round(n * 10) / 10).toFixed(digits == null ? (Math.abs(n) < 10 && n % 1 ? 1 : 0) : digits) + '%'; },
    share: function (x) { return x == null ? '–' : Math.round(x * 100) + '%'; },
    usd: function (n) { return n == null ? '–' : '$' + (Math.abs(n) >= 1000 ? nf().format(Math.round(n)) : Number(n).toFixed(2)); },
    /** relative change in % from cur/prev (null when prev is 0) */
    change: function (cur, prev) { return prev ? ((cur - prev) / prev) * 100 : null; },
    /** ▲ 12% / ▼ 3% with up|dn class; `invert` = lower is better (IVT) */
    delta: function (d, opts) {
      opts = opts || {};
      if (d == null || !isFinite(d)) return { text: opts.none || '', cls: '' };
      var r = Math.round(d * 10) / 10;
      var good = opts.invert ? r <= 0 : r >= 0;
      var txt = (r > 0 ? '▲ ' : r < 0 ? '▼ ' : '') + (Math.abs(r) >= 10 ? Math.round(Math.abs(r)) : Math.abs(r)) + (opts.unit || '%');
      return { text: txt, cls: r === 0 ? '' : good ? 'up' : 'dn' };
    },
    days: function (n) { return n == null ? '–' : fill(t('{n} d'), { n: n }); },
    date: function (ts) { if (!ts) return '–'; try { return new Date(ts).toLocaleDateString(window.PVI18N ? window.PVI18N.lang : 'en', { month: 'short', day: 'numeric' }); } catch (e) { return new Date(ts).toISOString().slice(0, 10); } },
    ago: function (ts, now) {
      if (!ts) return '–';
      var s = Math.max(0, ((now || Date.now()) - ts) / 1000);
      if (s < 3600) return fill(t('{n} min ago'), { n: Math.max(1, Math.round(s / 60)) });
      if (s < 86400) return fill(t('{n} h ago'), { n: Math.round(s / 3600) });
      return fill(t('{n} d ago'), { n: Math.round(s / 86400) });
    },
  };

  // ── colours ───────────────────────────────────────────────────────────
  var AVATAR = ['#7c6cff', '#22b07d', '#e0663f', '#2f8cf0', '#d64f8a', '#c9a227', '#11a3a3', '#8a5cf6', '#5e6ad2'];
  var hash = function (s) { var h = 0; s = String(s || ''); for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); };
  var SPARK = '#9a8cff', SPARK_NEG = '#ff7a85';
  var uid = 0;

  // ── sparklines ────────────────────────────────────────────────────────
  function points(vals, w, h, pad) {
    var max = Math.max.apply(null, vals.concat([1]));
    var n = Math.max(vals.length - 1, 1);
    return vals.map(function (v, i) {
      return [(i / n) * w, h - pad - ((v || 0) / max) * (h - pad * 2 - 1)];
    });
  }
  var ptsStr = function (p) { return p.map(function (q) { return q[0].toFixed(1) + ',' + q[1].toFixed(1); }).join(' '); };

  /** gradient-filled area sparkline; red when `neg` (Δ < 0). Values oldest first.
   *  opts: {w, h, color, neg, fluid (stretch to container width), label} */
  function areaSpark(vals, opts) {
    opts = opts || {};
    vals = (vals || []).map(function (v) { return typeof v === 'object' && v ? v.uv : v; });
    var w = opts.w || 110, h = opts.h || 26;
    var c = opts.color || (opts.neg ? SPARK_NEG : SPARK);
    var id = 'ga' + (++uid);
    if (!vals.length) vals = [0, 0];
    var p = points(vals, w, h, 2);
    var line = ptsStr(p);
    var size = opts.fluid ? 'width="100%" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none"' : 'width="' + w + '" height="' + h + '"';
    return '<svg class="spark" ' + size + ' role="img" aria-label="' + esc(opts.label || t('trend')) + '">'
      + '<defs><linearGradient id="' + id + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="' + c + '" stop-opacity=".42"/><stop offset="1" stop-color="' + c + '" stop-opacity="0"/></linearGradient></defs>'
      + '<polygon fill="url(#' + id + ')" points="0,' + h + ' ' + line + ' ' + w + ',' + h + '"/>'
      + '<polyline fill="none" stroke="' + c + '" stroke-width="1.6" stroke-linejoin="round" vector-effect="non-scaling-stroke" points="' + line + '"/></svg>';
  }

  /** plain line sparkline */
  function sparkline(vals, opts) {
    opts = opts || {};
    vals = (vals || []).map(function (v) { return typeof v === 'object' && v ? v.uv : v; });
    var w = opts.w || 96, h = opts.h || 22, c = opts.color || (opts.neg ? SPARK_NEG : SPARK);
    if (!vals.length) vals = [0, 0];
    return '<svg class="spark" width="' + w + '" height="' + h + '" role="img" aria-label="' + esc(opts.label || t('trend')) + '"><polyline fill="none" stroke="' + c + '" stroke-width="1.5" points="' + ptsStr(points(vals, w, h, 2)) + '"/></svg>';
  }

  // ── atoms ─────────────────────────────────────────────────────────────
  /** coloured letter avatar, stable colour per seed (site id) */
  function avatar(name, seed, size) {
    var ch = (String(name || '?').trim().match(/./u) || ['?'])[0].toUpperCase();
    var s = size ? ' style="width:' + size + 'px;height:' + size + 'px;background:' + AVATAR[hash(seed || name) % AVATAR.length] + '"' : ' style="background:' + AVATAR[hash(seed || name) % AVATAR.length] + '"';
    return '<span class="av" aria-hidden="true"' + s + '>' + esc(ch) + '</span>';
  }
  /** soft filled chip; tone: muted|amber|blue|violet|green|red|accent */
  function chip(text, tone, title) {
    return '<span class="pchip ' + (tone || 'muted') + '"' + (title ? ' title="' + esc(title) + '"' : '') + '>' + esc(text) + '</span>';
  }

  var STAGES = ['setup', 'awaiting_crawl', 'crawled', 'organic', 'growing', 'declining', 'archived'];
  var STAGE_TONE = { setup: 'muted', awaiting_crawl: 'amber', crawled: 'blue', organic: 'violet', growing: 'green', declining: 'red', archived: 'muted' };
  var STAGE_EN = {
    setup: 'Setup', awaiting_crawl: 'Awaiting crawl', crawled: 'Crawled', organic: 'Organic',
    growing: 'Growing', declining: 'Declining', archived: 'Archived',
  };
  var STAGE_LONG_EN = {
    setup: 'Setup (no data yet)', awaiting_crawl: 'Live · awaiting crawl', crawled: 'Crawled', organic: 'Organic traffic',
    growing: 'Stable growth', declining: 'Declining / stalled', archived: 'Archived',
  };
  var stageLabel = function (s, long) { return tk((long ? 'stage-long.' : 'stage.') + s, (long ? STAGE_LONG_EN : STAGE_EN)[s] || s); };
  function stageChip(stage) { return chip(stageLabel(stage), STAGE_TONE[stage]); }

  /** 14 daily health bars (ok | warn | bad | none) */
  function healthBar(health) {
    var title = { ok: t('healthy'), warn: t('elevated invalid traffic'), bad: t('no data or high invalid traffic'), none: t('no data yet') };
    return '<span class="hbar" role="img" aria-label="' + esc(t('Daily health')) + '">'
      + (health || []).map(function (h) { return '<i class="' + esc(h) + '" title="' + esc(title[h] || '') + '"></i>'; }).join('') + '</span>';
  }

  /** G B Y 百 crawl chips: ok = crawled, late = crawl overdue (Google only) */
  var ENGINES = [['google', 'G', 'Google'], ['bing', 'B', 'Bing'], ['yandex', 'Y', 'Yandex'], ['baidu', '百', 'Baidu']];
  function engineChips(crawl, opts) {
    opts = opts || {};
    crawl = crawl || {};
    return '<span class="eng">' + ENGINES.map(function (e) {
      var c = crawl[e[0]];
      var cls = c ? 'ok' : (e[0] === 'google' && opts.late ? 'late' : '');
      var tip = e[2] + ': ' + (c ? t('first crawl') + ' ' + fmt.date(c.first_seen_at) + ' · ' + t('last') + ' ' + fmt.ago(c.last_seen_at) : t('not crawled yet'));
      return '<span class="e ' + cls + '" title="' + esc(tip) + '">' + e[1] + '</span>';
    }).join('') + '</span>';
  }

  var SEV_RANK = { critical: 0, high: 1, normal: 2 };
  /** attention reason → localized text (i18n key attn.<code>, {param} placeholders) */
  function attnText(a) {
    var p = Object.assign({}, a.params || {});
    if (p.ivt_pct != null) p.ivt_pct = Math.round(p.ivt_pct);
    if (p.prev_pct != null) p.prev_pct = Math.round(p.prev_pct);
    if (p.pct != null) p.pct = Math.round(Math.abs(p.pct));
    if (p.adguard_mode != null) p.adguard_mode = t(p.adguard_mode);
    var key = 'attn.' + a.code + (a.code === 'ivt_high' && a.params && a.params.adguard_mode === 'off' ? '_off' : '')
      + (a.code === 'no_data_24h' && a.params && a.params.ever === false ? '_never' : '');
    var en = ATTN_EN[key] || ATTN_EN['attn.' + a.code] || a.code;
    var s = tk(key, en);
    if (s === key) s = tk('attn.' + a.code, en);
    return fill(s, p);
  }
  var ATTN_EN = {
    'attn.no_data_24h': 'No data in the last {hours} h — check the embed code',
    'attn.no_data_24h_never': 'No data received yet — check the embed code',
    'attn.crawl_overdue': 'Live {days} days, no search engine has crawled it yet',
    'attn.organic_overdue': 'Crawled {days} days ago, still no search visitors',
    'attn.declining': 'Visitors down {pct}% over {days} days',
    'attn.ivt_high': 'Invalid traffic {ivt_pct}%',
    'attn.ivt_high_off': 'Invalid traffic {ivt_pct}% while ad protection is off',
    'attn.ivt_spike': 'Invalid traffic jumped to {ivt_pct}% (was {prev_pct}%)',
  };
  /** top attention item as a soft chip (red for critical/high, amber for normal) */
  function attnChip(list) {
    if (!list || !list.length) return '';
    var a = list.slice().sort(function (x, y) { return (SEV_RANK[x.severity] || 9) - (SEV_RANK[y.severity] || 9); })[0];
    var more = list.length > 1 ? ' <b>+' + (list.length - 1) + '</b>' : '';
    return '<span class="att ' + (a.severity === 'normal' ? 'w' : '') + '" title="' + esc(list.map(attnText).join('\n')) + '">' + esc(attnText(a)) + more + '</span>';
  }

  window.pvuvUI = {
    esc: esc, fill: fill, fmt: fmt, areaSpark: areaSpark, sparkline: sparkline, avatar: avatar, chip: chip,
    stageChip: stageChip, stageLabel: stageLabel, STAGES: STAGES, STAGE_TONE: STAGE_TONE,
    healthBar: healthBar, engineChips: engineChips, attnText: attnText, attnChip: attnChip, SEV_RANK: SEV_RANK,
    colors: { spark: SPARK, sparkNeg: SPARK_NEG, avatar: AVATAR },
  };
})();
