#!/bin/sh
set -eu
trap 'rm -f .test-api.mjs .test-console.mjs' EXIT
npx --no-install esbuild workers/api/src/index.ts --bundle --platform=node --format=esm --outfile=.test-api.mjs
npx --no-install esbuild workers/console/src/index.ts --bundle --platform=node --format=esm --outfile=.test-console.mjs
node --test tests/*.test.mjs
