/**
 * pvuv.ai console worker — pvuv.ai apex (PROJECT_PLAN.md §11, §18.6)
 *
 * Step 5 fills in: owner login, site registration (issue site_id + embed
 * snippet), traffic dashboard, traffic-quality overview + drill-down.
 * Frontend is plain single-file HTML in public/ (no framework, and never
 * a <meta name="keywords"> tag — §19 conventions).
 */

export interface Env {
  DB: D1Database;
  SITE_CONFIG: KVNamespace;
  ASSETS: Fetcher;
  /** Secret via `wrangler secret put HMAC_KEY` — never in any file. */
  HMAC_KEY: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // TODO(step 5): session auth + JSON endpoints for the console pages;
    // static pages fall through to ASSETS.
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
