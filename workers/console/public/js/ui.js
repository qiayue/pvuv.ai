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
      if (a >= 1e4) return (n / 1e3).toFixed(a >= 1e5 ? 0 : 1).replace(/\.0$/, '') + 'K';
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

  // ── colours (mirror console.css tokens; SVG strokes need literals) ────
  var BLUE = '#3b82f6', RED = '#dc2626';
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
  var values = function (vals) { return (vals || []).map(function (v) { return typeof v === 'object' && v ? v.uv : v; }); };

  /** thin 1.5px line sparkline, red when `neg` (Δ < 0). Values oldest first
   *  (numbers or {uv}). opts: {w, h, color, neg, label} */
  function sparkline(vals, opts) {
    opts = opts || {};
    vals = values(vals);
    var w = opts.w || 90, h = opts.h || 22, c = opts.color || (opts.neg ? RED : BLUE);
    if (!vals.length) vals = [0, 0];
    return '<svg class="spark" width="' + w + '" height="' + h + '" role="img" aria-label="' + esc(opts.label || t('trend')) + '"><polyline fill="none" stroke="' + c + '" stroke-width="1.5" stroke-linejoin="round" points="' + ptsStr(points(vals, w, h, 2)) + '"/></svg>';
  }

  /** line + very faint fill (the light style allows a fill only under the main
   *  chart); same options as sparkline plus `fluid` (stretch to the container). */
  function areaSpark(vals, opts) {
    opts = opts || {};
    vals = values(vals);
    var w = opts.w || 110, h = opts.h || 26;
    var c = opts.color || (opts.neg ? RED : BLUE);
    var id = 'ga' + (++uid);
    if (!vals.length) vals = [0, 0];
    var line = ptsStr(points(vals, w, h, 2));
    var size = opts.fluid ? 'width="100%" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none"' : 'width="' + w + '" height="' + h + '"';
    return '<svg class="spark" ' + size + ' role="img" aria-label="' + esc(opts.label || t('trend')) + '">'
      + '<defs><linearGradient id="' + id + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="' + c + '" stop-opacity=".14"/><stop offset="1" stop-color="' + c + '" stop-opacity="0"/></linearGradient></defs>'
      + '<polygon fill="url(#' + id + ')" points="0,' + h + ' ' + line + ' ' + w + ',' + h + '"/>'
      + '<polyline fill="none" stroke="' + c + '" stroke-width="1.5" stroke-linejoin="round" vector-effect="non-scaling-stroke" points="' + line + '"/></svg>';
  }

  /** main chart: smooth line + faint fill, optional grey bars (secondary
   *  series, own scale) and y-axis labels. points: [{label, v, bar}] */
  function lineChart(pts, opts) {
    opts = opts || {};
    var W = opts.w || 1000, H = opts.h || 240, L = 46, T = 10, B = 24, R = 8;
    var n = pts.length;
    if (!n) return '';
    var maxV = Math.max.apply(null, pts.map(function (p) { return p.v || 0; }).concat([1]));
    var step = Math.pow(10, Math.floor(Math.log10(maxV))); var nice = Math.ceil(maxV / step) * step;
    if (nice / 4 < step / 2) nice = Math.ceil(maxV / (step / 2)) * (step / 2);
    if (!opts.fmtY && nice < 4) nice = 4; // integer counts: never label the axis 0.25, 0.5, …
    var maxB = Math.max.apply(null, pts.map(function (p) { return p.bar || 0; }).concat([1]));
    var x = function (i) { return L + (n === 1 ? (W - L - R) / 2 : i * (W - L - R) / (n - 1)); };
    var y = function (v) { return T + (H - T - B) * (1 - v / nice); };
    var s = '<defs><linearGradient id="lcf" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="' + BLUE + '" stop-opacity=".14"/><stop offset="1" stop-color="' + BLUE + '" stop-opacity="0"/></linearGradient></defs>';
    for (var g = 0; g <= 4; g++) {
      var v = nice * g / 4;
      s += '<line x1="' + L + '" x2="' + W + '" y1="' + y(v) + '" y2="' + y(v) + '" stroke="#ececef"' + (g ? ' stroke-dasharray="3 4"' : '') + '/>'
        + '<text x="' + (L - 8) + '" y="' + (y(v) + 4) + '" text-anchor="end" font-size="11" fill="#8a8a93">' + esc(opts.fmtY ? opts.fmtY(v) : fmt.compact(v)) + '</text>';
    }
    var bw = Math.max(3, Math.min(14, (W - L - R) / n * 0.5));
    pts.forEach(function (p, i) {
      if (p.bar) { var bh = (p.bar / maxB) * (H - T - B) * 0.35; s += '<rect x="' + (x(i) - bw / 2) + '" y="' + (H - B - bh) + '" width="' + bw + '" height="' + bh + '" rx="2" fill="#e4e4e7"><title>' + esc(p.barTitle || '') + '</title></rect>'; }
    });
    var d = 'M' + x(0) + ',' + y(pts[0].v || 0);
    for (var i = 1; i < n; i++) { var cx = (x(i - 1) + x(i)) / 2; d += ' C' + cx + ',' + y(pts[i - 1].v || 0) + ' ' + cx + ',' + y(pts[i].v || 0) + ' ' + x(i) + ',' + y(pts[i].v || 0); }
    s += '<path d="' + d + ' L' + x(n - 1) + ',' + (H - B) + ' L' + x(0) + ',' + (H - B) + 'Z" fill="url(#lcf)"/><path d="' + d + '" fill="none" stroke="' + BLUE + '" stroke-width="2.2" vector-effect="non-scaling-stroke"/>';
    pts.forEach(function (p, i) { s += '<circle cx="' + x(i) + '" cy="' + y(p.v || 0) + '" r="8" fill="transparent"><title>' + esc(p.label + ': ' + (opts.fmtV ? opts.fmtV(p.v) : fmt.num(p.v)) + (p.bar ? ' · ' + (p.barTitle || '') : '')) + '</title></circle>'; });
    return '<svg class="lchart" width="100%" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="' + esc(opts.label || '') + '">' + s + '</svg>';
  }

  // ── atoms ─────────────────────────────────────────────────────────────
  /** neutral bordered initial tile (site identity) */
  function avatar(name) {
    var ch = (String(name || '?').trim().match(/./u) || ['?'])[0].toUpperCase();
    return '<span class="fav" aria-hidden="true">' + esc(ch) + '</span>';
  }
  /** small grey tag */
  function chip(text, tone, title) {
    return '<span class="ptag' + (tone ? ' ' + esc(tone) : '') + '"' + (title ? ' title="' + esc(title) + '"' : '') + '>' + esc(text) + '</span>';
  }

  var STAGES = ['setup', 'awaiting_crawl', 'crawled', 'organic', 'growing', 'declining', 'archived'];
  var STAGE_COLOR = { setup: 'var(--stage-setup)', awaiting_crawl: 'var(--stage-awaiting_crawl)', crawled: 'var(--stage-crawled)', organic: 'var(--stage-organic)', growing: 'var(--stage-growing)', declining: 'var(--stage-declining)', archived: 'var(--stage-archived)' };
  // English source strings shared with the management stream's i18n keys
  var STAGE_EN = {
    setup: 'Awaiting install', awaiting_crawl: 'Awaiting crawl', crawled: 'Crawled', organic: 'Organic traffic',
    growing: 'Stable growth', declining: 'Declining', archived: 'Archived',
  };
  var stageLabel = function (s) { return t(STAGE_EN[s] || s); };
  /** status: coloured dot + grey text */
  function stageChip(stage, title) {
    return '<span class="stage"' + (title ? ' title="' + esc(title) + '"' : '') + '><i style="background:' + (STAGE_COLOR[stage] || 'var(--muted-2)') + '"></i>' + esc(stageLabel(stage)) + '</span>';
  }

  /** 14 daily health bars (ok | warn | bad | none) */
  function healthBar(health) {
    var title = { ok: t('healthy'), warn: t('elevated invalid traffic'), bad: t('no data or high invalid traffic'), none: t('no data yet') };
    return '<span class="hbar" role="img" aria-label="' + esc(t('Daily health')) + '">'
      + (health || []).map(function (h) { return '<i class="' + esc(h) + '" title="' + esc(title[h] || '') + '"></i>'; }).join('') + '</span>';
  }

  /** G B Y 百 crawl letters: dark = crawled, grey = not yet, amber = overdue (Google) */
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
    // portfolio:p3 — external data (docs/INTEGRATIONS.md §4)
    'attn.traffic_no_revenue': '{uv} clean visitors but no ad revenue',
    'attn.adsense_needs_attention': 'AdSense needs attention ({domain})',
    'attn.ads_txt_problem': 'ads.txt problem: {status}',
    'attn.network_declined': 'Ads disabled by {network}',
    'attn.external_stale': '{source} data not updated for {hours} h',
  };
  /** top attention item as coloured text (red for critical/high, amber for normal) */
  function attnChip(list) {
    if (!list || !list.length) return '';
    // critical ranks 0, so a falsy check would sort it last — test for presence
    var rank = function (x) { return x.severity in SEV_RANK ? SEV_RANK[x.severity] : 9; };
    var a = list.slice().sort(function (x, y) { return rank(x) - rank(y); })[0];
    var more = list.length > 1 ? ' <b>+' + (list.length - 1) + '</b>' : '';
    return '<span class="att ' + (a.severity === 'normal' ? 'w' : 'c') + '" title="' + esc(list.map(attnText).join('\n')) + '">' + esc(attnText(a)) + more + '</span>';
  }

  window.pvuvUI = {
    esc: esc, fill: fill, fmt: fmt, areaSpark: areaSpark, sparkline: sparkline, lineChart: lineChart, avatar: avatar, chip: chip,
    stageChip: stageChip, stageLabel: stageLabel, STAGES: STAGES, STAGE_COLOR: STAGE_COLOR,
    healthBar: healthBar, engineChips: engineChips, attnText: attnText, attnChip: attnChip, SEV_RANK: SEV_RANK,
    colors: { line: BLUE, neg: RED },
  };
})();
