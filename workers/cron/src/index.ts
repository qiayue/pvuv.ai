/**
 * pvuv.ai cron worker — scheduled jobs (PROJECT_PLAN.md §18.4)
 *
 * Dispatches by cron expression:
 *   "5 * * * *"  → hourly rollup (src/rollup.ts) — M1
 *   "30 3 * * *" → daily population/batch analysis (src/batch.ts) + retention purge
 */

import { runHourlyRollup } from './rollup';
import { runDailyBatch } from './batch';
import { runRetentionPurge } from './retention';
import { runAnomalyDetection } from './anomaly';
import { runEdgePull } from './edge';

export interface Env {
  DB: D1Database;
  BLOCKLIST: KVNamespace;
}

export default {
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    switch (event.cron) {
      case '5 * * * *':
        await runHourlyRollup(env);
        break;
      case '30 3 * * *':
        await runDailyBatch(env);
        await runAnomalyDetection(env); // baseline trend anomalies → anomaly_reports
        await runRetentionPurge(env);   // drop raw data past the retention window
        // optional, opt-in: pull edge request counts from Cloudflare. Last, and
        // guarded, because it is the only job that depends on a third-party API
        // — it must never be able to hold up or break the ones above.
        try { await runEdgePull(env); } catch (err) { console.error('edge pull failed', err); }
        break;
    }
  },
} satisfies ExportedHandler<Env>;
