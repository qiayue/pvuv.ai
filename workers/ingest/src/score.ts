/**
 * Realtime first-pass scoring (PROJECT_PLAN.md §5, §6.2) — filled in step 3.
 *
 * Writes all four anti-fraud fields: bot_score, verdict, bot_flags,
 * score_stage='realtime'. Weights/thresholds come from config
 * (config.example.toml → generated config), NEVER hardcoded (§21).
 */

export {};
