// Test-only bundle entry (tests/run-integration.sh → .test-cron.mjs): the cron
// jobs and shared helpers the integration tests drive directly.
export { runHourlyRollup, rollupSiteDay, existingEventTables } from '../workers/cron/src/rollup';
export { rollupCrawlerDay, recordEdgeCrawlerDay, backfillCrawlersOnce, foldBeacon, CRAWLER_BACKFILL_FLAG } from '../workers/cron/src/crawlers';
export { classifyCrawler, kindFromCategory, matchEngine, engineInfo } from '../shared/crawlers';
export { eventsTableDDL, monthSuffix } from '../shared/events';
export { betaBinomialPBest, decide, seedOf } from '../workers/api/src/reports';
export { aiAssistantOf, classifyChannel } from '../shared/channel';
// external integrations (portfolio:p3)
export { runExternalSync, checkAdsTxt } from '../shared/external/sync';
export { encryptSecret, decryptSecret } from '../shared/external/crypto';
export { normalizeHost, matchSite, buildDomainIndex, gscPreference } from '../shared/external/domains';
export { saveCredential, loadCredential, setMapping } from '../shared/external/store';
export { googleAuthUrl } from '../shared/external/google';
export { loadExternal, siteExternal, previousWindow } from '../workers/api/src/external';
export { integrationsApi, signExtState, verifyExtState, EXT_STATE_COOKIE } from '../workers/console/src/integrations';
