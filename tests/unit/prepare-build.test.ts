import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * `scripts/prepare-build.mjs` is a two-armed decision and both arms fail FAR from their cause:
 *
 *   - the toolchain-resolvable arm regressing to false → a pinned git-dependency install
 *     produces a package with no `dist/`, and the failure surfaces at the consumer's first
 *     `import`, in a different repo, possibly weeks later;
 *   - the arm regressing to true → `Dockerfile`'s `npm ci --omit=dev` hard-exits 1 building
 *     an image, with `tsup: not found` as the whole story.
 *
 * Neither is reachable from this repo's own suites by accident, so the decision is driven
 * directly here: the real script is copied into a scratch tree under $TMPDIR whose "toolchain"
 * and whose `build` script are both fakes, and run as a subprocess exactly as npm runs it. The
 * scratch tree is what makes the absent arm testable at all — `createRequire(import.meta.url)`
 * resolves from the SCRIPT's directory, so the script has to move for its resolution to change.
 * Nothing here touches the working tree's `dist/`.
 */

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const REAL_SCRIPT = join(ROOT, 'scripts', 'prepare-build.mjs');

let scratch: string;
let script: string;

/** A resolvable stand-in for a toolchain package, with no behaviour of its own. */
function plantToolchain(name: string) {
  const dir = join(scratch, 'node_modules', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0', main: 'index.js' }));
  writeFileSync(join(dir, 'index.js'), 'module.exports = {};\n');
}

function unplantToolchain(name: string) {
  rmSync(join(scratch, 'node_modules', name), { recursive: true, force: true });
}

/**
 * The scratch package's `build`. It writes a marker instead of compiling, so "did prepare
 * build?" is a file on disk rather than an inference from log text.
 */
function plantBuild({ exitCode = 0 }: { exitCode?: number } = {}) {
  writeFileSync(
    join(scratch, 'fake-build.mjs'),
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(new URL('built.marker', import.meta.url), 'built');\nprocess.exit(${exitCode});\n`
  );
}

const marker = () => join(scratch, 'built.marker');

function runPrepare(env: Record<string, string | undefined> = {}) {
  rmSync(marker(), { force: true });
  const childEnv = { ...process.env, ...env };
  // Never inherit the operator's own opt-out into the arms that must not see it.
  if (env.WIGOLO_SKIP_PREPARE === undefined) delete childEnv.WIGOLO_SKIP_PREPARE;
  const result = spawnSync(process.execPath, [script], {
    cwd: scratch,
    encoding: 'utf8',
    env: childEnv,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    built: existsSync(marker()),
  };
}

describe('scripts/prepare-build.mjs — the git-dependency build hook', () => {
  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), 'wigolo-prepare-build-'));
    mkdirSync(join(scratch, 'scripts'), { recursive: true });
    script = join(scratch, 'scripts', 'prepare-build.mjs');
    copyFileSync(REAL_SCRIPT, script);
    writeFileSync(
      join(scratch, 'package.json'),
      JSON.stringify({
        name: 'wigolo-prepare-build-probe',
        version: '0.0.0',
        private: true,
        scripts: { build: 'node fake-build.mjs' },
      })
    );
    plantBuild();
  });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it('builds when the toolchain resolves — the git-dependency install path', () => {
    plantToolchain('tsup');
    plantToolchain('typescript');
    const run = runPrepare();
    expect(run.status).toBe(0);
    // This is the assertion that the git-dependency consumer actually depends on: `prepare`
    // is the ONLY hook npm invokes on that path, so if it does not build here, the packed
    // package has no dist/ and every `exports` subpath is unresolvable.
    expect(run.built).toBe(true);
  }, 60_000);

  it('no-ops at exit 0 when the toolchain is absent — the `--omit=dev` / Dockerfile path', () => {
    unplantToolchain('tsup');
    unplantToolchain('typescript');
    const run = runPrepare();
    expect(run.status).toBe(0);
    expect(run.built).toBe(false);
    expect(run.stdout).toMatch(/no build — toolchain unresolvable/);
    // Both names, not just one: the message is the only diagnostic a production installer gets.
    expect(run.stdout).toContain('tsup');
    expect(run.stdout).toContain('typescript');
  }, 60_000);

  it('requires the WHOLE toolchain, not any part of it', () => {
    // `npm run build` is `tsup && tsc`. A `some`-shaped guard would build with half a
    // toolchain and die inside the build instead of no-opping — which is the failure the
    // absent arm exists to avoid. Asserted from both sides so neither half is special.
    plantToolchain('tsup');
    unplantToolchain('typescript');
    const onlyTsup = runPrepare();
    expect(onlyTsup.status).toBe(0);
    expect(onlyTsup.built).toBe(false);
    expect(onlyTsup.stdout).toMatch(/toolchain unresolvable \(typescript\)/);

    unplantToolchain('tsup');
    plantToolchain('typescript');
    const onlyTsc = runPrepare();
    expect(onlyTsc.status).toBe(0);
    expect(onlyTsc.built).toBe(false);
    expect(onlyTsc.stdout).toMatch(/toolchain unresolvable \(tsup\)/);
  }, 60_000);

  it('skips the build when WIGOLO_SKIP_PREPARE is set, even with a full toolchain', () => {
    plantToolchain('tsup');
    plantToolchain('typescript');
    const run = runPrepare({ WIGOLO_SKIP_PREPARE: '1' });
    expect(run.status).toBe(0);
    expect(run.built).toBe(false);
    expect(run.stdout).toMatch(/WIGOLO_SKIP_PREPARE/);
  }, 60_000);

  it('propagates a failing build rather than swallowing it', () => {
    // The opt-out must not become a blanket exit 0. A build that fails on the
    // git-dependency path has to fail the install, or the consumer gets a partial dist/.
    plantToolchain('tsup');
    plantToolchain('typescript');
    plantBuild({ exitCode: 1 });
    const run = runPrepare();
    expect(run.status).not.toBe(0);
    plantBuild();
  }, 60_000);
});

describe('the hook and its opt-out are wired, not merely written', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');

  it('package.json runs the guarded script as `prepare`, never a bare build', () => {
    // A bare `"prepare": "npm run build"` is the regression this whole script prevents:
    // it exits 1 on `npm ci --omit=dev`, where no build is possible or wanted.
    expect(pkg.scripts.prepare).toBe('node scripts/prepare-build.mjs');
  });

  it('every ci.yml job that builds explicitly opts out of the install-time build', () => {
    // Without this, each of these jobs builds twice — and in `lint-build-unit` the
    // install-time build lands ahead of Lint, hiding a type error behind a build failure,
    // which is precisely what that job's step order is arranged to prevent.
    const optOuts = ci.match(/WIGOLO_SKIP_PREPARE: '1'/g) ?? [];
    expect(optOuts).toHaveLength(3); // lint-build-unit, full-suite, clean-machine smoke

    // And each opt-out is paired with an explicit build, so the tree still gets built.
    expect(ci).toMatch(/npm run build/);
  });

  it('the gate job opts out by NOT installing scripts, and is not double-guarded', () => {
    // The gate job needs devDependencies but must not build. It reaches that with
    // `--ignore-scripts` (asserted in tests/unit/electron-quarantine.test.ts alongside the
    // rest of that job's invariants); WIGOLO_SKIP_PREPARE is for the jobs that CANNOT use
    // `--ignore-scripts` because they need dependencies' native install scripts.
    const gate = ci.slice(ci.indexOf('\n  gate:'), ci.indexOf('\n  full-suite:'));
    expect(gate).toContain('npm ci --ignore-scripts');
    expect(gate).not.toContain('WIGOLO_SKIP_PREPARE');
  });
});
