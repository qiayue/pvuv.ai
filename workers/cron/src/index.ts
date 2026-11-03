/**
 * pvuv.ai cron worker — scheduled jobs (PROJECT_PLAN.md §18.4)
 *
 * Dispatches by cron expression:
 *   "5 * * * *"  → hourly rollup (src/rollup.ts) — M1
 *   "30 3 * * *" → daily population/batch analysis (src/batch.ts) + retention purge
 *
 * The expressions below MUST match workers/cron/wrangler.toml exactly. They are
 * matched as literal strings, because that is what Cloudflare passes back in
 * event.cron — so a trigger registered under any other spelling reaches no
 * branch at all. That failure used to be completely silent: a production
 * deployment had the daily trigger replaced by an every-30-minutes schedule
 * (edited in the dashboard, which wrangler does not reconcile), and for seven
 * weeks the daily
 * batch simply never ran — no error, no log, no advanced watermark, an empty
 * cluster_flags table, and every population/cluster detector dormant. Hence the
 * default branch: an unrecognised schedule is now loud.
 *
 * (The schedule it had drifted to was an every-30-minutes expression; it is not
 * written out here because the slash-star sequence would close this comment.)
 */

import { runHourlyRollup } from './rollup';
import { runDailyBatch, isDailyBatchStale } from './batch';
import { runRetentionPurge } from './retention';
import { runAnomalyDetection } from './anomaly';
import { runEdgePull } from './edge';

// NOT exported: a Workers entry module treats every named export as a handler
// or binding, so exporting a plain string here makes the whole worker fail to
// start with "Incorrect type for map entry ... not of type 'function or
// ExportedHandler'".
const CRON_HOURLY = '5 * * * *';
const CRON_DAILY = '30 3 * * *';

export interface Env {
  DB: D1Database;
  BLOCKLIST: KVNamespace;
}

export default {
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    switch (event.cron) {
      case CRON_HOURLY:
        await runHourlyRollup(env);
        // Self-heal. The rollup above has already committed, so this can only
        // ever add work, never put the hourly job at risk. It fires only when
        // the daily batch's watermark has not moved for over a day, which in a
        // healthy deployment is never — and which is exactly the state that
        // went unnoticed for seven weeks when the daily trigger was silently
        // rewritten. The batch is watermark-guarded and idempotent, so running
        // it from here is safe even if the daily trigger later comes back.
        if (await isDailyBatchStale(env.DB, Date.now())) {
          console.error('cron: daily batch is more than a day overdue — running it from the hourly job. Check the worker\'s Cron Triggers against workers/cron/wrangler.toml.');
          await runDailyBatch(env);
          await runAnomalyDetection(env);
          await runRetentionPurge(env);
        }
        break;
      case CRON_DAILY:
        await runDailyBatch(env);
        await runAnomalyDetection(env); // baseline trend anomalies → anomaly_reports
        await runRetentionPurge(env);   // drop raw data past the retention window
        // optional, opt-in: pull edge request counts from Cloudflare. Last, and
        // guarded, because it is the only job that depends on a third-party API
        // — it must never be able to hold up or break the ones above.
        try { await runEdgePull(env); } catch (err) { console.error('edge pull failed', err); }
        break;
      default:
        console.error(
          `cron: NOTHING RAN — fired with schedule "${event.cron}", which matches no handler. `
          + `Expected "${CRON_HOURLY}" (hourly rollup) or "${CRON_DAILY}" (daily batch). `
          + 'The worker\'s registered Cron Triggers have drifted from workers/cron/wrangler.toml — '
          + 'delete the triggers in the Cloudflare dashboard and redeploy the cron worker.',
        );
    }
  },
} satisfies ExportedHandler<Env>;
