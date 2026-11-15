#!/bin/sh
set -eu
trap 'rm -f .test-api.mjs .test-console.mjs' EXIT
pnpm exec esbuild workers/api/src/index.ts --bundle --platform=node --format=esm --outfile=.test-api.mjs
pnpm exec esbuild workers/console/src/index.ts --bundle --platform=node --format=esm --outfile=.test-console.mjs
node --test tests/integration-api.test.mjs
