/**
 * pvuv.ai consumer worker — INGEST_QUEUE consumer (PROJECT_PLAN.md §18.3)
 *
 * Step 3 fills in: batch-write events into events_YYYYMM, incrementally
 * update sessions / identities / visitor_profiles.
 */

export interface Env {
  DB: D1Database;
}

export default {
  async queue(batch: MessageBatch<unknown>, env: Env, ctx: ExecutionContext): Promise<void> {
    // TODO(step 3): batch-insert into events_YYYYMM; upsert sessions,
    // identities, visitor_profiles (Welford incremental stats in M2).
    batch.retryAll();
  },
} satisfies ExportedHandler<Env>;
