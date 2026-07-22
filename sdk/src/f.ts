/**
 * pvuv.ai collection SDK — builds to dist/f.js, served from js.pvuv.ai.
 * PROJECT_PLAN.md §4, §18.1 (M1 scope).
 *
 *   <script defer src="https://js.pvuv.ai/f.js"
 *           data-site="Ab3xK9pQ"
 *           data-spa="true"              (optional: SPA route tracking)
 *           data-api="https://..."       (optional: self-hosted ingest, §12)
 *           data-exclude="/admin/*"      (optional: path exclusion globs)
 *           data-sensors="off"           (optional: disable §4.6 signals)
 *           data-adguard="balanced"      (ad protection — wired in M1 step 5)
 *           data-adclient="ca-pub-…"></script>
 *
 * M1 collection: pageview + page_leave (visible dwell + scroll depth) +
 * outbound_click; cheap hard checks + Android-only passive sensor signals
 * (§4.4/§4.6, obfuscated x-fields per shared/flags.ts XF); honeypot link;
 * cookie state machine _pv_id/_pv_sid/_pv_ft (§3); batched reporting
 * (≤10 events or 3s, text/plain — no CORS preflight, §5).
 * Expensive checks (WebGL/canvas, x6/x7) and adguard progressive load are
 * later steps. No raw fingerprints, no sensor streams (§16).
 */

import { COOKIE, VISITOR_TTL_DAYS, SESSION_IDLE_MS } from '../../shared/ids';
import type { IncomingEvent } from '../../shared/events';
import type { XPayload } from '../../shared/flags';

(() => {
  const win = window;
  const doc = document;
  const nav = navigator;
  const loc = location;

  const script = doc.currentScript as HTMLScriptElement | null;
  if (!script) return;
  const siteId = script.getAttribute('data-site');
  if (!siteId) return;

  const api = (script.getAttribute('data-api') || 'https://in.pvuv.ai').replace(/\/+$/, '');
  const spa = script.getAttribute('data-spa') === 'true';
  const sensorsOff = script.getAttribute('data-sensors') === 'off';
  const excludeGlobs = (script.getAttribute('data-exclude') || '')
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean)
    .map(globToRegExp);

  // -------------------------------------------------------------------------
  // small utils
  // -------------------------------------------------------------------------

  function globToRegExp(glob: string): RegExp {
    return new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
  }

  function uuid(): string {
    if (crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  function readCookie(name: string): string | null {
    const m = doc.cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }

  // Widest registrable domain that accepts a cookie (shares _pv_id across
  // subdomains, §3). The browser rejects public suffixes, so walk outward
  // until a test cookie sticks; IPs/localhost fall back to host-only.
  const cookieDomain = (() => {
    const host = loc.hostname;
    if (/^[\d.]+$/.test(host) || host.indexOf('.') < 0) return '';
    const parts = host.split('.');
    for (let i = parts.length - 2; i >= 0; i--) {
      const d = parts.slice(i).join('.');
      doc.cookie = `_pv_t=1; Path=/; Domain=.${d}; Max-Age=60; SameSite=Lax`;
      if (readCookie('_pv_t')) {
        doc.cookie = `_pv_t=; Path=/; Domain=.${d}; Max-Age=0`;
        return d;
      }
    }
    return '';
  })();

  function setCookie(name: string, value: string, maxAgeS: number): void {
    doc.cookie =
      `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAgeS}; SameSite=Lax` +
      (cookieDomain ? `; Domain=.${cookieDomain}` : '') +
      (loc.protocol === 'https:' ? '; Secure' : '');
  }

  // -------------------------------------------------------------------------
  // identity (§3): visitor / session / first-touch
  // -------------------------------------------------------------------------

  const VISITOR_TTL_S = VISITOR_TTL_DAYS * 86400;

  const vid = (() => {
    let v = readCookie(COOKIE.VISITOR);
    if (!v) {
      try { v = localStorage.getItem(COOKIE.VISITOR); } catch { /* blocked */ }
    }
    if (!v) v = uuid();
    setCookie(COOKIE.VISITOR, v, VISITOR_TTL_S);
    try { localStorage.setItem(COOKIE.VISITOR, v); } catch { /* blocked */ }
    return v;
  })();

  function localDay(): string {
    const d = new Date();
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  }

  function utmKey(): string {
    const q = new URLSearchParams(loc.search);
    return ['utm_source', 'utm_medium', 'utm_campaign'].map((k) => q.get(k) || '').join('|');
  }

  // _pv_sid = sid.lastActive.day.utmKey — new session on 30min idle,
  // UTM change, or calendar-day rollover (§3)
  function session(): string {
    const now = Date.now();
    const day = localDay();
    const utm = utmKey();
    const raw = readCookie(COOKIE.SESSION);
    let sid = '';
    let sUtm = '';
    if (raw) {
      const p = raw.split('.');
      const last = parseInt(p[1], 10) || 0;
      sUtm = p.slice(3).join('.');
      const fresh = now - last <= SESSION_IDLE_MS && p[2] === day && !(utm !== '||' && utm !== sUtm);
      if (fresh) sid = p[0];
    }
    if (!sid) {
      sid = uuid();
      sUtm = utm;
    } else if (utm !== '||') {
      sUtm = utm;
    }
    setCookie(COOKIE.SESSION, `${sid}.${now}.${day}.${sUtm}`, 24 * 3600);
    return sid;
  }

  // first-touch snapshot: written once, never overwritten (§3)
  const ft = (() => {
    const raw = readCookie(COOKIE.FIRST_TOUCH);
    if (raw) {
      try { return JSON.parse(raw) as IncomingEvent['ft']; } catch { /* rewrite below */ }
    }
    const q = new URLSearchParams(loc.search);
    const snap = {
      s: q.get('utm_source') || undefined,
      m: q.get('utm_medium') || undefined,
      c: q.get('utm_campaign') || undefined,
      r: doc.referrer || undefined,
    };
    setCookie(COOKIE.FIRST_TOUCH, JSON.stringify(snap), VISITOR_TTL_S);
    return snap;
  })();

  // -------------------------------------------------------------------------
  // authenticity signals (§4.4 cheap tier + §4.6 sensors) → obfuscated x
  // -------------------------------------------------------------------------

  const ua = nav.userAgent;
  const mobileUA = /Mobi|Android|iPhone|iPad|iPod/i.test(ua);
  const chromeUA = /Chrome\//.test(ua);

  const x: XPayload = (() => {
    const out: XPayload = {};
    try {
      if (nav.webdriver) out.x1 = 1;

      const w = win as unknown as Record<string, unknown>;
      let residue = !!(w._phantom || w.__nightmare || w.callPhantom || w.__selenium_unwrapped || w.__webdriver_evaluate);
      if (!residue) {
        for (const k in doc) {
          if (k.indexOf('$cdc_') === 0) { residue = true; break; }
        }
      }
      if (residue) out.x2 = 1;

      let env = 0;
      if (chromeUA && !('chrome' in win)) env = 1;
      if (!nav.languages || nav.languages.length === 0) env = 1;
      if (chromeUA && !mobileUA && nav.plugins && nav.plugins.length === 0) env = 1;
      if (nav.language && nav.languages && nav.languages.length > 0 && nav.languages.indexOf(nav.language) < 0) env = 1;
      if (env) out.x3 = 1;

      let sd = 0;
      if (!mobileUA && screen.width === win.innerWidth && screen.height === win.innerHeight) sd++;
      if (screen.width === 800 && screen.height === 600) sd++;
      if (screen.colorDepth === 0) sd++;
      if (mobileUA && nav.maxTouchPoints === 0) sd++;
      if (nav.hardwareConcurrency === 0) sd++;
      const dm = (nav as unknown as { deviceMemory?: number }).deviceMemory;
      if (dm !== undefined && dm <= 0.25) sd++;
      if (sd > 0) out.x4 = sd;

      out.x5 = Intl.DateTimeFormat().resolvedOptions().timeZone;

      // honeypot: arriving with the marker means a hidden link was followed
      if (new URLSearchParams(loc.search).get('__pvhp') === '1') out.x8 = 1;

      // headless window tell: real desktop browsers always have a non-zero outer
      // window; old / windowless headless Chrome reports 0. Desktop only, and
      // only with a real inner viewport (mobile geometry legitimately varies).
      if (!mobileUA && win.innerWidth > 0 && (win.outerWidth === 0 || win.outerHeight === 0)) out.x11 = 1;

      // OS spoofing: navigator.platform vs the UA OS family. Only high-precision
      // cases (Windows / macOS / iOS UA on a non-matching platform); Linux and
      // Android platform strings overlap too much to judge safely.
      const plat = (nav.platform || '').toLowerCase();
      if (plat) {
        const winUA = /Windows/i.test(ua);
        const iosUA = /iPhone|iPad|iPod/i.test(ua);
        const macUA = /Macintosh|Mac OS X/i.test(ua) && !iosUA;
        if ((winUA && plat.indexOf('win') < 0)
          || (macUA && plat.indexOf('mac') < 0)
          || (iosUA && !/iphone|ipad|ipod|mac/.test(plat))) out.x12 = 1;
      }
    } catch { /* never break the host page */ }
    return out;
  })();

  // Android-only passive sensor signals (§4.6): booleans only, no raw
  // readings, no prompt (silent listen is Android-only behavior; iOS skipped)
  if (!sensorsOff && mobileUA && /Android/i.test(ua)) {
    try {
      const samples: [number, number, number][] = [];
      let got = false;
      const onMotion = (e: DeviceMotionEvent): void => {
        got = true;
        const g = e.accelerationIncludingGravity;
        if (g && samples.length < 10) samples.push([g.x || 0, g.y || 0, g.z || 0]);
      };
      win.addEventListener('devicemotion', onMotion, { passive: true });
      setTimeout(() => {
        win.removeEventListener('devicemotion', onMotion);
        x.x9 = got ? 1 : 0;
        if (samples.length >= 3) {
          const [f] = samples;
          x.x10 = samples.every((s) => s[0] === f[0] && s[1] === f[1] && s[2] === f[2]) ? 1 : 0;
        }
      }, 2000);
    } catch { /* fail silently (§4.6) */ }
  }

  // inject the honeypot link (CSS-hidden; humans never see it, some crawlers
  // follow it and land with ?__pvhp=1 → x8)
  function plantHoneypot(): void {
    try {
      if (new URLSearchParams(loc.search).has('__pvhp') || !doc.body) return;
      const a = doc.createElement('a');
      a.href = loc.pathname + '?__pvhp=1';
      a.rel = 'nofollow';
      a.setAttribute('aria-hidden', 'true');
      a.tabIndex = -1;
      a.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:1px;height:1px;overflow:hidden';
      doc.body.appendChild(a);
    } catch { /* ignore */ }
  }

  // -------------------------------------------------------------------------
  // interaction & dwell tracking (behavioral signals, §4.4)
  // -------------------------------------------------------------------------

  let interacted = false;
  (['mousemove', 'touchstart', 'scroll', 'keydown'] as const).forEach((t) => {
    win.addEventListener(t, () => { interacted = true; }, { once: true, passive: true });
  });

  let visibleSince = doc.visibilityState === 'visible' ? Date.now() : 0;
  let unreportedDwell = 0;
  let maxScroll = 0;

  function noteScroll(): void {
    const h = doc.documentElement;
    const total = Math.max(h.scrollHeight, 1);
    const seen = Math.min(total, (win.scrollY || h.scrollTop || 0) + win.innerHeight);
    maxScroll = Math.max(maxScroll, Math.round((seen / total) * 100));
  }
  win.addEventListener('scroll', noteScroll, { passive: true });

  function accumulateDwell(): void {
    if (visibleSince > 0) {
      unreportedDwell += Date.now() - visibleSince;
      visibleSince = 0;
    }
  }

  // -------------------------------------------------------------------------
  // batched reporting (§5): ≤10 events or 3s; leave-path uses sendBeacon
  // -------------------------------------------------------------------------

  let queue: IncomingEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  function flush(beacon: boolean): void {
    if (timer) { clearTimeout(timer); timer = null; }
    if (queue.length === 0) return;
    const body = JSON.stringify(queue.length === 1 ? queue[0] : queue);
    queue = [];
    // string bodies are text/plain — a "simple request", no preflight (§5)
    if (beacon && nav.sendBeacon) {
      nav.sendBeacon(api + '/in', body);
      return;
    }
    fetch(api + '/in', { method: 'POST', headers: { 'content-type': 'text/plain' }, body, keepalive: true })
      .catch(() => { /* never surface errors to the host page */ });
  }

  function enqueue(ev: IncomingEvent): void {
    queue.push(ev);
    if (queue.length >= 10) flush(false);
    else if (!timer) timer = setTimeout(() => flush(false), 3000);
  }

  // page_leave must report the URL the dwell belongs to — during an SPA
  // transition location.href has already moved on, so events use the URL
  // snapshotted at pageview time.
  // user_id set by pvuv('identify', …); persisted so it rides on later pageviews
  let currentUser = readCookie(COOKIE.USER) || '';

  function baseEvent(name: string): IncomingEvent {
    return {
      s: siteId!,
      e: name,
      u: currentUrl,
      r: pageReferrer || undefined,
      vid,
      uid: currentUser || undefined,
      // reuse the session established at pageview time — deriving it here would
      // mint a NEW session for a page_leave sent after 30min idle or a local
      // midnight rollover, stranding the dwell on a phantom session
      sid: currentSid || session(),
      sw: screen.width,
      sh: screen.height,
      lang: nav.language,
      hi: interacted ? 1 : 0,
      x,
      ft,
      ts: Date.now(),
    };
  }

  // -------------------------------------------------------------------------
  // pageview / page_leave lifecycle (§4.1)
  // -------------------------------------------------------------------------

  let pageReferrer = doc.referrer;
  let currentUrl = loc.href;
  let currentSid = '';
  let tracking = false;

  function excluded(path: string): boolean {
    return excludeGlobs.some((re) => re.test(path));
  }

  function pageview(): void {
    currentUrl = loc.href;
    currentSid = session(); // establish/renew the session once per page
    tracking = !excluded(loc.pathname);
    if (!tracking) return;
    unreportedDwell = 0;
    maxScroll = 0;
    visibleSince = doc.visibilityState === 'visible' ? Date.now() : 0;
    noteScroll();
    enqueue(baseEvent('pageview'));
  }

  // Sent on every hide/leave with the dwell accumulated since the previous
  // page_leave — increments sum to true visible dwell server-side (§4.1).
  function pageLeave(beacon: boolean): void {
    if (!tracking) return;
    accumulateDwell();
    if (unreportedDwell > 0) {
      const ev = baseEvent('page_leave');
      ev.d = unreportedDwell;
      ev.sd = maxScroll;
      unreportedDwell = 0;
      queue.push(ev);
    }
    // always flush: a pageview may still be sitting behind the 3s batch timer
    // (e.g. a tab opened in the background and closed before it fired), and the
    // timer won't survive the unload
    flush(beacon);
  }

  doc.addEventListener('visibilitychange', () => {
    if (doc.visibilityState === 'hidden') pageLeave(true);
    else if (visibleSince === 0) visibleSince = Date.now();
  });
  win.addEventListener('pagehide', () => pageLeave(true));
  // bfcache restore may not emit a visible visibilitychange — re-arm the dwell
  // clock so post-Back reading time is still counted
  win.addEventListener('pageshow', () => {
    if (doc.visibilityState === 'visible' && visibleSince === 0) visibleSince = Date.now();
  });

  // outbound_click (§4.1)
  doc.addEventListener('click', (e) => {
    if (!tracking) return;
    const a = (e.target as Element | null)?.closest?.('a[href]');
    if (!a) return;
    const href = (a as HTMLAnchorElement).href;
    try {
      const u = new URL(href, loc.href);
      if ((u.protocol === 'http:' || u.protocol === 'https:') && u.hostname !== loc.hostname) {
        const ev = baseEvent('outbound_click');
        ev.p = { href: u.href };
        queue.push(ev);
        flush(true); // the page may unload immediately
      }
    } catch { /* ignore */ }
  }, { capture: true, passive: true });

  // SPA route tracking (§4.1): close out the old route, open the new one
  if (spa) {
    const onRoute = (): void => {
      if (loc.href === currentUrl) return;
      pageLeave(false); // closes out the old route (baseEvent uses currentUrl)
      pageReferrer = currentUrl;
      pageview(); // snapshots the new URL into currentUrl
    };
    const wrap = (fn: typeof history.pushState): typeof history.pushState =>
      function (this: History, ...args: Parameters<typeof history.pushState>) {
        fn.apply(this, args);
        onRoute();
      };
    history.pushState = wrap(history.pushState.bind(history));
    history.replaceState = wrap(history.replaceState.bind(history));
    win.addEventListener('popstate', onRoute);
  }

  // -------------------------------------------------------------------------
  // adguard progressive ad loading (§7): decide only WHETHER to inject
  // Google's script, never modify it (§7.4 boundary). Fail-open on any
  // infrastructure problem — a missed block is cheaper than lost revenue.
  // -------------------------------------------------------------------------

  // initial tier from the embed tag; the gate (/v) may override it with the
  // site's current tier (res.m), so console mode switches apply without re-embed.
  let agMode = script.getAttribute('data-adguard') || 'off';
  const adClient = script.getAttribute('data-adclient') || '';
  const VERDICT_TTL_MS = 7 * 86400e3;
  const VERDICT_TIMEOUT_MS = parseInt(script.getAttribute('data-adguard-timeout') || '', 10) || 300;

  function decodeState(cookieVal: string): { v: string; p: number; i: number; ts: number } | null {
    try {
      const payload = cookieVal.split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(atob(payload));
    } catch {
      return null;
    }
  }

  function adguard(): void {
    let injected = false;
    let blocked = false;

    const inject = (): void => {
      if (injected || blocked) return;
      injected = true;
      const s = doc.createElement('script');
      s.async = true;
      s.src = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=' + encodeURIComponent(adClient);
      s.crossOrigin = 'anonymous';
      doc.head.appendChild(s);
    };

    // ① local hard signals: never load, no network needed (§7.2)
    if (x.x1 === 1 || x.x2 === 1 || x.x8 === 1) return;

    // shadow:1 = the site is inside its record-only window (§7.5): the gate says
    // "load ads regardless of verdict or mode". It is the ONLY server signal that
    // overrides the client-side mode logic below — a plain ok:1 must NOT, or
    // strict mode's interaction gate would be silently bypassed for clean traffic.
    type VerdictRes = { v: string; ok: number; shadow?: number; m?: string; state?: string };
    // adopt the server-reported tier (owner may have switched it in the console);
    // 'off' means the gate is disabled → load ads unconditionally.
    const applyMode = (res: VerdictRes): void => {
      if (res.m === 'loose' || res.m === 'balanced' || res.m === 'strict') agMode = res.m;
    };
    const callVerdict = (state: string | null): Promise<VerdictRes> =>
      fetch(api + '/v', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        // sw/sh/lang are part of the fingerprint material, so /v must receive
        // them to compute the same fp_hash the blocklist is keyed on
        body: JSON.stringify({
          s: siteId, vid, sid: currentSid || session(), x,
          sw: screen.width, sh: screen.height, lang: nav.language,
          r: pageReferrer || undefined,
          i: interacted ? 1 : 0, state: state || undefined,
        }),
      }).then((r) => r.json() as Promise<VerdictRes>);

    const saveState = (res: { state?: string }): void => {
      if (res.state) setCookie(COOKIE.VERDICT, res.state, VERDICT_TTL_MS / 1000);
    };

    // ② signed-cookie fast path: returning visitors decide with zero latency
    // (verified server-side on the next /v; local parse is display-only)
    const vc = readCookie(COOKIE.VERDICT);
    const prior = vc ? decodeState(vc) : null;
    if (prior && Date.now() - prior.ts < VERDICT_TTL_MS) {
      if (prior.v === 'bot' || prior.v === 'crawler') {
        // known bot → no ads, EXCEPT during the site's shadow window, where the
        // gate returns shadow:1 = "load anyway" (§7.5). Defer to the gate rather
        // than blocking synchronously, so a shadow-mode site still shows ads to
        // previously-flagged visitors (and no ad loads for a real bot otherwise).
        callVerdict(vc).then((res) => {
          saveState(res);
          if (res.m === 'off' || res.shadow === 1) inject(); else blocked = true;
        }).catch(() => { blocked = true; });
        return;
      }
      if (prior.v === 'clean') {
        // background re-check stacks evidence → blocks from page 2 (§7.3); a
        // shadow-window response also lifts strict mode's interaction gate.
        callVerdict(vc).then((res) => {
          saveState(res);
          if (res.shadow === 1) inject();
        }).catch(() => { /* keep cookie */ });
        if (agMode === 'strict' && !interacted) {
          // strict: even a returning clean visitor must re-demonstrate
          // interaction before ads load
          (['mousemove', 'touchstart', 'scroll', 'keydown'] as const).forEach((t) => {
            win.addEventListener(t, () => inject(), { once: true, passive: true });
          });
        } else {
          inject();
        }
        return;
      }
    }

    // ③ new or suspect visitor: fast verdict and first interaction race (§7.2)
    let verdict = ''; // '' = pending, then clean/suspect/bot/crawler/timeout
    const evaluate = (): void => {
      if (injected || blocked) return;
      if (verdict === 'bot' || verdict === 'crawler') { blocked = true; return; }
      if (verdict === 'timeout') { inject(); return; } // fail-open (§7.4)
      if (agMode === 'loose') { if (verdict === 'clean') inject(); return; }
      if (agMode === 'strict') { if (verdict === 'clean' && interacted) inject(); return; }
      // balanced (default): ① passes OR ② occurs; suspect needs interaction
      if (verdict === 'clean') { inject(); return; }
      if (interacted && (verdict === 'suspect' || verdict === '')) inject();
    };

    (['mousemove', 'touchstart', 'scroll', 'keydown'] as const).forEach((t) => {
      win.addEventListener(t, () => setTimeout(evaluate, 0), { once: true, passive: true });
    });

    const timer = setTimeout(() => {
      if (!verdict) { verdict = 'timeout'; evaluate(); }
    }, VERDICT_TIMEOUT_MS);

    callVerdict(vc)
      .then((res) => {
        clearTimeout(timer);
        saveState(res);
        if (res.m === 'off') { inject(); return; }  // gate disabled by the owner → load ads
        applyMode(res);                             // adopt the current tier (console switch)
        if (res.shadow === 1) { inject(); return; } // record-only window: load regardless of verdict (§7.5)
        if (!verdict || verdict === 'timeout') {
          verdict = res.v;
          evaluate();
        }
      })
      .catch(() => {
        clearTimeout(timer);
        if (!verdict) { verdict = 'timeout'; evaluate(); }
      });
  }

  // -------------------------------------------------------------------------
  // go
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // public API (§4.2): pvuv('event', name, props) / pvuv('identify', id, traits)
  // A pre-load stub may buffer calls on window.pvuv.q — drain them on init.
  // -------------------------------------------------------------------------
  function track(name: string, props?: Record<string, unknown>): void {
    if (typeof name !== 'string' || !name) return;
    // reserved lifecycle names can't be sent as custom goals
    if (name === 'pageview' || name === 'page_leave' || name === 'outbound_click' || name === 'identify') return;
    const ev = baseEvent(name);
    if (props && typeof props === 'object') ev.p = props;
    enqueue(ev);
  }
  function identify(userId: unknown, traits?: Record<string, unknown>): void {
    if (userId == null || userId === '') return;
    currentUser = String(userId).slice(0, 128);
    setCookie(COOKIE.USER, currentUser, VISITOR_TTL_S);
    const ev = baseEvent('identify');
    if (traits && typeof traits === 'object') ev.p = traits;
    enqueue(ev);
  }
  function apiCall(cmd?: string, a?: unknown, b?: unknown): void {
    if (cmd === 'event') track(a as string, b as Record<string, unknown>);
    else if (cmd === 'identify') identify(a, b as Record<string, unknown>);
  }
  const wg = win as unknown as { pvuv?: { q?: unknown[][] } };
  const priorQ = wg.pvuv && wg.pvuv.q;
  wg.pvuv = apiCall as unknown as { q?: unknown[][] };
  if (Array.isArray(priorQ)) for (const args of priorQ) apiCall(...(args as [string, unknown, unknown]));

  function start(): void {
    plantHoneypot();
    pageview();
    if (agMode !== 'off' && adClient) adguard();
  }

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
