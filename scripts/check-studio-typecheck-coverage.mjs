#!/usr/bin/env node
/*
 * Coverage guard for the Studio app's own type-check (known issue P7).
 *
 * P7's aphorism: *a gate that cannot see a file reports the same thing as a gate that sees it and
 * finds nothing.* The app IS type-checked — `npm run lint -w apps/studio` runs `tsc --noEmit` over
 * `apps/studio/tsconfig.json`, and `.github/workflows/ci.yml` invokes it in the `studio-unit` job.
 * But nothing asserted that the arrangement stays true.
 *
 * The first two shipped versions of this guard described that arrangement and checked its SHAPE: the
 * tsconfig's file set, `options.strict`, the `lint` script string, a regex over the workflow text.
 * Every bypass found since was a costume the shape-checks did not recognise — a decoy project named
 * by `-p`, `strict: true` with its member flags individually off, a `run:` line living inside a YAML
 * block scalar, `if: false` on the real step. Describing a check is not the same as running it, so
 * the core assertion here is now BEHAVIOURAL:
 *
 *   run the exact command CI runs — `npm run lint -w apps/studio`, resolved through the app's own
 *   `lint` script — twice over an isolated mirror of the app: once clean (must exit 0) and once with
 *   a planted type error per strict check (must exit non-zero AND name every planted error).
 *
 * That is un-foolable by construction: whatever the arrangement IS, a type error either gets
 * reported or it does not. A decoy project reports nothing. A disabled member flag drops exactly its
 * own probe. `"lint": "true"` reports nothing. The shape-checks survive only as fast pre-filters
 * that produce a better message for the blunt cases, and each one owns a fixture that identifies it
 * by message.
 *
 * Two things stay outside the behavioural check because nothing local can execute them:
 *
 *   - **Is the command wired into CI at all?** Asserted by parsing ci.yml with a real YAML parser and
 *     requiring an enabled `run:` step in an enabled job. The previous regex over comment-stripped
 *     but unparsed text was satisfied by a `run:`-looking line inside an unrelated block scalar, and
 *     was blind to `if: false` on the step it was checking — while simultaneously rejecting the
 *     inline `- run: …` form that four other steps in the same file use.
 *   - **Does anything invoke this guard?** Deleting `check:studio-typecheck` from `gate:studio`
 *     makes it a local command nobody runs. Nothing here can see that, so it is asserted from the
 *     guard's tests instead, following `tests/unit/electron-quarantine.test.ts`.
 *
 * The file-coverage walk stays too, and is not redundant with the behavioural check: a file outside
 * the project is checked by nothing, and a planted error inside the project cannot notice its
 * absence.
 *
 * Pass a root directory as argv[2] to point it at a fixture tree (used by its own tests).
 */
import ts from 'typescript';
import { parse as parseYaml } from 'yaml';
import { spawnSync } from 'node:child_process';
import {
  readFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  copyFileSync,
  rmSync,
} from 'node:fs';
import { join, relative, resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// The repo this script lives in, which is NOT necessarily the tree under test: argv[2] points the
// checks at a fixture tree, but the behavioural run always needs a real `node_modules` to resolve
// `tsc` and the app's own dependencies from, and that only ever exists here.
const OWN_REPO = fileURLToPath(new URL('..', import.meta.url));
const ROOT = process.argv[2] ? resolve(process.argv[2]) : OWN_REPO;
const APP = join(ROOT, 'apps', 'studio');
const CONFIG = join(APP, 'tsconfig.json');
const PACKAGE = join(APP, 'package.json');
const WORKFLOW = join(ROOT, '.github', 'workflows', 'ci.yml');

// The exact command the workflow must invoke, and the exact command the behavioural check runs.
const CI_INVOCATION = 'npm run lint -w apps/studio';

// What `npm run lint -w apps/studio` has to actually BE. Kept as a fast pre-filter with a precise
// message; the behavioural check is what makes it un-foolable. `-p <path>` stays allowed — naming
// the project explicitly is the same check written differently, and if the named project is a decoy
// the planted errors go unreported, so the behavioural check decides rather than this regex.
const LINT_SCRIPT = /^tsc(?:\s+(?:-p|--project)\s+\S+)?\s+--noEmit(?:\s+(?:-p|--project)\s+\S+)?$/;

// Build output and installed dependencies are not source the app must type-check, and a guard that
// flagged them would fire on every correctly wired tree — i.e. it would be switched off rather than
// satisfied. `release` is electron-builder's output directory (`directories.output` in
// `electron-builder.config.ts`): on any machine that has packaged the app it holds an unpacked copy
// of the tree, so walking into it reported the app's own files back as uncovered.
const NOT_SOURCE = new Set(['node_modules', 'out', 'dist', 'release']);

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

/*
 * One probe per strict check, each an error that appears ONLY while its flag is in effect. The flag
 * list is TypeScript's own (`strictFlag` on the option declarations) rather than a hand-copied one,
 * so a strict check added by a future compiler release arrives here as an unprobed flag rather than
 * as a silent hole. Every probe was validated both ways: with the whole family on, all of them
 * report; with one flag off, exactly that probe's diagnostic disappears.
 *
 * `expect` is the diagnostic code, not merely "some error in this file". A probe that errored for an
 * unrelated reason (a `lib` too old for `Array.prototype.values`, say) would otherwise read as
 * "this check is in effect" when it is not.
 */
const PROBES = [
  {
    flag: null,
    name: 'baseline',
    expect: 2322,
    source: "export const probeBaseline: number = 'not a number';\n",
  },
  {
    flag: 'noImplicitAny',
    name: 'noImplicitAny',
    expect: 7006,
    source: 'export function probeNoImplicitAny(a) {\n  return a;\n}\n',
  },
  {
    flag: 'strictNullChecks',
    name: 'strictNullChecks',
    expect: 2322,
    source: 'export const probeStrictNullChecks: string = null;\n',
  },
  {
    flag: 'strictFunctionTypes',
    name: 'strictFunctionTypes',
    expect: 2322,
    source:
      'const takesString = (value: string): void => {\n  void value;\n};\nexport const probeStrictFunctionTypes: (value: unknown) => void = takesString;\n',
  },
  {
    flag: 'strictBindCallApply',
    name: 'strictBindCallApply',
    expect: 2345,
    source:
      "function probeTarget(a: number): number {\n  return a;\n}\nexport const probeStrictBindCallApply = probeTarget.call(undefined, 'not a number');\n",
  },
  {
    flag: 'strictPropertyInitialization',
    name: 'strictPropertyInitialization',
    expect: 2564,
    source: 'export class ProbeStrictPropertyInitialization {\n  declared: number;\n}\n',
  },
  {
    flag: 'strictBuiltinIteratorReturn',
    name: 'strictBuiltinIteratorReturn',
    expect: 2322,
    source: 'export const probeStrictBuiltinIteratorReturn: number = [1, 2].values().next().value;\n',
  },
  {
    flag: 'noImplicitThis',
    name: 'noImplicitThis',
    expect: 2683,
    source: 'export function probeNoImplicitThis(): unknown {\n  return this;\n}\n',
  },
  {
    flag: 'useUnknownInCatchVariables',
    name: 'useUnknownInCatchVariables',
    expect: 18046,
    source:
      "export function probeUseUnknownInCatchVariables(): string {\n  try {\n    return '';\n  } catch (err) {\n    return err.message;\n  }\n}\n",
  },
];

const STRICT_FLAGS = ts.optionDeclarations.filter((o) => o.strictFlag).map((o) => o.name);
const UNPROBED_FLAGS = STRICT_FLAGS.filter((f) => !PROBES.some((p) => p.flag === f));

// A GitHub Actions `if:` cannot be evaluated locally, so the guard treats every condition it does
// not recognise as always-true as capable of disabling the step. That direction is deliberate: it can
// only produce a loud false FAIL (fixable by hoisting the condition elsewhere), never a silent pass
// on a step that never executes — which is what `if: false` bought before this existed.
const ALWAYS_TRUE = new Set(['true', 'always()', 'success()']);
const enabled = (condition) => {
  if (condition === undefined || condition === null) return true;
  const normalised = String(condition)
    .trim()
    .replace(/^\$\{\{(.*)\}\}$/s, '$1')
    .trim()
    .toLowerCase();
  return ALWAYS_TRUE.has(normalised);
};

const failures = [];

// ---------------------------------------------------------------------------------------------
// 1. Does the project contain every TypeScript file the app has on disk?
// ---------------------------------------------------------------------------------------------

const raw = ts.readConfigFile(CONFIG, ts.sys.readFile);
if (raw.error) {
  failures.push(`apps/studio/tsconfig.json is unreadable: ${ts.flattenDiagnosticMessageText(raw.error.messageText, ' ')}`);
}

const parsed = raw.error ? { fileNames: [], options: {} } : ts.parseJsonConfigFileContent(raw.config, ts.sys, APP);

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

// ---------------------------------------------------------------------------------------------
// 2. Fast pre-filters. Each produces a sharper message than the behavioural run would for the
//    blunt case it names, and each is identified by that message in the guard's tests.
// ---------------------------------------------------------------------------------------------

if (!raw.error && parsed.options.strict !== true) {
  failures.push('apps/studio/tsconfig.json must set `strict: true` — a non-strict project sees every file and finds almost nothing.');
}

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

// ---------------------------------------------------------------------------------------------
// 3. Is the command wired into CI, in a step that can actually execute?
// ---------------------------------------------------------------------------------------------

function checkWorkflow() {
  if (!existsSync(WORKFLOW)) {
    return '.github/workflows/ci.yml is missing — the app type-check cannot be CI-enforced.';
  }
  let doc;
  try {
    doc = parseYaml(readFileSync(WORKFLOW, 'utf8'));
  } catch (err) {
    return `.github/workflows/ci.yml is not parseable YAML: ${err instanceof Error ? err.message : String(err)}`;
  }
  const jobs = doc && typeof doc === 'object' ? doc.jobs : null;
  if (!jobs || typeof jobs !== 'object') {
    return '.github/workflows/ci.yml declares no `jobs:` — nothing in it can invoke the app type-check.';
  }
  const disabled = [];
  for (const [jobName, job] of Object.entries(jobs)) {
    if (!job || typeof job !== 'object' || !Array.isArray(job.steps)) continue;
    for (const step of job.steps) {
      if (!step || typeof step !== 'object' || typeof step.run !== 'string') continue;
      if (!step.run.includes(CI_INVOCATION)) continue;
      if (!enabled(job.if)) {
        disabled.push(`job \`${jobName}\` is conditional on \`if: ${String(job.if).trim()}\``);
        continue;
      }
      if (!enabled(step.if)) {
        disabled.push(`the step in job \`${jobName}\` is conditional on \`if: ${String(step.if).trim()}\``);
        continue;
      }
      return null;
    }
  }
  if (disabled.length) {
    return (
      `.github/workflows/ci.yml invokes \`${CI_INVOCATION}\` only from a step that cannot be relied on to run:\n` +
      disabled.map((d) => `    - ${d}`).join('\n') +
      '\n    A step that never executes enforces nothing, which is exactly known issue P7. (Conditions other than `true`/`always()`/`success()` cannot be evaluated here and are treated as disabling.)'
    );
  }
  return `.github/workflows/ci.yml has no enabled \`run:\` step invoking \`${CI_INVOCATION}\` — the app type-check is a local command nobody runs, which is exactly known issue P7. (A comment, or the text appearing anywhere other than a step's \`run:\`, does not count.)`;
}

const workflowFailure = checkWorkflow();
if (workflowFailure) failures.push(workflowFailure);

// ---------------------------------------------------------------------------------------------
// 4. The behavioural assertion. Everything above describes the check; this one runs it.
// ---------------------------------------------------------------------------------------------

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Mirror the app into `dst`, skipping the directories that are not source. */
function mirror(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (!NOT_SOURCE.has(entry.name)) mirror(join(src, entry.name), join(dst, entry.name));
    } else if (entry.isFile()) {
      copyFileSync(join(src, entry.name), join(dst, entry.name));
    }
  }
}

function runAppLint(cwd) {
  // `shell: true` with a constant command so the same string works on win32, where `npm` is a shim
  // rather than an executable. Judged by `status`, never by a pipeline's exit code.
  const r = spawnSync(CI_INVOCATION, { cwd, shell: true, encoding: 'utf8', timeout: 600_000 });
  return {
    // `spawnSync` reports a failure to launch on `error`; a `throw` never happens, so a missing npm
    // would otherwise read as `status: null` and be indistinguishable from a crash.
    error: r.error ? (r.error instanceof Error ? r.error.message : String(r.error)) : null,
    status: r.status,
    signal: r.signal,
    output: `${r.stdout ?? ''}${r.stderr ?? ''}`,
  };
}

/**
 * Write every probe into a directory the project actually compiles, verified with TypeScript's own
 * config parser rather than assumed from `include`. Guessing `src` would make the check silently
 * vacuous the day the app reorganises — a planted error outside the project is never reported, which
 * is indistinguishable from a type-check that does not run.
 */
function plantProbes(appDir) {
  const configPath = join(appDir, 'tsconfig.json');
  const conf = ts.readConfigFile(configPath, ts.sys.readFile);
  if (conf.error) return { error: 'the mirrored tsconfig.json could not be re-read' };

  const fileNames = ts.parseJsonConfigFileContent(conf.config, ts.sys, appDir).fileNames;
  const byDir = new Map();
  for (const f of fileNames) {
    const d = dirname(f);
    byDir.set(d, (byDir.get(d) ?? 0) + 1);
  }
  const dirs = [...byDir.entries()].sort((a, b) => b[1] - a[1]).map(([d]) => d);

  // `.config.ts` is the second shape because the app's root files are matched by a `*.config.ts`
  // glob rather than a directory include, so a plain `.ts` sibling there is outside the project.
  for (const dir of dirs) {
    for (const suffix of ['.ts', '.config.ts']) {
      const placed = PROBES.map((p) => ({ probe: p, file: join(dir, `__p7_probe_${p.name}__${suffix}`) }));
      for (const { probe, file } of placed) writeFileSync(file, probe.source);
      const after = ts.parseJsonConfigFileContent(conf.config, ts.sys, appDir).fileNames.map(key);
      if (placed.every(({ file }) => after.includes(key(file)))) return { placed };
      for (const { file } of placed) rmSync(file, { force: true });
    }
  }
  return {
    error:
      'no directory in the project accepts a planted file — the guard cannot prove the type-check runs. Widen `include` in apps/studio/tsconfig.json.',
  };
}

function checkBehaviour() {
  // The mirror lives under the app's own `node_modules` so that `tsc` and every workspace-local
  // dependency (react-dom, electron-vite …) resolve by ordinary upward lookup. A temp directory
  // elsewhere would need symlinks, which behave differently on win32; this needs none. `node_modules`
  // is gitignored, so a mirror can never dirty `git status`.
  const cacheRoot = join(OWN_REPO, 'apps', 'studio', 'node_modules', '.cache');
  if (!existsSync(join(OWN_REPO, 'apps', 'studio', 'node_modules'))) {
    return [
      'apps/studio/node_modules is missing — the app type-check cannot be run, so this guard cannot verify it. Run `npm ci`.',
    ];
  }
  mkdirSync(cacheRoot, { recursive: true });
  const work = mkdtempSync(join(cacheRoot, 'p7-behaviour-'));
  try {
    const workApp = join(work, 'apps', 'studio');
    mkdirSync(join(work, 'apps'), { recursive: true });
    mirror(APP, workApp);
    // The root `package.json` is what resolves the `-w apps/studio` selector, so CI's command is
    // reproduced with CI's own workspace declaration rather than a synthetic one.
    copyFileSync(join(ROOT, 'package.json'), join(work, 'package.json'));

    const clean = runAppLint(work);
    if (clean.error) return [`\`${CI_INVOCATION}\` could not be launched: ${clean.error}`];
    if (clean.status !== 0) {
      return [
        `\`${CI_INVOCATION}\` does not currently pass, so this guard cannot tell a working type-check from a broken one. Fix the app's type errors first:\n` +
          clean.output
            .split('\n')
            .filter((l) => l.trim())
            .slice(0, 15)
            .map((l) => `    ${l}`)
            .join('\n'),
      ];
    }

    const planted = plantProbes(workApp);
    if (planted.error) return [planted.error];

    const dirty = runAppLint(work);
    if (dirty.error) return [`\`${CI_INVOCATION}\` could not be launched: ${dirty.error}`];
    if (dirty.status === 0) {
      return [
        `\`${CI_INVOCATION}\` exited 0 over a tree carrying ${PROBES.length} planted type errors — whatever that command is, it is not type-checking this project's files. This is known issue P7 with every other assertion in this guard still true.`,
      ];
    }

    const missed = planted.placed.filter(
      ({ probe, file }) => !new RegExp(`${escapeRegExp(posix(relative(workApp, file)))}\\(\\d+,\\d+\\): error TS${probe.expect}\\b`).test(posix(dirty.output))
    );
    if (missed.length) {
      const flags = missed.filter((m) => m.probe.flag).map((m) => m.probe.flag);
      const baseline = missed.some((m) => !m.probe.flag);
      return [
        `\`${CI_INVOCATION}\` ran but did not report ${missed.length} of ${PROBES.length} planted type errors, so those checks are not in effect:\n` +
          missed.map(({ probe }) => `    - ${probe.name} (expected TS${probe.expect})`).join('\n') +
          (baseline
            ? '\n    The baseline probe is a plain assignment mismatch: missing it means the command does not check these files at all (a decoy `-p <project>`, or a `lint` script that only looks like a type-check).'
            : `\n    Set \`strict: true\` without switching its members off — ${flags.join(', ')} ${flags.length === 1 ? 'is' : 'are'} disabled in apps/studio/tsconfig.json.`),
      ];
    }
    return [];
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// Skipped only when a pre-filter already failed: the behavioural run costs two type-checks, and its
// message cannot be clearer than the specific one already queued.
if (!failures.length) failures.push(...checkBehaviour());

if (failures.length) {
  console.error('FAIL: the apps/studio type-check gap (P7) is open again.');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}

console.log(
  `OK: apps/studio type-check covers all ${expected.length} TypeScript files under the app, reports every one of ${PROBES.length} planted type errors when \`${CI_INVOCATION}\` is run, and is invoked by an enabled ci.yml step.` +
    (UNPROBED_FLAGS.length ? ` (Strict flags without a probe, asserted only by \`strict: true\`: ${UNPROBED_FLAGS.join(', ')}.)` : '')
);
