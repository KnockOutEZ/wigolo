#!/usr/bin/env node
/*
 * Coverage guard for the Studio app's own type-check (known issue P7).
 *
 * P7's aphorism: *a gate that cannot see a file reports the same thing as a gate that sees it and
 * finds nothing.* The app IS type-checked — `npm run lint -w apps/studio` runs `tsc --noEmit` over
 * `apps/studio/tsconfig.json`, and `.github/workflows/ci.yml` invokes it in the `studio-unit` job.
 * But nothing asserted that the arrangement stays true. Each of these one-line edits silently
 * restores P7 with every other gate green:
 *
 *   1. narrow `include` in `apps/studio/tsconfig.json` — the files drop out of the project and tsc
 *      reports success over what remains,
 *   2. set `strict: false` — every file is still in the project and almost nothing is checked,
 *   3. delete the CI step — the check survives as a local command nobody runs, which is the exact
 *      state P7 recorded,
 *   4. redefine the `lint` script itself — CI runs `npm run lint -w apps/studio`, so whatever that
 *      script IS decides whether anything is type-checked; `"lint": "true"` reproduced P7 exactly
 *      while the tsconfig stayed strict and complete and the CI step stayed in place,
 *   5. delete the CI step while leaving the invocation inside a comment — this workflow explains in
 *      prose why the step must not be removed, and that prose contains the literal command, so a
 *      substring check over the raw YAML is satisfied by the explanation alone,
 *   6. add a file the expected-set does not enumerate — `apps/studio/scripts/x.ts`, or any
 *      `.mts`/`.cts` — which is expected by nothing and checked by nothing, i.e. this guard's own
 *      failure class one directory over.
 *
 * A seventh lives outside this file: deleting `check:studio-typecheck` from `gate:studio` makes the
 * guard a local command nobody runs. Nothing here can see that, so it is asserted from the guard's
 * tests instead, following `tests/unit/electron-quarantine.test.ts`.
 *
 * This guard closes 1–6. It is deliberately a path/AST walk with NO module resolution and NO
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
const PACKAGE = join(APP, 'package.json');
const WORKFLOW = join(ROOT, '.github', 'workflows', 'ci.yml');

// The exact command the workflow must invoke. Asserting the string is the point: P7 was recorded as
// "no workflow invokes it", and only a literal check can tell that state from this one. It must
// appear as a `run:` line of its own, not merely somewhere in the file — see `runsInvocation`.
const CI_INVOCATION = 'npm run lint -w apps/studio';
const CI_RUN_LINE = /^[ \t]*run:[ \t]*npm run lint -w apps\/studio[ \t]*$/m;

// What `npm run lint -w apps/studio` has to actually BE. `-p <path>` is allowed on either side of
// `--noEmit` because naming the project explicitly is the same check written differently; anything
// else (`true`, `echo ok`, `eslint .`) is a type-check in name only.
const LINT_SCRIPT = /^tsc(?:\s+(?:-p|--project)\s+\S+)?\s+--noEmit(?:\s+(?:-p|--project)\s+\S+)?$/;

// Build output and installed dependencies are not source the app must type-check, and a guard that
// flagged them would fire on every correctly wired tree — i.e. it would be switched off rather than
// satisfied.
const NOT_SOURCE = new Set(['node_modules', 'out', 'dist']);

// tsconfig paths are always `/`-separated; `path.join` yields `\` on win32. Compare in POSIX form on
// both sides or the guard flags EVERY file as missing on Windows — the exact way
// `check-typecheck-gate.mjs` broke (it named all 58 gated files missing from a config that listed
// them). Casing is folded on the platforms TypeScript itself treats as case-insensitive, so a win32
// drive letter (`C:/` vs `c:/`) cannot reproduce that failure in a second costume.
const posix = (p) => p.split(sep).join('/');
const key = (p) => (ts.sys.useCaseSensitiveFileNames ? posix(p) : posix(p).toLowerCase());
// Every extension TypeScript itself compiles from a directory `include`. Knowing only `.ts`/`.tsx`
// made `.mts`/`.cts` invisible to the guard and therefore checkable by nothing.
const isChecked = (name) => /\.(?:ts|tsx|mts|cts)$/.test(name);

function walk(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!NOT_SOURCE.has(entry.name)) out.push(...walk(p));
    } else if (isChecked(entry.name)) out.push(p);
  }
  return out;
}

// YAML comments start at an unquoted `#` preceded by whitespace or the line start. Stripping them
// before looking for the invocation is what separates "CI runs this" from "a comment mentions it".
const stripComments = (yaml) =>
  yaml
    .split('\n')
    .map((line) => line.replace(/(^|\s)#.*$/, '$1'))
    .join('\n');

const failures = [];

const raw = ts.readConfigFile(CONFIG, ts.sys.readFile);
if (raw.error) {
  failures.push(`apps/studio/tsconfig.json is unreadable: ${ts.flattenDiagnosticMessageText(raw.error.messageText, ' ')}`);
}

const parsed = raw.error
  ? { fileNames: [], options: {} }
  : ts.parseJsonConfigFileContent(raw.config, ts.sys, APP);

const covered = new Set(parsed.fileNames.map(key));

// Every TypeScript file under the app, not an enumerated list of the places we happen to keep them.
// The enumeration was the hole: it named `src`, `tests` and the root `*.config.ts` files, so an
// `apps/studio/scripts/x.ts` was expected by nothing and checked by nothing — P7 reproduced inside
// its own guard. Asking the filesystem what exists cannot go stale as the app grows.
const expected = walk(APP);

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

// What CI invokes is `npm run lint -w apps/studio`, so the app's `lint` script is the thing that
// decides whether anything is type-checked at all. A tsconfig that is strict and complete, invoked
// by a step that runs `true`, is P7 with every other assertion in this file still true.
if (!existsSync(PACKAGE)) {
  failures.push('apps/studio/package.json is missing — nothing defines what `npm run lint -w apps/studio` runs.');
} else {
  let scripts = null;
  try {
    scripts = JSON.parse(readFileSync(PACKAGE, 'utf8')).scripts ?? {};
  } catch (err) {
    failures.push(`apps/studio/package.json is unreadable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (scripts) {
    const lint = typeof scripts.lint === 'string' ? scripts.lint.trim() : '';
    if (!LINT_SCRIPT.test(lint)) {
      failures.push(
        `apps/studio's \`lint\` script is ${lint ? `\`${lint}\`` : 'not defined'} — CI runs \`${CI_INVOCATION}\`, so this script IS the app's type-check. It must run \`tsc --noEmit\` (optionally with \`-p <path>\`).`
      );
    }
  }
}

if (!existsSync(WORKFLOW)) {
  failures.push('.github/workflows/ci.yml is missing — the app type-check cannot be CI-enforced.');
} else if (!CI_RUN_LINE.test(stripComments(readFileSync(WORKFLOW, 'utf8')))) {
  failures.push(`.github/workflows/ci.yml has no \`run: ${CI_INVOCATION}\` step — the app type-check is a local command nobody runs, which is exactly known issue P7. (A comment mentioning the command does not count.)`);
}

if (failures.length) {
  console.error('FAIL: the apps/studio type-check gap (P7) is open again.');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}

console.log(
  `OK: apps/studio type-check covers all ${expected.length} TypeScript files under the app, is strict, runs \`tsc --noEmit\`, and is invoked by a ci.yml step.`
);
