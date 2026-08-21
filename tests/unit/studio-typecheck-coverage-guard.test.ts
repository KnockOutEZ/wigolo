/**
 * Negative + positive tests for `scripts/check-studio-typecheck-coverage.mjs` (known issue P7).
 *
 * The guard exists because a one-line edit silently restores P7 — the gap where a file is checked by
 * nothing and every gate stays green. Its first two shipped forms checked the SHAPE of the
 * arrangement: the tsconfig's file set, `options.strict`, the `lint` script string, a regex over the
 * workflow text. Four bypasses survived that, all reproduced at SD0 phase-exit, and every one of them
 * is a costume a shape-check does not recognise:
 *
 *   1. `"lint": "tsc --noEmit -p tsconfig.decoy.json"` — the script regex allowed `-p <path>` while
 *      every other check only ever read `apps/studio/tsconfig.json`, so a decoy project that compiles
 *      one trivial file type-checked nothing and the guard printed OK,
 *   2. `strict: true` with `noImplicitAny`, `strictNullChecks`, … individually `false` — keeps
 *      `options.strict === true`, disables almost all checking,
 *   3. a `run:`-looking line inside an unrelated YAML block scalar — the CI assertion was a
 *      line-anchored regex over unparsed text, satisfied with no real step present at all,
 *   4. `if: false` on the real step — the regex asserts the line exists, never that it can execute.
 *
 * So the guard's core assertion is no longer a description of the check but the check itself: it runs
 * `npm run lint -w apps/studio` over a mirror of the app, once clean and once with a planted type
 * error per strict flag, and requires the clean run to exit 0 and the planted run to report every
 * probe. None of the four bypasses reports a planted error, which is why one assertion closes all
 * four — and why the cases below assert on WHICH message fires, not merely that the guard failed:
 * the shape-checks survive as fast pre-filters, and a test that only counted the exit code could not
 * tell a live pre-filter from a dead one.
 *
 * A third pass then found that proving the invocation SITS in an enabled step is not the same as
 * proving the shell RUNS it and lets its failure fail the job. Six more costumes, all reproduced on
 * the real tree or on fixture trees: the invocation commented out inside its own step (the live SD0
 * repro), present only as a quoted string, suffixed with `|| true`, piped so `$?` belongs to `tee`,
 * disarmed by `set +e`, and marked `continue-on-error` on the step or its job. A seventh sits above
 * all of them — a workflow whose `on:` never fires for this branch, where every step is correct and
 * none of them ever runs — and an eighth below them, a strict check with no probe.
 *
 * Four false FAILs are covered too, because a guard that fires on a healthy tree gets deleted rather
 * than obeyed: the old regex rejected the inline `- run: …` form that four other ci.yml steps use,
 * the source walk descended into electron-builder's gitignored `release/` output and reported the
 * unpacked app's own files back as uncovered, a `run: |` block may legitimately group output around
 * the invocation, and `on: [push, pull_request]` is the most permissive wiring there is.
 *
 * Cases run against a synthetic repo root rather than the real one: the guard's whole job is to
 * notice a broken arrangement, and the real tree is (by construction) never broken. The exceptions are
 * the last two — "is this guard wired to anything" is a fact about THIS repo, so they read this repo.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const GUARD = fileURLToPath(new URL('../../scripts/check-studio-typecheck-coverage.mjs', import.meta.url));
const REPO = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Every fixture carries the trigger block, because a workflow that never fires enforces nothing no
 * matter what its steps say — the guard asserts `on:` for exactly that reason, and a fixture without
 * one would fail for a reason it is not about.
 */
const TRIGGERS = `on:
  push:
    branches: [main, studio-handoff]
  pull_request:
    branches: [main, studio-handoff]
`;

const wf = (jobs: string): string => `name: CI\n${TRIGGERS}${jobs}`;

const WORKFLOW_WITH_STEP = wf(`jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        run: npm run lint -w apps/studio
`);

const WORKFLOW_WITHOUT_STEP = wf(`jobs:
  studio-unit:
    steps:
      - name: Unit tests (studio)
        run: npm test -w apps/studio
`);

/**
 * The real ci.yml carries the invocation inside a prose comment explaining why it must not be
 * removed. A substring check over the raw file is satisfied by that comment alone, so deleting the
 * only real step is a green edit.
 */
const WORKFLOW_COMMENT_ONLY = wf(`jobs:
  studio-unit:
    steps:
      # Removing this step reopens P7. The step below is \`npm run lint -w apps/studio\`.
      - name: Unit tests (studio)
        run: npm test -w apps/studio
`);

/**
 * A real step annotated in place. The step is present and correct, so the guard must not fire on it.
 */
const WORKFLOW_TRAILING_COMMENT = wf(`jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        run: npm run lint -w apps/studio  # do not remove — this IS the app's type-check
`);

/**
 * Bypass 3. `NOTES: |` is a block scalar: every line inside it is a string value, not YAML structure.
 * The old assertion was a line-anchored regex over comment-stripped but unparsed text, so this file
 * satisfied it with no step invoking the app type-check anywhere.
 */
const WORKFLOW_BLOCK_SCALAR_DECOY = wf(`jobs:
  studio-unit:
    steps:
      - name: Unit tests (studio)
        env:
          NOTES: |
            The studio lint step is
            run: npm run lint -w apps/studio
            and it must not be removed.
        run: npm test -w apps/studio
`);

/** Bypass 4. The line the regex asserted is present, on a step that can never execute. */
const WORKFLOW_STEP_IF_FALSE = wf(`jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        if: false
        run: npm run lint -w apps/studio
`);

/** Bypass 4, one level up: the step is live, the job it lives in is not. */
const WORKFLOW_JOB_IF_FALSE = wf(`jobs:
  studio-unit:
    if: false
    steps:
      - name: Lint studio (tsc --noEmit)
        run: npm run lint -w apps/studio
`);

/**
 * False FAIL 5. ci.yml uses this inline form for four other steps; the old regex allowed only
 * whitespace before `run:`, so collapsing the studio step onto one line broke the guard with the
 * check still entirely correct.
 */
const WORKFLOW_INLINE_RUN = wf(`jobs:
  studio-unit:
    steps:
      - run: npm run lint -w apps/studio
`);

/** Must-not-fire: `always()` is a condition that cannot disable the step. */
const WORKFLOW_IF_ALWAYS = wf(`jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        if: \${{ always() }}
        run: npm run lint -w apps/studio
`);

// -----------------------------------------------------------------------------------------------
// Execution semantics. Everything above proves the invocation SITS in an enabled step; none of it
// proves the shell EXECUTES it and lets its failure fail the step. Each fixture below satisfies
// every earlier check — parsed step, no `if:`, real `run:` — and enforces nothing.
// -----------------------------------------------------------------------------------------------

/**
 * The live repro from the SD0 exit-4 session: the step is still named `Lint studio`, still
 * unconditional, still carries the invocation in its `run:` — as a shell comment. The guard printed
 * "invoked by an enabled ci.yml step" and exited 0.
 */
const WORKFLOW_SHELL_COMMENTED = wf(`jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        run: |
          # npm run lint -w apps/studio
          echo "temporarily disabled"
`);

/** The invocation as data rather than as a command. Nothing runs a quoted string. */
const WORKFLOW_ECHOED = wf(`jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        run: echo "npm run lint -w apps/studio"
`);

/** Exit-code swallowing, the shortest form. */
const WORKFLOW_OR_TRUE = wf(`jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        run: npm run lint -w apps/studio || true
`);

/** Exit-code swallowing through a pipeline: `$?` becomes `tee`'s, which always succeeds. */
const WORKFLOW_PIPED = wf(`jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        run: npm run lint -w apps/studio | tee studio-lint.log
`);

/** Exit-code swallowing by switching off the abort the runner's `bash -e` provides. */
const WORKFLOW_SET_PLUS_E = wf(`jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        run: |
          set +e
          npm run lint -w apps/studio
          echo "done"
`);

/** The step runs and fails; the job reports success anyway. */
const WORKFLOW_STEP_CONTINUE_ON_ERROR = wf(`jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        continue-on-error: true
        run: npm run lint -w apps/studio
`);

/** Same, one level up. */
const WORKFLOW_JOB_CONTINUE_ON_ERROR = wf(`jobs:
  studio-unit:
    continue-on-error: true
    steps:
      - name: Lint studio (tsc --noEmit)
        run: npm run lint -w apps/studio
`);

/**
 * Must-not-fire. A `run: |` block with benign neighbours: under the runner's `bash -e` the
 * invocation's failure aborts the script, so its exit code IS the step's. A guard that rejected this
 * would forbid the one multi-line form CI actually uses.
 */
const WORKFLOW_MULTILINE_BENIGN = wf(`jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        shell: bash
        run: |
          # the app's own type-check — see known issue P7
          echo "::group::studio type-check"
          npm run lint -w apps/studio
          echo "::endgroup::"
`);

/** Must-not-fire: `continue-on-error: false` is the explicit spelling of the default. */
const WORKFLOW_CONTINUE_ON_ERROR_FALSE = wf(`jobs:
  studio-unit:
    continue-on-error: false
    steps:
      - name: Lint studio (tsc --noEmit)
        continue-on-error: false
        run: npm run lint -w apps/studio
`);

/** A workflow that only ever runs on a tag: the step is present, unconditional and dead. */
const WORKFLOW_NO_PR_TRIGGER = `name: CI
on:
  push:
    tags: ['v*']
jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        run: npm run lint -w apps/studio
`;

/** Fires for pull requests, but never for the branch this program merges into. */
const WORKFLOW_PUSH_MAIN_ONLY = `name: CI
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        run: npm run lint -w apps/studio
`;

/** Must-not-fire: the unfiltered shorthand fires for every branch, including this one. */
const WORKFLOW_TRIGGER_SHORTHAND = `name: CI
on: [push, pull_request]
jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        run: npm run lint -w apps/studio
`;

/**
 * The compiler options a fixture needs for the probe set to be meaningful: a modern lib (the
 * builtin-iterator probe needs `Array.prototype.values`) and no ambient `@types` sweep.
 */
const BASE_OPTIONS = {
  target: 'ES2022',
  module: 'ESNext',
  moduleResolution: 'Bundler',
  skipLibCheck: true,
  noEmit: true,
  types: [] as string[],
};

/** Every member of the strict family switched off while `strict` itself stays `true` — bypass 2. */
const STRICT_MEMBERS_OFF = {
  noImplicitAny: false,
  strictNullChecks: false,
  strictFunctionTypes: false,
  strictBindCallApply: false,
  strictPropertyInitialization: false,
  strictBuiltinIteratorReturn: false,
  noImplicitThis: false,
  useUnknownInCatchVariables: false,
};

interface Fixture {
  readonly include?: readonly string[];
  /** `files` instead of `include`, i.e. a project no planted file can enter. */
  readonly files?: readonly string[];
  readonly strict?: boolean;
  /** Extra `compilerOptions` merged over the baseline. */
  readonly options?: Readonly<Record<string, unknown>>;
  readonly workflow?: string;
  /** Extra files to drop into `apps/studio/src` beyond the baseline one. */
  readonly extraSrc?: readonly string[];
  /** Arbitrary extra files, keyed by path relative to `apps/studio`. */
  readonly extraApp?: Readonly<Record<string, string>>;
  /** Extra tsconfig-shaped JSON files, keyed by name relative to `apps/studio`. */
  readonly extraConfigs?: Readonly<Record<string, unknown>>;
  /** `apps/studio`'s `lint` script. `null` removes the key entirely. */
  readonly lintScript?: string | null;
}

let root: string;

function buildFixture(f: Fixture = {}): void {
  const app = join(root, 'apps', 'studio');
  mkdirSync(join(app, 'src', 'main'), { recursive: true });
  mkdirSync(join(app, 'tests', 'unit'), { recursive: true });
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true });

  writeFileSync(join(app, 'src', 'main', 'index.ts'), 'export const boot = () => 1;\n');
  writeFileSync(join(app, 'tests', 'unit', 'boot.test.ts'), 'export const spec = 1;\n');
  writeFileSync(join(app, 'vitest.config.ts'), 'export default {};\n');
  for (const name of f.extraSrc ?? []) {
    writeFileSync(join(app, 'src', name), 'export const extra = 1;\n');
  }
  for (const [rel, body] of Object.entries(f.extraApp ?? {})) {
    const target = join(app, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
  }
  for (const [name, body] of Object.entries(f.extraConfigs ?? {})) {
    writeFileSync(join(app, name), JSON.stringify(body, null, 2));
  }

  const lint = f.lintScript === undefined ? 'tsc --noEmit' : f.lintScript;
  writeFileSync(
    join(app, 'package.json'),
    JSON.stringify({ name: 'studio', scripts: { test: 'vitest run', ...(lint === null ? {} : { lint }) } }, null, 2)
  );

  writeFileSync(
    join(app, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: { ...BASE_OPTIONS, strict: f.strict ?? true, ...(f.options ?? {}) },
        ...(f.files ? { files: f.files } : { include: f.include ?? ['src', 'tests', '*.config.ts'] }),
      },
      null,
      2
    )
  );
  writeFileSync(join(root, '.github', 'workflows', 'ci.yml'), f.workflow ?? WORKFLOW_WITH_STEP);
  // The behavioural half of the guard runs the real `npm run lint -w apps/studio`, and it is the
  // ROOT package.json that resolves that `-w` selector — in CI and here alike.
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture-root', private: true, workspaces: ['apps/*'] }, null, 2));
}

function runGuard(...flags: readonly string[]): { status: number; output: string } {
  return runGuardWithEnv({}, ...flags);
}

function runGuardWithEnv(env: Readonly<Record<string, string>>, ...flags: readonly string[]): { status: number; output: string } {
  // A guard that hangs must fail this suite, not stall it: without a timeout a spin in the tree walk
  // blocks vitest until the job's 30-minute ceiling, which reads as infrastructure, not as a bug.
  // The budget covers two real type-checks now, which on a fixture this size are still sub-second.
  const r = spawnSync(process.execPath, [GUARD, root, ...flags], {
    encoding: 'utf8',
    timeout: 180_000,
    env: { ...process.env, ...env },
  });
  return { status: r.status ?? -1, output: `${r.stdout ?? ''}${r.stderr ?? ''}${r.signal ? `\nkilled by ${r.signal}` : ''}` };
}

/**
 * The `&&` links of a command chain, and nothing else. Anything a link is decorated with — `|| true`,
 * a pipe, a `;` continuation — stays glued to that link, so an exact-match assertion against the
 * result cannot be satisfied by a decorated invocation. This is the package-script analogue of the
 * guard's own command-position rule, kept here rather than shared because npm scripts are a far
 * smaller language than a `run:` block and a shared tokeniser would be the more complex one.
 */
const commandChain = (script: string): string[] => script.split('&&').map((s) => s.trim());

/** GitHub's `continue-on-error`, read the way the guard reads it: only an explicit false enforces. */
const enforcing = (value: unknown): boolean =>
  value === undefined || value === null || String(value).trim().toLowerCase() === 'false';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sd64-p7-guard-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('apps/studio type-check coverage guard (P7)', () => {
  it('passes on a correctly wired arrangement — otherwise it cannot distinguish broken from whole', () => {
    buildFixture();
    const { status, output } = runGuard();
    expect(output).toContain('OK:');
    expect(status).toBe(0);
  });

  it('fails when `include` is narrowed so app files drop out of the project', () => {
    // The P7 shape exactly: tsc still exits 0, over a project that no longer contains the app.
    buildFixture({ include: ['src'] });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('tests/unit/boot.test.ts');
    expect(output).toContain('vitest.config.ts');
  });

  it('fails when a new src file is not matched by `include`', () => {
    // Guards the direction a growing app breaks in: files are added, the project is not widened.
    buildFixture({ include: ['src/main', 'tests', '*.config.ts'], extraSrc: ['renderer.ts'] });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('src/renderer.ts');
  });

  it('fails when the project lists every file but checks almost nothing (`strict: false`)', () => {
    buildFixture({ strict: false });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    // The pre-filter's own wording. `strict: true` alone would not do: the behavioural failure names
    // that string too, so this fixture is caught twice and asserting the shared substring would be
    // satisfied by either mechanism — leaving the pre-filter free to be deleted unnoticed.
    expect(output).toContain('a non-strict project sees every file');
  });

  it('fails when ci.yml stops invoking the app type-check — the literal P7 state', () => {
    buildFixture({ workflow: WORKFLOW_WITHOUT_STEP });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('npm run lint -w apps/studio');
  });

  it('fails when the `lint` script no longer type-checks — the CI step runs whatever it is', () => {
    // Identified by the pre-filter's own message: `"lint": "true"` is caught behaviourally too, so
    // asserting only the exit code would leave the fast path unexercised.
    buildFixture({ lintScript: 'true' });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('so this script IS the app');
    expect(output).toContain('tsc --noEmit');
  });

  it('fails when apps/studio has no `lint` script at all', () => {
    buildFixture({ lintScript: null });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('lint');
  });

  it('accepts a `lint` script that names its project explicitly', () => {
    // Must-not-fire: `-p <path>` is a legitimate way to write the same check, and a guard that
    // rejected it would push the next author to weaken the assertion rather than satisfy it. It stays
    // allowed precisely because the behavioural check decides whether the named project is real.
    buildFixture({ lintScript: 'tsc -p tsconfig.json --noEmit' });
    const { status, output } = runGuard();
    expect(output).toContain('OK:');
    expect(status).toBe(0);
  });

  it('fails when the invocation survives only inside a ci.yml comment', () => {
    buildFixture({ workflow: WORKFLOW_COMMENT_ONLY });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('npm run lint -w apps/studio');
  });

  it('accepts a real step carrying a trailing comment', () => {
    buildFixture({ workflow: WORKFLOW_TRAILING_COMMENT });
    const { status, output } = runGuard();
    expect(output).toContain('OK:');
    expect(status).toBe(0);
  });

  it('fails when a .ts file outside src/tests is covered by nothing', () => {
    buildFixture({ extraApp: { 'scripts/make-icons.ts': 'export const icons = 1;\n' } });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('scripts/make-icons.ts');
  });

  it('fails when a .mts / .cts file is covered by nothing', () => {
    buildFixture({
      extraApp: { 'tooling.mts': 'export const t = 1;\n', 'legacy.cts': 'export const l = 1;\n' },
    });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('tooling.mts');
    expect(output).toContain('legacy.cts');
  });

  it('ignores node_modules, out and dist — build output is not source the app must type-check', () => {
    // Must-not-fire: the widened walk runs over a tree that always contains installed dependencies
    // and build output. Flagging those would make the guard fire on every correctly wired repo,
    // i.e. it would be turned off rather than satisfied.
    buildFixture({
      extraApp: {
        'node_modules/dep/index.d.ts': 'export declare const d: number;\n',
        'out/main/index.ts': 'export const built = 1;\n',
        'dist/renderer.mts': 'export const built = 2;\n',
      },
    });
    const { status, output } = runGuard();
    expect(output).toContain('OK:');
    expect(status).toBe(0);
  });

  // ---------------------------------------------------------------------------------------------
  // Bypass 1 — a decoy project named by `-p`.
  // Mutant: delete the behavioural check (or stop planting probes). Blast radius: this case goes
  // green while `npm run lint -w apps/studio` compiles one trivial file and nothing else. Every
  // shape-check in the guard passes on this fixture — the tsconfig is strict and complete, the lint
  // script matches the allowed `-p` form, the CI step is present — which is why it survived two
  // hardening passes.
  // ---------------------------------------------------------------------------------------------
  it('fails when the `lint` script points `-p` at a decoy project that checks nothing', () => {
    buildFixture({
      lintScript: 'tsc --noEmit -p tsconfig.decoy.json',
      extraConfigs: {
        // A decoy that compiles cleanly: `files` names one real file, so tsc exits 0 rather than
        // erroring for want of inputs, and no planted file can ever enter this project.
        'tsconfig.decoy.json': { compilerOptions: { ...BASE_OPTIONS, strict: true }, include: [], files: ['src/main/index.ts'] },
      },
    });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('planted type errors');
    expect(output).toContain('not type-checking this project');
  });

  // ---------------------------------------------------------------------------------------------
  // Bypass 2 — `strict: true` with its members off.
  // Mutant: drop the flag probes and keep only the baseline one. Blast radius: this case goes green
  // with `options.strict === true` and almost every check disabled. The guard asserted
  // `options.strict !== true` and nothing else, so this was invisible to it by construction.
  // ---------------------------------------------------------------------------------------------
  it('fails when `strict: true` is paired with every strict member flag switched off', () => {
    buildFixture({ options: STRICT_MEMBERS_OFF });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    // Named individually, because a count would pass a guard that noticed only one of them.
    for (const flag of Object.keys(STRICT_MEMBERS_OFF)) expect(output).toContain(flag);
    // The baseline probe is a plain assignment mismatch, which no strict flag governs: it must still
    // be reported, or this fixture would be indistinguishable from a type-check that does not run.
    expect(output).not.toContain('- baseline');
  });

  it('fails when a single strict member flag is switched off', () => {
    // The realistic edit is one flag, not eight, and a guard that only noticed the wholesale version
    // would be satisfied by the version anyone would actually write.
    buildFixture({ options: { strictNullChecks: false } });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('strictNullChecks');
    expect(output).not.toContain('noImplicitThis');
  });

  // ---------------------------------------------------------------------------------------------
  // Bypass 3 — a `run:`-looking line inside a YAML block scalar.
  // Mutant: revert the CI assertion to a regex over the workflow text. Blast radius: this case goes
  // green with no step invoking the app type-check anywhere in the file.
  // ---------------------------------------------------------------------------------------------
  it('fails when the invocation appears only inside a YAML block scalar, not a step', () => {
    buildFixture({ workflow: WORKFLOW_BLOCK_SCALAR_DECOY });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('no enabled `run:` step');
  });

  // ---------------------------------------------------------------------------------------------
  // Bypass 4 — the step exists and cannot execute.
  // Mutant: stop consulting `if:`. Blast radius: both cases below go green while the app type-check
  // never runs in CI, which is P7's recorded state with the asserted line still in the file.
  // ---------------------------------------------------------------------------------------------
  it('fails when the real step is disabled with `if: false`', () => {
    buildFixture({ workflow: WORKFLOW_STEP_IF_FALSE });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('cannot be relied on to run');
    expect(output).toContain('if: false');
  });

  it('fails when the job carrying the step is disabled with `if: false`', () => {
    buildFixture({ workflow: WORKFLOW_JOB_IF_FALSE });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('cannot be relied on to run');
    expect(output).toContain('studio-unit');
  });

  it('accepts a step conditional on `always()` — a condition that cannot disable it', () => {
    // Must-not-fire, and the case that keeps the `if:` rule from collapsing into "any condition is
    // disabling": that reading would fire on a healthy workflow, and the fix would be to delete the
    // assertion rather than the condition.
    buildFixture({ workflow: WORKFLOW_IF_ALWAYS });
    const { status, output } = runGuard();
    expect(output).toContain('OK:');
    expect(status).toBe(0);
  });

  // ---------------------------------------------------------------------------------------------
  // False FAIL 5 — the inline `- run:` form.
  // Mutant: re-anchor the CI assertion to `^[ \t]*run:`. Blast radius: this case fails on a workflow
  // whose step is present and correct. ci.yml already writes four other steps this way, so the next
  // author to collapse the studio step onto one line would find the guard wrong and switch it off.
  // ---------------------------------------------------------------------------------------------
  it('accepts the inline `- run:` step form that ci.yml uses elsewhere', () => {
    buildFixture({ workflow: WORKFLOW_INLINE_RUN });
    const { status, output } = runGuard();
    expect(output).toContain('OK:');
    expect(status).toBe(0);
  });

  // ---------------------------------------------------------------------------------------------
  // Bypasses 8-12 — execution semantics. The checks above prove the invocation SITS in an enabled
  // step; none of them proves the shell RUNS it, or that its failure reaches the job's conclusion.
  // Every fixture in this section parses as a real, unconditional `run:` step carrying the exact
  // invocation, which is why each one printed "invoked by an enabled ci.yml step" and exited 0.
  //
  // Each case asserts the wording of the rule that owns it, because several of these shapes are one
  // edit apart and a shared substring would let any one detector die unnoticed.
  // ---------------------------------------------------------------------------------------------

  it('fails when the invocation is commented out inside its own step — the live SD0 repro', () => {
    // Mutant: skip the comment strip. Blast radius: this case goes green with the studio type-check
    // switched off in one line, the step still named `Lint studio`, and every other check satisfied.
    buildFixture({ workflow: WORKFLOW_SHELL_COMMENTED });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('not as a command it runs');
    // Naming the step is the point: "somewhere in ci.yml" is not actionable when the file has 20 of
    // them, and the acceptance criterion for this issue is a message that names it.
    expect(output).toContain('Lint studio (tsc --noEmit)');
  });

  it('fails when the invocation survives only as a quoted string', () => {
    // Mutant: match the invocation anywhere in the run text instead of at a command position.
    buildFixture({ workflow: WORKFLOW_ECHOED });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('not as a command it runs');
  });

  it('fails when the invocation is suffixed with `|| true`', () => {
    // Mutant: drop the exit-code rule. Blast radius: the type-check runs, prints its errors, and the
    // step passes — the loudest possible way to enforce nothing.
    buildFixture({ workflow: WORKFLOW_OR_TRUE });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('discards its exit code');
    expect(output).toContain('`||`');
  });

  it('fails when the invocation is piped, so `$?` belongs to the last stage', () => {
    buildFixture({ workflow: WORKFLOW_PIPED });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('discards its exit code');
    expect(output).toContain('`|`');
  });

  it('fails when `set +e` disarms the abort the step relies on', () => {
    // The subtlest of the family: the command is in command position, unpiped, unsuffixed, and its
    // failure still does not fail the step.
    buildFixture({ workflow: WORKFLOW_SET_PLUS_E });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('set +e');
  });

  it('fails when the step is marked `continue-on-error`', () => {
    // Mutant: consult `if:` only. Blast radius: the type-check runs, fails, is reported red in the
    // step list, and the job — and therefore the required check — still concludes SUCCESS.
    buildFixture({ workflow: WORKFLOW_STEP_CONTINUE_ON_ERROR });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('continue-on-error');
    expect(output).toContain('Lint studio (tsc --noEmit)');
  });

  it('fails when the job carrying the step is marked `continue-on-error`', () => {
    buildFixture({ workflow: WORKFLOW_JOB_CONTINUE_ON_ERROR });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('continue-on-error');
    expect(output).toContain('studio-unit');
  });

  it('accepts a multi-line `run:` block whose neighbours preserve the exit code', () => {
    // Must-not-fire, and the case that stops the exit-code rule collapsing into "any neighbouring
    // command is disqualifying": grouping output around a check is normal, and a guard that rejected
    // it would be worked around rather than satisfied. Under the runner's `bash -e` a failing
    // invocation aborts the block, so the step's exit code is the type-check's.
    buildFixture({ workflow: WORKFLOW_MULTILINE_BENIGN });
    const { status, output } = runGuard();
    expect(output).toContain('OK:');
    expect(status).toBe(0);
  });

  it('accepts `continue-on-error: false`, the explicit spelling of the default', () => {
    buildFixture({ workflow: WORKFLOW_CONTINUE_ON_ERROR_FALSE });
    const { status, output } = runGuard();
    expect(output).toContain('OK:');
    expect(status).toBe(0);
  });

  // ---------------------------------------------------------------------------------------------
  // Bypass 13 — the workflow never fires. A step can be present, unconditional, correctly written
  // and dead, because nothing above it in the file ever starts the run.
  // ---------------------------------------------------------------------------------------------

  it('fails when the workflow never runs on `pull_request`', () => {
    // Mutant: drop the trigger check. Blast radius: the type gate stops blocking PRs — the exact
    // regression e29d14d7 fixed for this repo once already, when `pull_request` was main-only.
    buildFixture({ workflow: WORKFLOW_NO_PR_TRIGGER });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('never runs on');
    expect(output).toContain('pull_request');
  });

  it('fails when the triggers exclude the branch this program merges into', () => {
    buildFixture({ workflow: WORKFLOW_PUSH_MAIN_ONLY });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('studio-handoff');
  });

  it('accepts the unfiltered `on: [push, pull_request]` shorthand', () => {
    // Must-not-fire: no `branches:` filter means every branch, so this fires for more than the guard
    // demands. Rejecting it would make the guard fire on the most permissive wiring there is.
    buildFixture({ workflow: WORKFLOW_TRIGGER_SHORTHAND });
    const { status, output } = runGuard();
    expect(output).toContain('OK:');
    expect(status).toBe(0);
  });

  // ---------------------------------------------------------------------------------------------
  // Bypass 14 — a strict check with no probe. The unprobed set was computed and PRINTED, in the OK
  // line of a passing run: prose on stdout is not a gate, so a strict check added by a compiler
  // upgrade would arrive as a sentence nobody reads, with nothing planting an error for it and
  // `strict: true` staying true while it is individually switched off. It is now pinned in both
  // directions.
  // ---------------------------------------------------------------------------------------------

  it('fails when the compiler declares a strict check no probe covers', () => {
    // The flag list comes from the installed TypeScript, so the only way to move it from a test is to
    // inject one. The injection can only ADD names — there is no spelling of it that switches a check
    // off — which is what makes a test-visible hook safe here.
    buildFixture();
    const { status, output } = runGuardWithEnv({ P7_EXTRA_STRICT_FLAGS: 'strictImaginaryFutureCheck' });
    expect(status).toBe(1);
    expect(output).toContain('strictImaginaryFutureCheck');
    expect(output).toContain('no probe');
  });

  it('reports the probed strict-check count on success, so the pin is legible in a green run', () => {
    // Must-not-fire companion: the pin must hold on the compiler that is actually installed, or the
    // test above proves only that the guard can fail for some reason.
    buildFixture();
    const { status, output } = runGuard();
    expect(status).toBe(0);
    expect(output).toMatch(/All \d+ strict checks TypeScript [\d.]+ declares are probed/);
  });

  it('fails when `alwaysStrict` — strict-family but untagged by the compiler — is switched off', () => {
    // The issue that scheduled this work expected `alwaysStrict: false` to sail through: it carries
    // no `strictFlag` in TypeScript's option declarations, so it is not in the probed family at all.
    // On the installed compiler it is caught anyway, one layer down — `alwaysStrict: false` is
    // deprecated (TS5107) and the clean run therefore does not pass. Asserted rather than assumed,
    // because "caught by something else" is a claim with a truth value and it is load-bearing here:
    // it is the reason `alwaysStrict` needs no probe.
    buildFixture({ options: { alwaysStrict: false } });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('does not currently pass');
    expect(output).toContain('TS5107');
  });

  // ---------------------------------------------------------------------------------------------
  // False FAIL 6 — electron-builder's output directory.
  // Mutant: drop `release` from NOT_SOURCE. Blast radius: this case fails on any machine that has
  // packaged the app, because `directories.output = 'release'` holds an unpacked copy of the tree and
  // the walk reports the app's own files back as uncovered.
  // ---------------------------------------------------------------------------------------------
  it('ignores electron-builder`s release/ output tree', () => {
    buildFixture({
      extraApp: {
        'release/mac-arm64/Wigolo.app/Contents/Resources/app/src/main/index.ts': 'export const packaged = 1;\n',
        'release/linux-unpacked/resources/app/tooling.mts': 'export const packaged = 2;\n',
      },
    });
    const { status, output } = runGuard();
    expect(output).toContain('OK:');
    expect(status).toBe(0);
  });

  // ---------------------------------------------------------------------------------------------
  // The behavioural check's own preconditions. Both directions matter: a check that cannot prove
  // anything must FAIL rather than pass vacuously, which is P7's failure class applied to itself.
  // ---------------------------------------------------------------------------------------------
  it('fails when the app does not currently type-check, rather than reporting on a broken baseline', () => {
    // Mutant: drop the clean-run assertion. Blast radius: with a pre-existing error in the tree,
    // every planted probe is drowned in real diagnostics and the guard can no longer tell a working
    // type-check from a broken one — it would report OK on a tree that does not compile.
    buildFixture({ extraApp: { 'src/broken.ts': 'export const broken: number = "not a number";\n' } });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('does not currently pass');
    expect(output).toContain('src/broken.ts');
  });

  it('fails when no directory in the project can accept a planted file', () => {
    // Mutant: drop the placement verification and assume `src`. Blast radius: a project defined by
    // `files` alone admits no planted error anywhere, so the planted run reports nothing — which is
    // byte-identical to a type-check that does not run. Refusing to pass is the only safe reading.
    buildFixture({ files: ['src/main/index.ts', 'tests/unit/boot.test.ts', 'vitest.config.ts'] });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('accepts a planted file');
  });

  // ---------------------------------------------------------------------------------------------
  // The two-mode split. The behavioural half needs a built `dist/` (the app imports `wigolo/studio`
  // through the root package's exports), and the `gate` CI job has no build step on purpose, so the
  // halves run from two places. That split is only safe if `--shape-only` is what it claims: a
  // narrower check that still fires on everything the shape-checks own, and the DEFAULT is the full
  // one — an inverted or no-op flag would silently retire the planted-error check everywhere.
  // ---------------------------------------------------------------------------------------------
  it('`--shape-only` skips the planted-error check, and the default does not', () => {
    buildFixture({ options: STRICT_MEMBERS_OFF });
    const shape = runGuard('--shape-only');
    expect(shape.output).toContain('OK (shape only)');
    expect(shape.output).toContain('planted-error check was NOT run');
    expect(shape.status).toBe(0);

    const full = runGuard();
    expect(full.status).toBe(1);
    expect(full.output).toContain('strictNullChecks');
  });

  it('`--shape-only` still fires on everything the shape-checks own', () => {
    // Otherwise the mode that rides three OS on every push would be a no-op wearing a name.
    buildFixture({ include: ['src'], workflow: WORKFLOW_STEP_IF_FALSE, lintScript: 'true', strict: false });
    const { status, output } = runGuard('--shape-only');
    expect(status).toBe(1);
    expect(output).toContain('tests/unit/boot.test.ts');
    expect(output).toContain('a non-strict project sees every file');
    expect(output).toContain('so this script IS the app');
    expect(output).toContain('cannot be relied on to run');
  });

  it('is gated, not documented: both halves of the guard are invoked by something', () => {
    // The `--shape-only` half is chained into gate:studio; the planted-error half is a ci.yml step in
    // the job that builds core, because it cannot resolve `wigolo/studio` without that build. Losing
    // either invocation leaves the corresponding half a local command nobody runs — P7 one level up,
    // and now with two places to lose it from.
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    // `toContain` is satisfied by `node scripts/…mjs --shape-only || true`, which is the same
    // exit-code swallow the workflow half of this issue closes, one layer down. Compare the whole
    // command instead: a swallow cannot hide inside an exact match.
    expect(commandChain(pkg.scripts['check:studio-typecheck'])).toContain(
      'node scripts/check-studio-typecheck-coverage.mjs --shape-only'
    );
    expect(commandChain(pkg.scripts['check:studio-typecheck-runs'])).toContain('node scripts/check-studio-typecheck-coverage.mjs');
    expect(pkg.scripts['check:studio-typecheck-runs']).not.toContain('--shape-only');

    const ci = parseYaml(readFileSync(join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8')) as {
      jobs: Record<string, { if?: unknown; 'continue-on-error'?: unknown; steps?: { if?: unknown; 'continue-on-error'?: unknown; run?: unknown }[] }>;
    };
    const hosts = Object.entries(ci.jobs).filter(([, job]) =>
      (job.steps ?? []).some((s) => typeof s.run === 'string' && s.run.includes('check:studio-typecheck-runs'))
    );
    expect(hosts).toHaveLength(1);
    const [name, job] = hosts[0]!;
    expect(job.if).toBeUndefined();
    // A `continue-on-error` job reports SUCCESS to the required-checks list however its steps went,
    // so this half of the guard would run, fail, and block nothing.
    expect(enforcing(job['continue-on-error'])).toBe(true);
    const steps = job.steps ?? [];
    const planted = steps.findIndex((s) => typeof s.run === 'string' && s.run.includes('check:studio-typecheck-runs'));
    expect(steps[planted]!.if).toBeUndefined();
    expect(enforcing(steps[planted]!['continue-on-error'])).toBe(true);
    expect(commandChain(String(steps[planted]!.run))).toContain('npm run check:studio-typecheck-runs');
    // It must run AFTER the build, in the same job: without `dist/` the app cannot resolve
    // `wigolo/studio`, so the clean run fails and the guard reports an environment problem rather
    // than a P7 regression. `name` is asserted so a rename of the host job is a visible decision.
    const build = steps.findIndex((s) => typeof s.run === 'string' && s.run.includes('npm run build'));
    expect(build).toBeGreaterThanOrEqual(0);
    expect(planted).toBeGreaterThan(build);
    expect(name).toBe('studio-unit');
  });

  // Bypass 7 — nothing asserted that anything invokes the guard.
  // Mutant: delete `npm run check:studio-typecheck &&` from `gate:studio`, or the `gate:studio` step
  // from ci.yml. Blast radius: every suite in the repo stays green while this entire file guards a
  // command nobody runs. Same shape, and the same assertion pair, as
  // `tests/unit/electron-quarantine.test.ts`.
  it('is gated, not documented: gate:studio chains the guard so its failure fails the gate', () => {
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['check:studio-typecheck']).toContain('scripts/check-studio-typecheck-coverage.mjs');
    // `toContain('check:studio-typecheck')` alone is satisfied by
    // `… && npm run check:studio-typecheck || true && …`, where the guard runs, fails, prints its
    // diagnosis and the gate exits 0. The chain must hold the invocation as its own `&&` link.
    expect(commandChain(pkg.scripts['gate:studio'])).toContain('npm run check:studio-typecheck');
  });

  it('is gated, not documented: the CI gate job runs gate:studio', () => {
    const ci = readFileSync(join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8');
    expect(ci).toMatch(/^\s*run: npm run gate:studio\s*$/m);
  });

  // ---------------------------------------------------------------------------------------------
  // The two helpers above, exercised directly. They decide whether a real wiring assertion passes,
  // so a helper that quietly accepted everything would make those assertions vacuous — the failure
  // class this whole file exists to catch, one level further in.
  // ---------------------------------------------------------------------------------------------

  it('commandChain splits on `&&` only, so a swallowed link is not a link', () => {
    expect(commandChain('a && b && c')).toEqual(['a', 'b', 'c']);
    expect(commandChain('a && b || true && c')).not.toContain('b');
    expect(commandChain('a && b | tee log')).not.toContain('b');
    expect(commandChain('a && b ; c')).not.toContain('b');
  });

  it('enforcing() treats every unevaluable `continue-on-error` as disabling', () => {
    expect(enforcing(undefined)).toBe(true);
    expect(enforcing(false)).toBe(true);
    expect(enforcing('false')).toBe(true);
    expect(enforcing(true)).toBe(false);
    expect(enforcing('true')).toBe(false);
    expect(enforcing("${{ matrix.os == 'ubuntu-22.04-arm' }}")).toBe(false);
  });
});
