#!/usr/bin/env node
/*
 * Coverage guard for the Studio app's own type-check (known issue P7).
 *
 * P7's aphorism: *a gate that cannot see a file reports the same thing as a gate that sees it and
 * finds nothing.* The app IS type-checked — `npm run lint -w apps/studio` runs `tsc --noEmit` over
 * `apps/studio/tsconfig.json`, and `.github/workflows/ci.yml` invokes it in the `studio-unit` job.
 * But nothing asserted that the arrangement stays true. Three independent one-line edits silently
 * restore P7 with every gate green:
 *
 *   1. narrow `include` in `apps/studio/tsconfig.json` — the files drop out of the project and tsc
 *      reports success over what remains,
 *   2. set `strict: false` — every file is still in the project and almost nothing is checked,
 *   3. delete the CI step — the check survives as a local command nobody runs, which is the exact
 *      state P7 recorded.
 *
 * This guard closes all three. It is deliberately a path/AST walk with NO module resolution and NO
 * build step, so it can ride `gate:studio` (whose CI job builds nothing on purpose — a build there
 * would hide a type error behind a build failure).
 *
 * The project's file set is read with TypeScript's own config parser rather than a hand-rolled glob
 * matcher, so what this guard calls "covered" is precisely what `tsc -p` would compile.
 *
 * Pass a root directory as argv[2] to point it at a fixture tree (used by its own tests).
 */
import ts from 'typescript';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL('..', import.meta.url));
const APP = join(ROOT, 'apps', 'studio');
const CONFIG = join(APP, 'tsconfig.json');
const WORKFLOW = join(ROOT, '.github', 'workflows', 'ci.yml');

// The exact command the workflow must invoke. Asserting the string is the point: P7 was recorded as
// "no workflow invokes it", and only a literal check can tell that state from this one.
const CI_INVOCATION = 'npm run lint -w apps/studio';

// tsconfig paths are always `/`-separated; `path.join` yields `\` on win32. Compare in POSIX form on
// both sides or the guard flags EVERY file as missing on Windows — the exact way
// `check-typecheck-gate.mjs` broke (it named all 58 gated files missing from a config that listed
// them). Casing is folded on the platforms TypeScript itself treats as case-insensitive, so a win32
// drive letter (`C:/` vs `c:/`) cannot reproduce that failure in a second costume.
const posix = (p) => p.split(sep).join('/');
const key = (p) => (ts.sys.useCaseSensitiveFileNames ? posix(p) : posix(p).toLowerCase());
const isChecked = (name) => name.endsWith('.ts') || name.endsWith('.tsx');

function walk(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (isChecked(entry.name)) out.push(p);
  }
  return out;
}

const failures = [];

const raw = ts.readConfigFile(CONFIG, ts.sys.readFile);
if (raw.error) {
  failures.push(`apps/studio/tsconfig.json is unreadable: ${ts.flattenDiagnosticMessageText(raw.error.messageText, ' ')}`);
}

const parsed = raw.error
  ? { fileNames: [], options: {} }
  : ts.parseJsonConfigFileContent(raw.config, ts.sys, APP);

const covered = new Set(parsed.fileNames.map(key));

// Everything the app actually ships plus its own build/test wiring. The root `*.config.ts` files
// (electron.vite, electron-builder, vitest, vitest.e2e) are here because they were the residual
// hole: `include: ["src", "tests"]` left the packaging and test-runner config unchecked, and
// `electron-builder.config.ts` is what decides what ends up in a shipped app.
const expected = [
  ...walk(join(APP, 'src')),
  ...walk(join(APP, 'tests')),
  ...(existsSync(APP)
    ? readdirSync(APP, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith('.config.ts'))
        .map((e) => join(APP, e.name))
    : []),
];

const uncovered = expected.filter((p) => !covered.has(key(p)));
if (uncovered.length) {
  failures.push(
    `apps/studio/tsconfig.json does not cover ${uncovered.length} file(s) that exist on disk — they are type-checked by nothing:\n` +
      uncovered.map((p) => `    - ${posix(relative(ROOT, p))}`).join('\n')
  );
}

// A project that lists every file and checks nothing reports the same success as one that checks it.
if (!raw.error && parsed.options.strict !== true) {
  failures.push('apps/studio/tsconfig.json must set `strict: true` — a non-strict project sees every file and finds almost nothing.');
}

if (!existsSync(WORKFLOW)) {
  failures.push('.github/workflows/ci.yml is missing — the app type-check cannot be CI-enforced.');
} else if (!readFileSync(WORKFLOW, 'utf8').includes(CI_INVOCATION)) {
  failures.push(`.github/workflows/ci.yml does not invoke \`${CI_INVOCATION}\` — the app type-check is a local command nobody runs, which is exactly known issue P7.`);
}

if (failures.length) {
  console.error('FAIL: the apps/studio type-check gap (P7) is open again.');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}

console.log(
  `OK: apps/studio type-check covers all ${expected.length} src/test/config files, is strict, and is invoked by ci.yml.`
);
