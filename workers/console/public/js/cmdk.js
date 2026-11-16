/**
 * pvuv.ai console — ⌘K / Ctrl+K / "/" site switcher, loaded on every console
 * page (docs/design/portfolio-ui.md §4). Classic script, self-contained styles.
 *
 * Sites come from `window.pvuvCmdk.setSites(list)` when the page already has
 * them (the portfolio overview), otherwise from GET /api/sites on first open.
 * Fuzzy match over name, domains and tags; recently opened sites first.
 *
 *   window.pvuvCmdk = { open(), close(), setSites(list), recordRecent(id) }
 */
(function () {
  'use strict';
  if (window.pvuvCmdk) return;
  var RECENT_KEY = 'pvuv.recent';
  var t = function (s) { return window.PVI18N ? window.PVI18N.t(s) : s; };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };

  var sites = null, loading = null, root = null, input = null, list = null, items = [], active = 0, lastFocus = null;

  function recent() { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]').filter(function (x) { return typeof x === 'string'; }); } catch (e) { return []; } }
  function recordRecent(id) {
    if (!id) return;
    try { localStorage.setItem(RECENT_KEY, JSON.stringify([id].concat(recent().filter(function (x) { return x !== id; })).slice(0, 8))); } catch (e) { /* storage blocked */ }
  }
  function norm(s) {
    var domains = s.domains || [];
    if (!domains.length && s.allowed_domains) { try { domains = JSON.parse(s.allowed_domains); } catch (e) { domains = []; } }
    return { site_id: s.site_id, name: s.name || s.site_id, domains: domains, tags: s.tags || [], status: s.status || 'active' };
  }
  function setSites(list) { sites = (list || []).map(norm); if (root && !root.hidden) render(); }
  function load() {
    if (sites) return Promise.resolve(sites);
    if (!loading) {
      loading = fetch('/api/sites', { credentials: 'same-origin' })
        .then(function (r) { return r.ok ? r.json() : { sites: [] }; })
        .then(function (d) { if (!sites) setSites(d.sites || []); return sites; })
        .catch(function () { sites = sites || []; return sites; });
    }
    return loading;
  }

  /** subsequence fuzzy score: higher is better, -1 = no match */
  function score(q, text) {
    text = String(text || '').toLowerCase();
    if (!q) return 0;
    var at = text.indexOf(q);
    if (at === 0) return 100 - text.length / 100;
    if (at > 0) return 80 - at / 10;
    var i = 0, j = 0, gaps = 0, last = -1;
    while (i < q.length && j < text.length) {
      if (q[i] === text[j]) { if (last >= 0) gaps += j - last - 1; last = j; i++; }
      j++;
    }
    return i === q.length ? Math.max(1, 50 - gaps) : -1;
  }
  function match(q) {
    q = q.trim().toLowerCase();
    var rec = recent();
    var all = (sites || []).map(function (s) {
      var best = Math.max(score(q, s.name), Math.max.apply(null, s.domains.map(function (d) { return score(q, d); }).concat([-1])) - 5,
        Math.max.apply(null, s.tags.map(function (d) { return score(q, d); }).concat([-1])) - 10, score(q, s.site_id) - 20);
      var r = rec.indexOf(s.site_id);
      return { s: s, sc: best + (r >= 0 ? 30 - r : 0) - (s.status === 'archived' ? 15 : 0) };
    }).filter(function (x) { return !q || x.sc >= 0; });
    all.sort(function (a, b) { return b.sc - a.sc || a.s.name.localeCompare(b.s.name); });
    return all.slice(0, 50).map(function (x) { return x.s; });
  }

  function css() {
    if (document.getElementById('cmdk-css')) return;
    var st = document.createElement('style');
    st.id = 'cmdk-css';
    st.textContent = '.cmdk{position:fixed;inset:0;z-index:200;background:rgba(24,24,27,.28);display:flex;align-items:flex-start;justify-content:center;padding-top:12vh}'
      + '.cmdk[hidden]{display:none}.cmdk-box{width:min(560px,92vw);background:var(--surface,#fff);color:var(--text,#18181b);border:1px solid var(--line,#e7e7ea);border-radius:12px;box-shadow:0 12px 40px rgba(24,24,27,.14);overflow:hidden}'
      + '.cmdk input{width:100%;border:0;border-bottom:1px solid var(--line,#e7e7ea);border-radius:0;background:transparent;color:inherit;padding:14px 16px;font-size:15px;outline:none;min-height:0}'
      + '.cmdk input:focus{border-color:var(--line,#e7e7ea)}'
      + '.cmdk ul{list-style:none;margin:0;padding:6px;max-height:52vh;overflow:auto}.cmdk li{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;cursor:pointer;color:var(--text,#18181b)}'
      + '.cmdk li.on{background:#f4f4f5}.cmdk li small{color:var(--mut,#8a8a93);margin-left:auto;font-size:12px;max-width:50%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
      + '.cmdk .cav{display:inline-grid;place-items:center;width:22px;height:22px;border-radius:6px;font-size:11px;color:var(--text-2,#52525b);border:1px solid var(--line,#e7e7ea);background:#fafafa;flex:none}'
      + '.cmdk .hint{padding:8px 14px;border-top:1px solid var(--line,#e7e7ea);color:var(--mut,#8a8a93);font-size:11.5px;display:flex;gap:14px}.cmdk .empty{padding:18px;color:var(--mut,#8a8a93);text-align:center}'
      + '.cmdk kbd{border:1px solid var(--line,#e7e7ea);border-radius:4px;padding:0 5px;font:11px/1.6 inherit;color:var(--mut,#8a8a93)}.cmdk .sec{padding:6px 10px 2px;color:var(--mut,#8a8a93);font-size:11px;letter-spacing:.04em}';
    document.head.appendChild(st);
  }
  function build() {
    css();
    root = document.createElement('div');
    root.className = 'cmdk';
    root.hidden = true;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.innerHTML = '<div class="cmdk-box"><input type="text" autocomplete="off" spellcheck="false" role="combobox" aria-expanded="true" aria-controls="cmdk-list">'
      + '<ul id="cmdk-list" role="listbox"></ul><div class="hint"><span><kbd>↑</kbd> <kbd>↓</kbd> ' + esc(t('navigate')) + '</span><span><kbd>↵</kbd> ' + esc(t('open')) + '</span><span><kbd>esc</kbd> ' + esc(t('close')) + '</span></div></div>';
    document.body.appendChild(root);
    input = root.querySelector('input');
    list = root.querySelector('ul');
    root.addEventListener('mousedown', function (e) { if (e.target === root) close(); });
    input.addEventListener('input', function () { active = 0; render(); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) { e.preventDefault(); move(1); }
      else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) { e.preventDefault(); move(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); go(items[active], e.metaKey || e.ctrlKey); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
    list.addEventListener('click', function (e) {
      var li = e.target.closest('li[data-i]');
      if (li) go(items[+li.dataset.i], e.metaKey || e.ctrlKey);
    });
  }
  function move(d) {
    if (!items.length) return;
    active = (active + d + items.length) % items.length;
    render();
  }
  function render() {
    input.placeholder = t('Jump to a site…');
    if (!sites) { list.innerHTML = '<li class="empty">' + esc(t('loading…')) + '</li>'; return; }
    items = match(input.value);
    if (active >= items.length) active = 0;
    if (!items.length) { list.innerHTML = '<div class="empty">' + esc(t('No matching sites')) + '</div>'; return; }
    var rec = recent();
    list.innerHTML = (!input.value && rec.length ? '<div class="sec">' + esc(t('Recent and all sites')) + '</div>' : '') + items.map(function (s, i) {
      var ch = (String(s.name).trim().match(/./u) || ['?'])[0].toUpperCase();
      return '<li role="option" data-i="' + i + '" class="' + (i === active ? 'on' : '') + '" aria-selected="' + (i === active) + '">'
        + '<span class="cav">' + esc(ch) + '</span>'
        + '<span>' + esc(s.name) + (s.status === 'archived' ? ' <small style="margin:0">· ' + esc(t('archived')) + '</small>' : '') + '</span>'
        + '<small>' + esc(s.domains.join(', ')) + '</small></li>';
    }).join('');
    var on = list.querySelector('li.on');
    if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
  }
  function go(s, newTab) {
    if (!s) return;
    recordRecent(s.site_id);
    var url = '/site.html?id=' + encodeURIComponent(s.site_id);
    close();
    if (newTab) window.open(url, '_blank'); else location.href = url;
  }
  function open() {
    if (!root) build();
    lastFocus = document.activeElement;
    root.hidden = false;
    input.value = '';
    active = 0;
    render();
    input.focus();
    load().then(function () { if (!root.hidden) render(); });
  }
  function close() {
    if (!root || root.hidden) return;
    root.hidden = true;
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  function typing(el) {
    return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
  }
  document.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      if (root && !root.hidden) close(); else open();
    } else if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey && !typing(document.activeElement) && (!root || root.hidden)) {
      e.preventDefault();
      open();
    }
  });
  // opening a site's dashboard counts as a visit
  if (/\/site\.html$/.test(location.pathname)) {
    try { recordRecent(new URLSearchParams(location.search).get('id')); } catch (e) { /* ignore */ }
  }
  window.pvuvCmdk = { open: open, close: close, setSites: setSites, recordRecent: recordRecent };
})();
