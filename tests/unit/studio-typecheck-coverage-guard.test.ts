/**
 * Negative + positive tests for `scripts/check-studio-typecheck-coverage.mjs` (known issue P7).
 *
 * The guard exists because a one-line edit silently restores P7 — the gap where a file is checked by
 * nothing and every gate stays green. Its first shipped form closed three such edits (a narrowed
 * `include`, a `strict: false`, a deleted CI step) and left four more open, all confirmed at SD0
 * phase-exit:
 *
 *   4. the guard never looked at what the invoked script IS — redefining `apps/studio`'s `lint` to
 *      `true` left every other assertion true and the guard printed OK,
 *   5. the CI assertion was a raw substring over YAML, and this workflow carries the literal inside a
 *      comment, so deleting the real step kept it satisfied,
 *   6. the expected-file universe was hand-coded to `src` + `tests` + root `*.config.ts` and knew
 *      only `.ts`/`.tsx`, so `apps/studio/scripts/x.ts` or any `.mts`/`.cts` was expected by nothing
 *      and checked by nothing — P7's own failure class, one directory over,
 *   7. nothing asserted that anything invokes the guard, so deleting it from `gate:studio` made it a
 *      local command nobody runs — P7 one level up.
 *
 * A guard for that class is worthless unless it demonstrably fires on each way in, so every bypass
 * gets a must-fire case that goes red if the guard stops detecting it, plus must-not-fire cases so
 * the guard cannot pass by simply always failing.
 *
 * Cases 1–6 run against a synthetic repo root rather than the real one: the guard's whole job is to
 * notice a broken arrangement, and the real tree is (by construction) never broken. Case 7 is the
 * exception — "is this guard wired to anything" is a fact about THIS repo, so it reads this repo.
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
 * A real step annotated in place. Anchoring to a whole `run:` line without stripping comments first
 * would reject this — the step is present and correct, so the guard would be firing on a healthy
 * tree, which gets guards deleted rather than obeyed.
 */
const WORKFLOW_TRAILING_COMMENT = `name: CI
jobs:
  studio-unit:
    steps:
      - name: Lint studio (tsc --noEmit)
        run: npm run lint -w apps/studio  # do not remove — this IS the app's type-check
`;

interface Fixture {
  readonly include?: readonly string[];
  readonly strict?: boolean;
  readonly workflow?: string;
  /** Extra files to drop into `apps/studio/src` beyond the baseline one. */
  readonly extraSrc?: readonly string[];
  /** Arbitrary extra files, keyed by path relative to `apps/studio`. */
  readonly extraApp?: Readonly<Record<string, string>>;
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

  const lint = f.lintScript === undefined ? 'tsc --noEmit' : f.lintScript;
  writeFileSync(
    join(app, 'package.json'),
    JSON.stringify({ name: 'studio', scripts: { test: 'vitest run', ...(lint === null ? {} : { lint }) } }, null, 2)
  );

  writeFileSync(
    join(app, 'tsconfig.json'),
    JSON.stringify(
      { compilerOptions: { strict: f.strict ?? true, noEmit: true }, include: f.include ?? ['src', 'tests', '*.config.ts'] },
      null,
      2
    )
  );
  writeFileSync(join(root, '.github', 'workflows', 'ci.yml'), f.workflow ?? WORKFLOW_WITH_STEP);
}

function runGuard(): { status: number; output: string } {
  // A guard that hangs must fail this suite, not stall it: without a timeout a spin in the tree walk
  // blocks vitest until the job's 30-minute ceiling, which reads as infrastructure, not as a bug.
  const r = spawnSync(process.execPath, [GUARD, root], { encoding: 'utf8', timeout: 30_000 });
  return { status: r.status ?? -1, output: `${r.stdout ?? ''}${r.stderr ?? ''}${r.signal ? `\nkilled by ${r.signal}` : ''}` };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sd60-p7-guard-'));
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

  // Bypass 4 — the invoked script's identity.
  // Mutant: drop the `lint` script assertion from the guard. Blast radius: the two cases below go
  // green while `npm run lint -w apps/studio` type-checks nothing, which is P7 with every other
  // assertion in this file still true. Reproduced live in the real tree at SD0 phase-exit.
  it('fails when the `lint` script no longer type-checks — the CI step runs whatever it is', () => {
    buildFixture({ lintScript: 'true' });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('lint');
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
    // rejected it would push the next author to weaken the assertion rather than satisfy it.
    buildFixture({ lintScript: 'tsc -p tsconfig.json --noEmit' });
    const { status, output } = runGuard();
    expect(output).toContain('OK:');
    expect(status).toBe(0);
  });

  // Bypass 5 — the CI assertion was a substring over raw YAML.
  // Mutant: revert the comment-stripping + line anchoring to `raw.includes(CI_INVOCATION)`. Blast
  // radius: the case below goes green with no step invoking the app type-check at all, because the
  // comment explaining the step satisfies the check the step was supposed to.
  it('fails when the invocation survives only inside a ci.yml comment', () => {
    buildFixture({ workflow: WORKFLOW_COMMENT_ONLY });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain('npm run lint -w apps/studio');
  });

  it('accepts a real step carrying a trailing comment', () => {
    // Must-not-fire, and the case that separates the two mechanisms: line-anchoring alone rejects
    // this healthy workflow, so the comment strip is load-bearing rather than belt-and-braces.
    buildFixture({ workflow: WORKFLOW_TRAILING_COMMENT });
    const { status, output } = runGuard();
    expect(output).toContain('OK:');
    expect(status).toBe(0);
  });

  // Bypass 6 — the expected-file universe was hand-coded.
  // Mutant: narrow the walk back to `src` + `tests` + root `*.config.ts`, or drop `.mts`/`.cts` from
  // the extension set. Blast radius: the first two cases below go green while the named file is
  // expected by nothing and checked by nothing — the guard's own failure class one directory over.
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
