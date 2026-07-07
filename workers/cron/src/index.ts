/**
 * pvuv.ai cron worker — scheduled jobs (PROJECT_PLAN.md §18.4)
 *
 * Dispatches by cron expression:
 *   "5 * * * *"  → hourly rollup (src/rollup.ts) — M1
 *   "30 3 * * *" → daily population/batch analysis (src/batch.ts) — M2 stub
 */

import { runHourlyRollup } from './rollup';
import { runDailyBatch } from './batch';

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
        break;
    }
  },
} satisfies ExportedHandler<Env>;
