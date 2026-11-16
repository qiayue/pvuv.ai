#!/bin/sh
set -eu
trap 'rm -f .test-api.mjs .test-console.mjs' EXIT
npx esbuild workers/api/src/index.ts --bundle --platform=node --format=esm --outfile=.test-api.mjs --log-level=warning
npx esbuild workers/console/src/index.ts --bundle --platform=node --format=esm --outfile=.test-console.mjs --log-level=warning
node --test tests/*.test.mjs
