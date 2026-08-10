#!/usr/bin/env node
/**
 * Prove each cloud-LLM provider still RESOLVES inside a bundled, node_modules-less
 * build — the packaged-binary condition.
 *
 * Why this exists as a script and not only as a vitest case: esbuild silently
 * drops `import(variable)`, so a lazily-imported provider works in the test
 * suite and in `npm run dev` and is simply absent from the shipped binary. The
 * suite cannot see that class of failure. This bundles the adapters the same way
 * packaging/binary/bundle.mjs does, runs the result from a directory with NO
 * node_modules, and classifies each provider's failure:
 *
 *   - a module-resolution error  => the SDK was dropped from the bundle: FAIL
 *   - anything else (auth, network, abort) => the SDK loaded and ran: PASS
 *
 * Run after `npm run build`.
 */
import { build } from 'esbuild';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(repoRoot, 'dist');

if (!existsSync(dist)) {
  process.stderr.write('dist/ missing — run `npm run build` first\n');
  process.exit(2);
}

const PROVIDERS = [
  ['anthropic', 'callAnthropic'],
  ['openai', 'callOpenAI'],
  ['gemini', 'callGemini'],
  ['groq', 'callGroq'],
];

const workDir = mkdtempSync(join(tmpdir(), 'wigolo-llm-bundle-'));
const entry = join(workDir, 'probe.mjs');
const outfile = join(workDir, 'probe.cjs');

const imports = PROVIDERS
  .map(([file, fn]) => `import { ${fn} } from ${JSON.stringify(join(dist, 'integrations', 'cloud', 'llm', `${file}.js`))};`)
  .join('\n');

// No top-level await: the real binary bundle is CJS for the same reason, and
// esbuild refuses top-level await in that format.
writeFileSync(entry, `${imports}

const providers = [${PROVIDERS.map(([name, fn]) => `[${JSON.stringify(name)}, ${fn}]`).join(', ')}];
const opts = { prompt: 'ping', jsonSchema: { type: 'object', properties: {}, additionalProperties: false } };

async function main() {
  const results = [];
  for (const [name, fn] of providers) {
    try {
      await fn(opts, 'obviously-invalid-key-for-resolution-probe');
      results.push({ name, resolved: true, detail: 'call returned' });
    } catch (err) {
      const message = String(err && err.message ? err.message : err);
      const stack = String(err && err.stack ? err.stack : '');
      const moduleMissing =
        /Cannot find module|ERR_MODULE_NOT_FOUND|Dynamic require of|Failed to resolve module/i.test(
          message + stack,
        );
      results.push({ name, resolved: !moduleMissing, detail: message.slice(0, 160) });
    }
  }
  process.stdout.write(JSON.stringify(results));
}

main();
`);

// Same externalization policy as the real binary bundle. The vendor SDKs are
// deliberately NOT external: they must be inlined, which is what we are testing.
await build({
  entryPoints: [entry],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  outfile,
  external: [
    'better-sqlite3', 'onnxruntime-node', 'sqlite-vec', '@napi-rs/keyring',
    'wreq-js', '@anush008/tokenizers', 'playwright', 'playwright-core', 'sharp',
    'ink', 'ink-big-text', 'ink-gradient', '@inkjs/ui', 'yoga-layout', 'react-devtools-core',
  ],
  define: { 'import.meta.url': '__wigoloImportMetaUrl' },
  banner: { js: "const __wigoloImportMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
  logLevel: 'warning',
});

// The bundle must run where nothing can be resolved from disk.
if (existsSync(join(workDir, 'node_modules'))) {
  throw new Error('probe directory unexpectedly has node_modules');
}

let raw;
try {
  raw = execFileSync(process.execPath, [outfile], {
    cwd: workDir,
    encoding: 'utf-8',
    timeout: 120_000,
    env: { ...process.env, NODE_PATH: '' },
  });
} catch (err) {
  process.stderr.write(`probe failed to run: ${err.message}\n${err.stdout ?? ''}${err.stderr ?? ''}\n`);
  rmSync(workDir, { recursive: true, force: true });
  process.exit(1);
}

const results = JSON.parse(raw);
let failed = 0;
for (const r of results) {
  process.stdout.write(`${r.resolved ? 'PASS' : 'FAIL'}  ${r.name.padEnd(10)} ${r.detail}\n`);
  if (!r.resolved) failed += 1;
}
process.stdout.write(
  `\n${results.length - failed}/${results.length} providers resolve in a bundled build with no node_modules ` +
    `(probe dir contained: ${readdirSync(workDir).join(', ')})\n`,
);

rmSync(workDir, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
