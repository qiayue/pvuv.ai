/**
 * pvuv.ai console — bulk actions toolbar (portfolio stream P2).
 *
 *   var h = window.pvuvBulk.mount(toolbarEl, getSelectedIds, onDone, opts?)
 *   h.refresh()   // call when the selection changes (also on a
 *                 // document 'pvuv:selection' event)
 *   h.destroy()
 *
 * Renders into `toolbarEl`: selection count, ★ star / ☆ unstar, tag / untag
 * (inline input), archive / restore, ad-protection mode and CSV export of the
 * selected rows. Actions go to POST /api/sites/bulk
 * {site_ids, action, value?}; `onDone({action, value, ids, result})` runs after
 * a successful write so the caller can reload. Every control is disabled while
 * nothing is selected.
 *
 * opts (all optional): { t, getSites: () => sites[], apiBase, period }.
 * CSV export uses `getSites()` (contract rows) when given; otherwise it loads
 * GET /api/portfolio?period=… and falls back to GET /api/sites.
 */
(function () {
  'use strict';

  function mount(el, getSelectedIds, onDone, opts) {
    opts = opts || {};
    var base = opts.apiBase || '/api';
    var t = function (s) { return typeof opts.t === 'function' ? opts.t(s) : (window.PVI18N ? window.PVI18N.t(s) : s); };
    var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
    var ids = function () { try { return (getSelectedIds() || []).slice(); } catch (e) { return []; } };
    var busy = false;

    function toast(msg, err) {
      var kit = window.__pvuvP2Kit;
      if (kit) return kit.toast(msg, err);
      var d = document.createElement('div'); d.className = 'p2-toast' + (err ? ' err' : ''); d.setAttribute('role', 'status');
      d.textContent = msg; document.body.appendChild(d); setTimeout(function () { d.remove(); }, 3200);
    }

    function render() {
      el.classList.add('p2-bulk');
      el.setAttribute('role', 'toolbar');
      el.setAttribute('aria-label', t('Bulk actions'));
      el.innerHTML =
        '<span class="cnt" aria-live="polite"></span><span class="sep"></span>'
        + btn('star', '★ ' + t('Star')) + btn('unstar', '☆ ' + t('Unstar'))
        + btn('tag', '# ' + t('Tag…')) + btn('untag', t('Remove tag…'))
        + '<span class="sep"></span>'
        + '<label class="p2-mut" style="display:inline-flex;align-items:center;gap:6px">' + esc(t('Ad protection')) + ' <select data-ag aria-label="' + esc(t('Ad protection')) + '">'
        + '<option value="">' + esc(t('Set…')) + '</option>'
        + '<option value="off">' + esc(t('Off')) + '</option>'
        + '<option value="balanced">' + esc(t('Balanced — bots & crawlers')) + '</option>'
        + '<option value="loose">' + esc(t('Aggressive — everything not clean')) + '</option>'
        + '<option value="strict">' + esc(t('Strictest — clean + interacted')) + '</option></select></label>'
        + '<span class="sep"></span>'
        + btn('archive', t('Archive'), 'danger') + btn('restore', t('Restore'))
        + '<span style="flex:1"></span>'
        + btn('csv', '⇩ ' + t('Export CSV'));
      el.querySelector('[data-ag]').addEventListener('change', function (e) {
        var v = e.target.value; e.target.value = '';
        if (!v) return;
        if (!confirm(t('Set ad protection to “{mode}” on {n} sites?').replace('{mode}', t(e.target.querySelector('option[value="' + v + '"]').textContent)).replace('{n}', ids().length))) return;
        run('adguard', v);
      });
      refresh();
    }
    function btn(act, label, cls) { return '<button type="button" class="p2-btn sm' + (cls ? ' ' + cls : '') + '" data-bulk="' + act + '">' + esc(label) + '</button>'; }

    function refresh() {
      var n = ids().length;
      var c = el.querySelector('.cnt');
      if (!c) return;
      c.innerHTML = n ? t('{n} selected').replace('{n}', '<b>' + n + '</b>') : esc(t('Select sites to act on them'));
      el.querySelectorAll('button, select').forEach(function (b) { b.disabled = busy || !n; });
    }

    function popover(anchor, placeholder, cb) {
      closePop();
      var p = document.createElement('div');
      p.className = 'p2-pop';
      p.style.left = Math.max(0, anchor.offsetLeft) + 'px';
      p.innerHTML = '<input type="text" maxlength="32" placeholder="' + esc(placeholder) + '" aria-label="' + esc(placeholder) + '">'
        + '<button type="button" class="p2-btn sm primary">' + esc(t('Apply')) + '</button>';
      var inp = p.querySelector('input');
      var go = function () { var v = inp.value.trim(); if (!v) { inp.focus(); return; } closePop(); cb(v); };
      p.querySelector('button').addEventListener('click', go);
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); go(); }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePop(); anchor.focus(); }
      });
      el.appendChild(p);
      inp.focus();
    }
    function closePop() { var p = el.querySelector('.p2-pop'); if (p) p.remove(); }

    function run(action, value) {
      var sel = ids();
      if (!sel.length || busy) return Promise.resolve();
      busy = true; refresh();
      var body = { site_ids: sel, action: action };
      if (value !== undefined) body.value = value;
      return fetch(base + '/sites/bulk', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
        .then(function (r) {
          if (r.status === 401) { location.href = '/login.html'; throw new Error('auth'); }
          return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status); return d; });
        })
        .then(function (d) {
          var msg = t('Updated {n} sites.').replace('{n}', d.updated);
          if (d.skipped && d.skipped.length) {
            var conflict = d.skipped.filter(function (x) { return x.reason === 'domain_conflict'; }).length;
            var limit = d.skipped.length - conflict;
            if (conflict) msg += ' ' + t('{n} not restored: a domain now belongs to another active site.').replace('{n}', conflict);
            if (limit) msg += ' ' + t('{n} already have 20 tags.').replace('{n}', limit);
          }
          toast(msg, !!(d.skipped && d.skipped.length));
          if (typeof onDone === 'function') onDone({ action: action, value: value, ids: sel, result: d });
        })
        .catch(function (e) { if (e.message !== 'auth') toast(t('failed') + ': ' + e.message, true); })
        .then(function () { busy = false; refresh(); });
    }

    // ── CSV ──────────────────────────────────────────────────────────────────
    var COLS = ['site_id', 'name', 'domains', 'status', 'stage', 'starred', 'tags', 'adguard_mode', 'created_at', 'days_live',
      'uv', 'uv_prev', 'delta_pct', 'pv', 'pv_prev', 'organic_uv', 'ai_uv', 'ivt_pct', 'attention'];
    function cell(v) {
      if (v == null) return '';
      if (Array.isArray(v)) v = v.map(function (x) { return typeof x === 'object' ? x.code : x; }).join('; ');
      else if (typeof v === 'boolean') v = v ? 1 : 0;
      v = String(v);
      // spreadsheet formula injection: site names and tags are user text
      if (/^[=+\-@\t\r]/.test(v)) v = "'" + v;
      return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    }
    function loadRows() {
      if (typeof opts.getSites === 'function') return Promise.resolve(opts.getSites() || []);
      var period = opts.period || '7d';
      var get = function (p) { return fetch(base + p, { credentials: 'same-origin' }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }); };
      return get('/portfolio?period=' + encodeURIComponent(period)).then(function (d) { return d.sites || []; })
        .catch(function () {
          return get('/sites').then(function (d) {
            return (d.sites || []).map(function (s) {
              var dom = []; try { dom = JSON.parse(s.allowed_domains); } catch (e) { /* none */ }
              return Object.assign({}, s, { domains: dom });
            });
          });
        });
    }
    function exportCsv() {
      var sel = ids();
      var want = {}; sel.forEach(function (i) { want[i] = 1; });
      return loadRows().then(function (rows) {
        rows = rows.filter(function (r) { return want[r.site_id]; });
        var csv = '﻿' + COLS.join(',') + '\r\n' + rows.map(function (r) {
          return COLS.map(function (c) { return cell(c === 'created_at' && r[c] ? new Date(r[c]).toISOString() : r[c]); }).join(',');
        }).join('\r\n') + '\r\n';
        var a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
        a.download = 'pvuv-sites-' + new Date().toISOString().slice(0, 10) + '.csv';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
        toast(t('Exported {n} rows.').replace('{n}', rows.length));
      }).catch(function (e) { toast(t('failed') + ': ' + e.message, true); });
    }

    function onClick(e) {
      var b = e.target.closest('[data-bulk]');
      if (!b || b.disabled) return;
      var a = b.dataset.bulk, n = ids().length;
      if (a === 'star' || a === 'unstar' || a === 'restore') run(a);
      else if (a === 'archive') { if (confirm(t('Archive {n} sites? They stop collecting data; history is kept and they can be restored.').replace('{n}', n))) run('archive'); }
      else if (a === 'tag') popover(b, t('Tag to add'), function (v) { run('tag', v); });
      else if (a === 'untag') popover(b, t('Tag to remove'), function (v) { run('untag', v); });
      else if (a === 'csv') exportCsv();
    }
    function onSel() { refresh(); }
    function onDocClick(e) { if (!el.contains(e.target)) closePop(); }

    el.addEventListener('click', onClick);
    document.addEventListener('pvuv:selection', onSel);
    document.addEventListener('click', onDocClick);
    document.addEventListener('pvuv:lang', render);
    render();

    return {
      refresh: refresh,
      run: run,
      exportCsv: exportCsv,
      destroy: function () {
        el.removeEventListener('click', onClick);
        document.removeEventListener('pvuv:selection', onSel);
        document.removeEventListener('click', onDocClick);
        document.removeEventListener('pvuv:lang', render);
        el.innerHTML = ''; el.classList.remove('p2-bulk');
      },
    };
  }

  window.pvuvBulk = { mount: mount };
})();
