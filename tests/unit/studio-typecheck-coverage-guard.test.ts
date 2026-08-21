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
 * Two false FAILs are covered too, because a guard that fires on a healthy tree gets deleted rather
 * than obeyed: the old regex rejected the inline `- run: …` form that four other ci.yml steps use,
 * and the source walk descended into electron-builder's gitignored `release/` output and reported the
 * unpacked app's own files back as uncovered.
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

const GUARD = fileURLToPath(new URL('../../scripts/check-studio-typecheck-coverage.mjs', import.meta.url));
const REPO = fileURLToPath(new URL('../..', import.meta.url));

const WORKFLOW_WITH_STEP = `name: CI
jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        run: npm run lint -w apps/studio
`;

const WORKFLOW_WITHOUT_STEP = `name: CI
jobs:
  studio-unit:
    steps:
      - name: Unit tests (studio)
        run: npm test -w apps/studio
`;

/**
 * The real ci.yml carries the invocation inside a prose comment explaining why it must not be
 * removed. A substring check over the raw file is satisfied by that comment alone, so deleting the
 * only real step is a green edit.
 */
const WORKFLOW_COMMENT_ONLY = `name: CI
jobs:
  studio-unit:
    steps:
      # Removing this step reopens P7. The step below is \`npm run lint -w apps/studio\`.
      - name: Unit tests (studio)
        run: npm test -w apps/studio
`;

/**
 * A real step annotated in place. The step is present and correct, so the guard must not fire on it.
 */
const WORKFLOW_TRAILING_COMMENT = `name: CI
jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        run: npm run lint -w apps/studio  # do not remove — this IS the app's type-check
`;

/**
 * Bypass 3. `NOTES: |` is a block scalar: every line inside it is a string value, not YAML structure.
 * The old assertion was a line-anchored regex over comment-stripped but unparsed text, so this file
 * satisfied it with no step invoking the app type-check anywhere.
 */
const WORKFLOW_BLOCK_SCALAR_DECOY = `name: CI
jobs:
  studio-unit:
    steps:
      - name: Unit tests (studio)
        env:
          NOTES: |
            The studio lint step is
            run: npm run lint -w apps/studio
            and it must not be removed.
        run: npm test -w apps/studio
`;

/** Bypass 4. The line the regex asserted is present, on a step that can never execute. */
const WORKFLOW_STEP_IF_FALSE = `name: CI
jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        if: false
        run: npm run lint -w apps/studio
`;

/** Bypass 4, one level up: the step is live, the job it lives in is not. */
const WORKFLOW_JOB_IF_FALSE = `name: CI
jobs:
  studio-unit:
    if: false
    steps:
      - name: Lint studio (tsc --noEmit)
        run: npm run lint -w apps/studio
`;

/**
 * False FAIL 5. ci.yml uses this inline form for four other steps; the old regex allowed only
 * whitespace before `run:`, so collapsing the studio step onto one line broke the guard with the
 * check still entirely correct.
 */
const WORKFLOW_INLINE_RUN = `name: CI
jobs:
  studio-unit:
    steps:
      - run: npm run lint -w apps/studio
`;

/** Must-not-fire: `always()` is a condition that cannot disable the step. */
const WORKFLOW_IF_ALWAYS = `name: CI
jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        if: \${{ always() }}
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

function runGuard(): { status: number; output: string } {
  // A guard that hangs must fail this suite, not stall it: without a timeout a spin in the tree walk
  // blocks vitest until the job's 30-minute ceiling, which reads as infrastructure, not as a bug.
  // The budget covers two real type-checks now, which on a fixture this size are still sub-second.
  const r = spawnSync(process.execPath, [GUARD, root], { encoding: 'utf8', timeout: 180_000 });
  return { status: r.status ?? -1, output: `${r.stdout ?? ''}${r.stderr ?? ''}${r.signal ? `\nkilled by ${r.signal}` : ''}` };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sd63-p7-guard-'));
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
    expect(output).toContain('strict: true');
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

  // Bypass 7 — nothing asserted that anything invokes the guard.
  // Mutant: delete `npm run check:studio-typecheck &&` from `gate:studio`, or the `gate:studio` step
  // from ci.yml. Blast radius: every suite in the repo stays green while this entire file guards a
  // command nobody runs. Same shape, and the same assertion pair, as
  // `tests/unit/electron-quarantine.test.ts`.
  it('is gated, not documented: gate:studio chains the guard', () => {
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['check:studio-typecheck']).toContain('scripts/check-studio-typecheck-coverage.mjs');
    expect(pkg.scripts['gate:studio']).toContain('check:studio-typecheck');
  });

  it('is gated, not documented: the CI gate job runs gate:studio', () => {
    const ci = readFileSync(join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8');
    expect(ci).toMatch(/^\s*run: npm run gate:studio\s*$/m);
  });
});
