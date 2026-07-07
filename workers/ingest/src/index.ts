/**
 * pvuv.ai ingest worker — in.pvuv.ai
 *
 *   POST /in  — event ingest (PROJECT_PLAN.md §5)
 *   POST /v   — fast ad-load verdict (PROJECT_PLAN.md §8)
 *
 * Step 3 fills in: whitelist validation, server-side enrichment (enrich.ts),
 * realtime first-pass scoring (score.ts), enqueue to INGEST_QUEUE.
 */

export interface Env {
  DB: D1Database;
  BLOCKLIST: KVNamespace;
  SITE_CONFIG: KVNamespace;
  INGEST_QUEUE: Queue;
  /** Secret via `wrangler secret put HMAC_KEY` — never in any file. */
  HMAC_KEY: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/in') {
      // TODO(step 3): validate Origin/Referer against allowed_domains,
      // enrich server-side, realtime first-pass scoring, enqueue.
      return new Response('not implemented', { status: 501 });
    }

    if (request.method === 'POST' && url.pathname === '/v') {
      // TODO(step 5): edge-local fast verdict (<80ms), signed _pv_v cookie.
      return new Response('not implemented', { status: 501 });
    }

    return new Response('not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
