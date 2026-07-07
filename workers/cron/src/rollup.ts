/**
 * Hourly rollup (PROJECT_PLAN.md §9.1, §18.4) — filled in step 5.
 *
 * Pre-aggregates events_YYYYMM into rollup_page_daily / rollup_source_daily /
 * rollup_site_daily, tracking both total and clean buckets (§9.3).
 */

import type { Env } from './index';

export async function runHourlyRollup(env: Env): Promise<void> {
  // TODO(step 5): incremental rollup of the current day's events.
}
