#!/usr/bin/env node
/**
 * Build the Studio web app into `dist/webapp/` (the dir the daemon static route serves, and the only place
 * that ships — package.json `files` is `["dist", ...]`). esbuild bundles `src/main.tsx` and its Preact
 * runtime into ONE self-contained `app.js`: zero external/CDN fetches, no telemetry. Runs AFTER `tsup`
 * (which has `clean: true` and would otherwise wipe this output) — see the `build` script ordering.
 */
import { build } from 'esbuild';
import { mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'dist', 'webapp');
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [join(here, 'src', 'main.tsx')],
  outfile: join(outDir, 'app.js'),
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
  sourcemap: false,
  jsx: 'automatic',
  jsxImportSource: 'preact',
  // No `external` — everything (incl. Preact) is inlined so the served bundle never reaches the network.
  logLevel: 'info',
});

copyFileSync(join(here, 'index.html'), join(outDir, 'index.html'));
console.log(`webapp built → ${outDir}`);
