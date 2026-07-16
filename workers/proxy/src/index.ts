/**
 * pvuv.ai first-party reverse proxy (OPTIONAL, PROJECT_PLAN.md §12).
 *
 * Third-party analytics domains eventually land on blocker lists. Deploy this
 * tiny Worker on YOUR measured site's own domain (e.g. example.com/_pv/*) so the
 * SDK and event reporting are TRUE first-party requests — largely immune to
 * ad/tracker blockers. Point the embed at it:
 *
 *   <script defer src="https://example.com/_pv/f.js"
 *           data-site="Ab3xK9pQ" data-api="https://example.com/_pv"></script>
 *
 * Accuracy across the hop: a Worker→Worker fetch would otherwise lose the real
 * client IP / ASN / geo. This proxy forwards them as x-pv-* headers plus a
 * shared secret (x-pv-proxy = PROXY_TOKEN); the ingest worker trusts those ONLY
 * when the token matches (workers/ingest resolveClient). Set the SAME
 * PROXY_TOKEN secret on both this worker and ingest.
 */

export interface Env {
  /** upstream ingest worker, e.g. https://in.pvuv.ai */
  UPSTREAM_INGEST: string;
  /** origin that serves /f.js, e.g. https://www.pvuv.ai (the console) */
  UPSTREAM_ASSETS: string;
  /** path prefix this proxy is mounted at, e.g. /_pv */
  PROXY_PREFIX: string;
  /** shared secret with ingest — `wrangler secret put PROXY_TOKEN` */
  PROXY_TOKEN: string;
}

const trimSlash = (s: string) => s.replace(/\/+$/, '');

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const prefix = trimSlash(env.PROXY_PREFIX || '/_pv');
    if (!url.pathname.startsWith(prefix)) return new Response('not found', { status: 404 });
    const rest = url.pathname.slice(prefix.length) || '/';

    // f.js — served first-party, cached hard (it's an immutable build artifact)
    if (request.method === 'GET' && (rest === '/f.js' || rest === '/f.js/')) {
      const upstream = await fetch(`${trimSlash(env.UPSTREAM_ASSETS)}/f.js`, {
        cf: { cacheEverything: true, cacheTtl: 3600 },
      });
      const h = new Headers(upstream.headers);
      h.delete('set-cookie'); // never plant the assets origin's cookies onto the measured domain
      h.set('cache-control', 'public, max-age=3600');
      return new Response(upstream.body, { status: upstream.status, headers: h });
    }

    // /in and /v — forward with the real client context so server-side scoring
    // (IP → /24 + blocklist, ASN → datacenter, timezone/geo) stays accurate.
    if (request.method === 'POST' && (rest === '/in' || rest === '/v')) {
      const cf = (request as Request & { cf?: IncomingRequestCfProperties }).cf;
      const headers = new Headers(request.headers); // keep Origin/Referer/UA/Sec-Fetch/content-type
      // strip any client-supplied x-pv-* so only OUR trusted values reach ingest
      for (const k of [...headers.keys()]) if (k.toLowerCase().startsWith('x-pv-')) headers.delete(k);
      // NEVER forward the measured site's first-party credentials to the ingest
      // host — the SDK's requests carry the page's own cookies (same-origin) that
      // ingest neither needs nor should see (they could surface in its logs).
      headers.delete('cookie');
      headers.delete('authorization');
      headers.set('x-pv-proxy', env.PROXY_TOKEN || '');
      const cip = request.headers.get('cf-connecting-ip');
      if (cip) headers.set('x-pv-ip', cip);
      if (cf?.asn != null) headers.set('x-pv-asn', String(cf.asn));
      if (cf?.asOrganization) headers.set('x-pv-asorg', String(cf.asOrganization));
      if (cf?.timezone) headers.set('x-pv-tz', String(cf.timezone));
      if (cf?.country) headers.set('x-pv-country', String(cf.country));
      if (cf?.region) headers.set('x-pv-region', String(cf.region));
      if (cf?.city) headers.set('x-pv-city', String(cf.city));
      // pass the ingest response straight through (its CORS headers included)
      return fetch(`${trimSlash(env.UPSTREAM_INGEST)}${rest}`, {
        method: 'POST', headers, body: request.body,
      });
    }

    return new Response('not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
