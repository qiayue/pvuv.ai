/**
 * pvuv.ai console — shared page shell (docs/design/portfolio-mock-light.html):
 * the left sidebar every console page gets. Classic script; include it after
 * i18n.js on any page:
 *
 *   <script src="/js/shell.js"></script>
 *
 * It renders the sidebar into <aside id="shell"> (created if the page has
 * none) and moves the rest of the page into <div class="shell-content">, so
 * a page keeps its own header / main markup. Body gets `has-shell`.
 *
 * Counts (needs attention / starred / all) come from the portfolio overview:
 * the overview page publishes its payload with
 *   document.dispatchEvent(new CustomEvent('pvuv:portfolio', { detail: payload }))
 * and other pages read a 5-minute sessionStorage copy, else fetch
 * /api/portfolio once (itself cached server-side for 5 minutes).
 *
 * Links on /sites.html navigate in place: the shell pushes the URL and fires
 * `pvuv:route`; the overview re-reads its state from location. After the
 * overview rewrites its own URL it fires `pvuv:urlchange` and the shell
 * re-marks the active item.
 *
 *   window.pvuvShell = { refresh(), setCounts(payload) }
 */
(function () {
  'use strict';
  if (window.pvuvShell) return;
  var t = function (s) { return window.PVI18N ? window.PVI18N.t(s) : s; };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var CACHE_KEY = 'pvuv.shell.v1';
  var TTL = 5 * 60 * 1000;

  var ICON = {
    overview: 'M4 19V9M10 19V5M16 19v-7M22 19H2',
    alert: 'M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
    star: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z',
    globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18',
    search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-5-5',
    layers: 'M12 3l9 4.5-9 4.5L3 7.5zM3 12l9 4.5 9-4.5M3 16.5L12 21l9-4.5',
    flask: 'M9 3h6M10 3v6L4 19a1 1 0 0 0 .9 1.5h14.2A1 1 0 0 0 20 19l-6-10V3',
    dollar: 'M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6',
    plug: 'M9 7V3M15 7V3M7 7h10v4a5 5 0 0 1-10 0zM12 16v5',
    key: 'M7.5 11a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM10.7 12.3L21 2M16 7l3 3M19 4l2 2',
    gear: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 14a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 3.1V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.9H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
    plus: 'M12 5v14M5 12h14',
    home: 'M3 10l9-7 9 7v10a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
    more: 'M5 12h.01M12 12h.01M19 12h.01',
    menu: 'M4 6h16M4 12h16M4 18h16',
  };
  var icon = function (n) { return '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="' + ICON[n] + '"/></svg>'; };

  // id, label, icon, href, active(path, params), count key
  var GROUPS = [
    ['Sites', [
      ['overview', 'Overview', 'overview', '/sites.html', function (p, q) { return p === '/sites.html' && !q.get('view') && (!q.get('tab') || q.get('tab') === 'overview'); }],
      ['attention', 'Needs attention', 'alert', '/sites.html?tab=sites&view=attention', function (p, q) { return p === '/sites.html' && q.get('view') === 'attention'; }, 'attention'],
      ['starred', 'Starred', 'star', '/sites.html?tab=sites&view=starred', function (p, q) { return p === '/sites.html' && q.get('view') === 'starred'; }, 'starred'],
      ['all', 'All sites', 'globe', '/sites.html?tab=sites&view=all', function (p, q) { return p === '/sites.html' && q.get('tab') === 'sites' && (!q.get('view') || q.get('view') === 'all') && !q.get('preset'); }, 'all'],
    ]],
    ['Analysis', [
      ['crawl', 'Indexing & crawlers', 'search', '/sites.html?tab=sites&preset=crawl', function (p, q) { return p === '/sites.html' && q.get('preset') === 'crawl'; }],
      ['quality', 'Traffic quality', 'layers', '/sites.html?tab=sites&preset=quality', function (p, q) { return p === '/sites.html' && q.get('preset') === 'quality'; }],
      ['experiments', 'Experiments', 'flask', '/sites.html?tab=sites&preset=experiments', function (p, q) { return p === '/sites.html' && q.get('preset') === 'experiments'; }],
      ['revenue', 'Revenue', 'dollar', '/sites.html?tab=sites&preset=revenue', function (p, q) { return p === '/sites.html' && q.get('preset') === 'revenue'; }],
    ]],
    ['Configure', [
      ['integrations', 'Integrations', 'plug', '/integrations.html', function (p) { return p === '/integrations.html'; }],
      ['tokens', 'API tokens', 'key', '/settings.html#tokens', function (p, q, h) { return p === '/settings.html' && h === '#tokens'; }],
      ['settings', 'Settings', 'gear', '/settings.html', function (p, q, h) { return p === '/settings.html' && h !== '#tokens'; }],
    ]],
  ];

  var state = { counts: null, brand: null, user: null };
  var aside = null;

  function readCache() {
    try { var c = JSON.parse(sessionStorage.getItem(CACHE_KEY) || 'null'); return c && Date.now() - c.at < TTL ? c : null; } catch (e) { return null; }
  }
  function writeCache() {
    try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), counts: state.counts, brand: state.brand, user: state.user })); } catch (e) { /* storage blocked */ }
  }
  function countsOf(p) {
    var c = { all: 0, attention: 0, starred: 0 };
    (p && p.sites || []).forEach(function (s) {
      if (s.status === 'archived') return;
      c.all++; if (s.attention && s.attention.length) c.attention++; if (s.starred) c.starred++;
    });
    return c;
  }
  function setCounts(payload) { state.counts = countsOf(payload); writeCache(); render(); }

  function active(fn) {
    var q = new URLSearchParams(location.search);
    // the bare overview link also covers a site dashboard opened from it
    return fn(location.pathname === '/' ? '/sites.html' : location.pathname, q, location.hash);
  }

  function render() {
    if (!aside) return;
    var b = state.brand || {};
    var name = (b.name || '').trim() || 'pvuv';
    var logo = b.logo_dark || b.logo_light;
    var user = state.user || '';
    var c = state.counts;
    var nav = GROUPS.map(function (g) {
      return '<h5>' + esc(t(g[0])) + '</h5>' + g[1].map(function (it) {
        var n = it[5] && c ? '<span class="n">' + c[it[5]] + '</span>' : '';
        var on = active(it[4]);
        return '<a href="' + it[3] + '" data-nav="' + it[0] + '"' + (on ? ' class="on" aria-current="page"' : '') + '>' + icon(it[2]) + '<span>' + esc(t(it[1])) + '</span>' + n + '</a>';
      }).join('');
    }).join('');
    var lang = window.PVI18N ? '<select data-lang aria-label="Language">' + window.PVI18N.langs.map(function (l) {
      return '<option value="' + l.code + '"' + (l.code === window.PVI18N.lang ? ' selected' : '') + '>' + esc(l.label) + '</option>';
    }).join('') + '</select>' : '';
    aside.innerHTML =
      '<a class="logo" href="/sites.html">' + (logo ? '<img src="' + esc(logo) + '" alt="' + esc(name) + '">' : '<img class="mark-img" src="/pvuv-icon.svg" alt="">' + esc(name)) + '</a>'
      + '<button type="button" class="shell-toggle iconbtn" aria-label="' + esc(t('Menu')) + '" aria-expanded="false">' + icon('menu') + '</button>'
      + '<div class="ws"><small>' + esc(t('Workspace')) + '</small><div>' + icon('home') + '<span>' + esc(name) + '</span></div></div>'
      + '<a class="p-btn primary cta" href="/sites.html?new=1" data-new>' + icon('plus') + esc(t('New site')) + '</a>'
      + '<nav class="groups" aria-label="' + esc(t('Views')) + '">' + nav + '</nav>'
      + '<div class="me"><span class="av">' + esc((user || '?').slice(0, 1).toUpperCase()) + '</span><div class="grow">' + esc(user || '…') + '<small>' + esc(t('Self-hosted')) + '</small></div>'
      + '<div class="menu"><button type="button" class="iconbtn" data-more aria-haspopup="true" aria-expanded="false" aria-label="' + esc(t('More')) + '">' + icon('more') + '</button>'
      + '<div class="menu-pop up" hidden><h5>' + esc(t('Language')) + '</h5><div style="padding:0 6px">' + lang + '</div><hr>'
      + '<a href="/health.html">' + esc(t('Self-check')) + '</a><button type="button" data-logout>' + esc(t('Sign out')) + '</button></div></div></div>';
  }

  function onClick(e) {
    var a = e.target.closest('a[data-nav], a[data-new]');
    if (a && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) {
      // the overview handles its own links in place
      if (a.hasAttribute('data-new') && typeof window.pvuvOpenAdd === 'function') { e.preventDefault(); window.pvuvOpenAdd(); return; }
      var url = new URL(a.href, location.href);
      if (location.pathname === '/sites.html' && url.pathname === '/sites.html' && !a.hasAttribute('data-new')) {
        e.preventDefault();
        history.pushState(null, '', url.pathname + url.search);
        document.dispatchEvent(new CustomEvent('pvuv:route'));
        aside.classList.remove('open');
        render();
      }
      return;
    }
    if (e.target.closest('[data-more]')) {
      var pop = aside.querySelector('.menu-pop');
      pop.hidden = !pop.hidden;
      e.target.closest('[data-more]').setAttribute('aria-expanded', String(!pop.hidden));
      return;
    }
    if (e.target.closest('.shell-toggle')) {
      var open = aside.classList.toggle('open');
      e.target.closest('.shell-toggle').setAttribute('aria-expanded', String(open));
      return;
    }
    if (e.target.closest('[data-logout]')) {
      fetch('/api/logout', { method: 'POST' }).finally(function () { location.href = '/login.html'; });
    }
  }

  function mount() {
    if (aside) return;
    aside = document.getElementById('shell');
    if (!aside) { aside = document.createElement('aside'); aside.id = 'shell'; }
    aside.classList.add('shell');
    var wrap = document.createElement('div');
    wrap.className = 'shell-content';
    // move the page's visible content (not scripts / dialogs / the aside) into the content column
    Array.prototype.slice.call(document.body.childNodes).forEach(function (n) {
      if (n === aside || (n.nodeType === 1 && /^(SCRIPT|DIALOG|TEMPLATE|DATALIST|STYLE|LINK)$/.test(n.tagName))) return;
      if (n.nodeType === 3 && !n.textContent.trim()) return;
      wrap.appendChild(n);
    });
    document.body.insertBefore(wrap, document.body.firstChild);
    document.body.insertBefore(aside, wrap);
    document.body.classList.add('has-shell');
    aside.addEventListener('click', onClick);
    aside.addEventListener('change', function (e) { if (e.target.matches('[data-lang]') && window.PVI18N) window.PVI18N.setLang(e.target.value); });
    document.addEventListener('mousedown', function (e) {
      var pop = aside.querySelector('.menu-pop');
      if (pop && !pop.hidden && !e.target.closest('.shell .menu')) pop.hidden = true;
    });

    var cached = readCache();
    if (cached) { state.counts = cached.counts; state.brand = cached.brand; state.user = cached.user; }
    render();
    if (!cached || !cached.brand) {
      fetch('/api/home').then(function (r) { return r.ok ? r.json() : null; }).then(function (b) { if (b) { state.brand = b; writeCache(); render(); } }).catch(function () {});
    }
    if (!cached || !cached.user) {
      fetch('/api/me').then(function (r) { return r.ok ? r.json() : null; }).then(function (m) { if (m) { state.user = m.user; writeCache(); render(); } }).catch(function () {});
    }
    // the overview publishes its payload; elsewhere fetch the (cached) overview once
    if (!cached || !cached.counts) {
      setTimeout(function () {
        if (state.counts || location.pathname === '/sites.html') return;
        fetch('/api/portfolio?period=7d').then(function (r) { return r.ok ? r.json() : null; }).then(function (p) { if (p) setCounts(p); }).catch(function () {});
      }, 400);
    }
  }

  document.addEventListener('pvuv:portfolio', function (e) { setCounts(e.detail); });
  document.addEventListener('pvuv:urlchange', render);
  document.addEventListener('pvuv:lang', render);
  window.addEventListener('popstate', render);
  window.addEventListener('hashchange', render);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();

  window.pvuvShell = { refresh: render, setCounts: setCounts };
})();
