import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

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

  it('every ci.yml opt-out is paired with an explicit build, so the tree still gets built', () => {
    // Without the opt-out these jobs build twice — and in `lint-build-unit` the install-time
    // build lands ahead of Lint, hiding a type error behind a build failure, which is
    // precisely what that job's step order is arranged to prevent. WHICH steps carry it is
    // pinned by the cross-workflow enumeration below, not by a count here.
    expect(ci).toMatch(/WIGOLO_SKIP_PREPARE: '1'/);
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

/*
 * The opt-out is not a ci.yml concern: `prepare` fires in EVERY workflow that installs at the
 * repository root, and a text search over one file cannot see the others. So the workflows are
 * parsed and the rule is applied to every step in every one of them — which is also the only
 * shape that reds when a NEW unguarded install step is added, since a count cannot distinguish
 * "a step gained the opt-out" from "a step that needed it was added".
 */
const WORKFLOWS = join(ROOT, '.github', 'workflows');

/** A step's effective working directory: its own, else the job's `defaults.run`, else root. */
type Step = { key: string; run: string; optedOut: boolean; atRoot: boolean };

function steps(): Step[] {
  const out: Step[] = [];
  for (const file of readdirSync(WORKFLOWS).filter((f) => f.endsWith('.yml')).sort()) {
    const doc = parseYaml(readFileSync(join(WORKFLOWS, file), 'utf8')) as {
      jobs?: Record<string, { defaults?: { run?: { 'working-directory'?: string } }; steps?: unknown[] }>;
    };
    for (const [jobId, job] of Object.entries(doc.jobs ?? {})) {
      const jobDir = job.defaults?.run?.['working-directory'];
      for (const raw of job.steps ?? []) {
        const step = raw as {
          name?: string;
          run?: string;
          env?: Record<string, unknown>;
          'working-directory'?: string;
        };
        if (typeof step.run !== 'string') continue;
        const dir = step['working-directory'] ?? jobDir;
        out.push({
          key: `${file} / ${jobId} / ${step.name ?? step.run.split('\n')[0]!.trim()}`,
          run: step.run,
          optedOut: String(step.env?.WIGOLO_SKIP_PREPARE ?? '') === '1',
          atRoot: dir === undefined || dir === '.',
        });
      }
    }
  }
  return out;
}

describe('the prepare opt-out across every workflow that installs at the repo root', () => {
  /**
   * npm runs the root package's `prepare` on `npm ci`, on an argument-less `npm install`, and
   * on `npm pack` — pack most surprisingly, since nothing in the step reads like an install.
   * `npm i -g <tarball>` takes an argument and installs a different package, so it is not here.
   */
  // The lookbehind matters: `npm pack` appears inside `TGZ=$(npm pack ...)`, so anchoring on a
  // preceding space or `&&` would miss the very step this issue is about.
  const TRIGGERS_PREPARE = /(?<![\w./-])npm\s+(?:(?:ci|pack)(?![\w-])|(?:install|i)\s*$)/m;

  /** Every root-scoped step that fires the hook, and therefore must suppress it. */
  const affected = () =>
    steps()
      .filter((s) => s.atRoot && TRIGGERS_PREPARE.test(s.run))
      .sort((a, b) => a.key.localeCompare(b.key));

  it('fires on exactly these steps — a new root install step must appear here', () => {
    // A set, not a count: adding an unguarded install step reds this with its own name in the
    // diff, and deleting or renaming a guarded one reds it too.
    expect(affected().map((s) => s.key)).toEqual([
      'agent-benchmark.yml / benchmark / npm ci',
      'binary-build.yml / build / Install dependencies',
      'ci.yml / clean-machine-smoke / Install + build',
      'ci.yml / clean-machine-smoke / Pack + global install (fresh `npm i -g wigolo`)',
      'ci.yml / full-suite / npm ci',
      'ci.yml / gate / Install dependencies',
      'ci.yml / lint-build-unit / Install dependencies',
      'extraction-benchmark.yml / benchmark / npm ci',
      'release.yml / release / npm ci',
      'scrape-quality-live.yml / live-comparison / npm ci',
      'scrape-quality.yml / scrape-quality / npm ci',
      'search-benchmark.yml / benchmark / npm ci',
    ]);
  });

  it('every one of them suppresses the hook, by env or by --ignore-scripts', () => {
    // This is the assertion the whole issue is about. Removing the env from any single step
    // above names that step here.
    const unguarded = affected()
      .filter((s) => !s.optedOut && !s.run.includes('--ignore-scripts'))
      .map((s) => s.key);
    expect(unguarded).toEqual([]);
  });

  it('a job that installs somewhere other than the root is not swept in', () => {
    // Control. Without it the working-directory logic could be exempting everything and the
    // rule above would still be green. site.yml's build job sets `defaults.run.working-directory:
    // site`, so its `npm ci` installs a different package and the root hook never fires; the
    // release workflow's sub-package steps are the same shape with a per-step directory.
    const offRoot = steps().filter((s) => !s.atRoot && TRIGGERS_PREPARE.test(s.run));
    expect(offRoot.map((s) => s.key)).toContain('site.yml / build / npm ci');
    expect(offRoot.length).toBeGreaterThan(1);
    // And none of them wastes an opt-out pretending the root hook was ever in play.
    expect(offRoot.filter((s) => s.optedOut)).toEqual([]);
  });

  it('clean-machine-smoke builds the root exactly once per matrix leg', () => {
    // The job packs after it builds, and `npm pack` runs `prepare`, so before the opt-out this
    // 3-OS × Node-22/24 (+arm) matrix paid for two full builds on every leg while the comment
    // above the install step claimed it was one. Counted over parsed steps rather than read out
    // of a log, because a log impression cannot fail a suite.
    const job = steps().filter((s) => s.key.startsWith('ci.yml / clean-machine-smoke / '));
    const explicit = job.filter((s) => /npm run build/.test(s.run));
    expect(explicit).toHaveLength(1);
    const implicit = job.filter((s) => TRIGGERS_PREPARE.test(s.run) && !s.optedOut);
    expect(implicit.map((s) => s.key)).toEqual([]);
  });

  it('scrape-quality really has no build step, as its comment claims', () => {
    // The comment ("No build step: the runner executes TypeScript sources directly via tsx")
    // stopped being true the moment the root package gained a building `prepare` hook. Both
    // halves are asserted: no explicit build, and no install-time one either.
    const source = readFileSync(join(WORKFLOWS, 'scrape-quality.yml'), 'utf8');
    expect(source).toContain('No build step');
    const job = steps().filter((s) => s.key.startsWith('scrape-quality.yml / '));
    expect(job.filter((s) => /npm run build/.test(s.run))).toEqual([]);
    expect(job.filter((s) => TRIGGERS_PREPARE.test(s.run) && !s.optedOut)).toEqual([]);
  });
});

/*
 * `prepare` fires on the PUBLISH path too, and that register is invisible to the install sweep
 * above: `npm publish` packs before it uploads, and packing runs `prepare`. So the release leg
 * lints, tests, builds an explicit `dist/`, verifies the tag — and then `npm publish` rebuilds
 * `dist/` from scratch, meaning the artifact that actually reaches the registry is NOT the one
 * every gate validated. A build that flakes at that point also fails the release at publish,
 * after everything was green. Enumerated the same way as the install legs, because a text
 * search for `npm publish` cannot tell a root publish from a sub-package's own.
 */
describe('the prepare opt-out on every step that packs or publishes the ROOT package', () => {
  /**
   * The pack-shaped register. `npm publish` runs `prepack` → `prepare` → the tarball, so it
   * fires the hook exactly as `npm pack` does; `npm publish` is the one shape the install
   * register's `ci|pack|install` alternation cannot see.
   */
  const TRIGGERS_PREPARE_VIA_PACK = /(?<![\w./-])npm\s+(?:publish|pack)(?![\w-])/m;

  const packing = () =>
    steps()
      .filter((s) => s.atRoot && TRIGGERS_PREPARE_VIA_PACK.test(s.run))
      .sort((a, b) => a.key.localeCompare(b.key));

  it('packs or publishes the root on exactly these steps', () => {
    // A set, not a count, for the same reason as the install register: a new root publish or
    // pack step arrives here under its own name rather than as an off-by-one.
    expect(packing().map((s) => s.key)).toEqual([
      'ci.yml / clean-machine-smoke / Pack + global install (fresh `npm i -g wigolo`)',
      'release.yml / release / Publish wigolo (npm)',
    ]);
  });

  it('every one of them suppresses the hook, so the shipped dist/ is the validated one', () => {
    // Removing the env from the release publish step names that step here — which is the whole
    // point: the gates validate `npm run build`'s output, and only the opt-out makes the
    // tarball contain THAT build instead of a fresh one nothing checked.
    const unguarded = packing()
      .filter((s) => !s.optedOut && !s.run.includes('--ignore-scripts'))
      .map((s) => s.key);
    expect(unguarded).toEqual([]);
  });

  it('a sub-package publish is a different root and keeps its own hook', () => {
    // Control, and a deliberate non-goal. `sdks/typescript` and `packages/wigolo-vercel-ai-sdk`
    // publish from their own `working-directory`, so the ROOT `prepare` never fires for them and
    // an opt-out there would be cargo-culted noise — worse, it could suppress a hook they rely
    // on. Without this arm the working-directory logic could be exempting everything and the
    // rule above would still be green.
    const offRoot = steps().filter((s) => !s.atRoot && TRIGGERS_PREPARE_VIA_PACK.test(s.run));
    expect(offRoot.map((s) => s.key)).toEqual([
      'release.yml / release / Publish wigolo-sdk (npm)',
      'release.yml / release / Publish wigolo-vercel-ai-sdk (npm)',
    ]);
    expect(offRoot.filter((s) => s.optedOut)).toEqual([]);
  });

  it('the release leg still builds the root explicitly, exactly once', () => {
    // The opt-out is only safe because an explicit build precedes the publish. If that build
    // were ever dropped, the tarball would have no `dist/` at all — a worse failure than the
    // one this guard fixes — so the two are pinned together.
    const job = steps().filter((s) => s.key.startsWith('release.yml / release / '));
    expect(job.filter((s) => /npm run build/.test(s.run) && s.atRoot)).toHaveLength(1);
  });
});
