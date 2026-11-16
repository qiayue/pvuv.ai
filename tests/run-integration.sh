#!/bin/sh
set -eu
trap 'rm -f .test-api.mjs .test-console.mjs .test-cron.mjs .test-labels.mjs .test-portfolio.mjs' EXIT
npx --no-install esbuild workers/api/src/index.ts --bundle --platform=node --format=esm --outfile=.test-api.mjs --log-level=warning
npx --no-install esbuild workers/console/src/index.ts --bundle --platform=node --format=esm --outfile=.test-console.mjs --log-level=warning
npx --no-install esbuild tests/cron-entry.ts --bundle --platform=node --format=esm --outfile=.test-cron.mjs --log-level=warning
npx --no-install esbuild shared/labels.ts --bundle --platform=node --format=esm --outfile=.test-labels.mjs --log-level=warning
npx --no-install esbuild workers/api/src/portfolio.ts --bundle --platform=node --format=esm --outfile=.test-portfolio.mjs --log-level=warning
node --test tests/*.test.mjs
