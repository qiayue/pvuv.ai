/**
 * Builds sdk/src/f.ts → sdk/dist/f.js (deployed to js.pvuv.ai).
 *
 * dist/ is gitignored build output; run `npm run build:sdk` before deploying.
 * Target: small, fast, ES2019-compatible IIFE — no dependencies.
 */

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [path.join(here, 'src/f.ts')],
  outfile: path.join(here, 'dist/f.js'),
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2019',
  legalComments: 'none',
});

console.log('built sdk/dist/f.js');
