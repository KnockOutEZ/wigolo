#!/usr/bin/env node
/**
 * Bundle the wigolo dist entry into a single CommonJS file for the standalone
 * binary. Run AFTER `npm run build` (fresh dist). This is a binary-only build
 * step — the npm/source path never runs it and ships the untouched ESM dist.
 *
 * Recipe (validated on macOS arm64, see packaging/verification/binary.md):
 *   - Entry `dist/index.js` carries no top-level await (src/index.ts exports an
 *     async main()), so esbuild can emit CommonJS.
 *   - Native-carrier and asset-carrier packages are externalized so pkg's
 *     require-hook extracts the real .node/.dylib addons and playwright assets
 *     at runtime instead of esbuild inlining unusable JS.
 *   - The Ink TUI stack (ink/yoga/…) is externalized because of dependency-level
 *     top-level await (unbundleable to CJS); every src consumer sits behind a
 *     dynamic import, and the binary is headless-first, so this is safe.
 *   - `import.meta.url` is rewritten to `pathToFileURL(__filename)` via a banner
 *     shim so the ESM-style URL lookups keep working inside the CJS bundle.
 *
 * Output: dist/cli/agents/wigolo.bundle.cjs. The bundle is placed at that depth
 * so the four `import.meta.url`-relative package.json lookups in src resolve
 * against real files once the package.json depth shims (pack.sh) are in place.
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const entry = join(repoRoot, 'dist', 'index.js');
const outfile = join(repoRoot, 'dist', 'cli', 'agents', 'wigolo.bundle.cjs');
const devtoolsStub = join(repoRoot, 'packaging', 'binary', 'react-devtools-core-stub.mjs');

// Native-addon / asset carriers: must resolve on disk at runtime so pkg's
// require-hook can extract the .node/.dylib addons and playwright assets.
const nativeExternals = [
  'better-sqlite3',
  'onnxruntime-node',
  'sqlite-vec',
  '@napi-rs/keyring',
  'wreq-js',
  '@anush008/tokenizers',
  'playwright',
  'playwright-core',
  'sharp',
];

// Ink TUI stack: dependency-level top-level await, unbundleable to CJS. Safe to
// externalize — every src consumer is behind a dynamic import and the binary is
// headless-first (init --wizard / config TUI print a fallback in the binary).
const inkExternals = [
  'ink',
  'ink-big-text',
  'ink-gradient',
  '@inkjs/ui',
  'yoga-layout',
  'react-devtools-core',
];

await build({
  entryPoints: [entry],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  outfile,
  external: [...nativeExternals, ...inkExternals],
  alias: {
    // esbuild hoists the external react-devtools-core import to eager top-level
    // in flat output; alias to a no-op stub so boot does not crash.
    'react-devtools-core': devtoolsStub,
  },
  define: {
    'import.meta.url': '__wigoloImportMetaUrl',
  },
  banner: {
    js: "const __wigoloImportMetaUrl = require('node:url').pathToFileURL(__filename).href;",
  },
  logLevel: 'info',
});

process.stdout.write(`bundled -> ${outfile}\n`);
