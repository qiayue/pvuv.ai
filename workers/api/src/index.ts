/**
 * pvuv.ai api worker — api.pvuv.ai (PROJECT_PLAN.md §10, §18.5)
 *
 * Step 5 fills in M1 endpoints:
 *   GET /v1/sites/:id/overview?period=30d
 *   GET /v1/sites/:id/timeseries?metric=pv&interval=day
 *   GET /v1/sites/:id/breakdown?dim=page|source|utm_campaign|country|device
 *   GET /v1/sites/:id/quality?period=30d
 *   GET /v1/sites/:id/traffic?verdict=bot&min_score=70
 *   GET /v1/sites/:id/visitors/:vid/profile
 */

export interface Env {
  DB: D1Database;
  /** Secrets via `wrangler secret put` — never in any file. */
  HMAC_KEY: string;
  API_TOKEN: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // TODO(step 5): route /v1/*, auth (owner session or server-side token),
    // queries against rollup_* tables (aggregate layer first, raw for drill-down).
    return new Response('not implemented', { status: 501 });
  },
} satisfies ExportedHandler<Env>;
