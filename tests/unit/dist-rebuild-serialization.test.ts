import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * THE RACE THIS GUARDS.
 *
 * A handful of tests rebuild `dist/`, and tsup's `clean: true` DELETES it before writing
 * anything. A handful of others read or spawn `dist/` — `tests/e2e/mcp-startup.test.ts` spawns
 * `dist/index.js`, `tests/integration/build-output.test.ts` asserts over dist/ files,
 * `tests/integration/studio-runs-proxy.test.ts` imports dist/ in a child process.
 *
 * Those two sets are only safe together while they are all in the SAME vitest project, and
 * that project is `spawn-serial` — one fork, `fileParallelism: false`, so they take turns.
 * Vitest runs the `unit` project CONCURRENTLY with `spawn-serial`, so a dist/-rebuilding test
 * in `unit` can delete `dist/` out from under a serial test that has just spawned it. The
 * result is an intermittent red in an unrelated file with nothing pointing at the cause —
 * exactly the kind that gets retried away rather than fixed. It shipped once, in
 * `tests/unit/budget-protocol.test.ts`, when the `prepare` hook turned the G-TARBALL
 * measurement's `npm pack --dry-run` into a full build.
 *
 * So the convention is asserted rather than remembered: nothing in the parallel lane may
 * rebuild `dist/`.
 */

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Ways a test can end up rebuilding the working tree's `dist/`. `npm pack` and
 * `scripts/budget/measure.mjs` are on the list because both run the `prepare` lifecycle hook,
 * which builds — `npm pack` does so even under `--dry-run` and even under `--ignore-scripts`.
 */
const REBUILD_TOKENS = ['npm run build', 'npm pack', 'npx tsup', 'budget/measure.mjs'];

/**
 * Parallel-lane files that name a token without rebuilding anything. Each entry states WHY,
 * and the set is asserted to be exactly the set that still matches — a stale exemption is a
 * failure, so this cannot rot into a blanket mute.
 */
const EXEMPT: Record<string, string> = {
  'tests/unit/dist-rebuild-serialization.test.ts':
    'this file — it names every token in order to search for them',
  'tests/unit/budget-protocol.test.ts':
    'reads measure.mjs as TEXT to assert which reducer it calls; never executes it',
  'tests/unit/prepare-build.test.ts':
    'runs a copy of the prepare hook against a scratch tree under $TMPDIR, with a fake toolchain and a marker-writing `build`; the working tree is never touched',
};

const toPosix = (p: string) => p.split(sep).join('/');

/**
 * Every test file under `tests/`, repo-relative and posix-shaped. A hand-rolled walk rather
 * than `fs.globSync`, which does not exist on Node 20 — this suite runs across 20/22/24 and a
 * guard that silently throws on the oldest of them is not a guard.
 */
function allTestFiles(dir = 'tests'): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const child = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...allTestFiles(child));
    else if (/\.test\.tsx?$/.test(entry.name)) out.push(toPosix(child));
  }
  return out.sort();
}

/** The `unit` project's glob: every test outside the serial lane. */
function parallelLaneFiles(): string[] {
  return allTestFiles().filter(
    (p) => !p.startsWith('tests/integration/') && !p.startsWith('tests/e2e/')
  );
}

describe('no parallel-lane test can rebuild or clean dist/', () => {
  const offenders = parallelLaneFiles().filter((file) =>
    REBUILD_TOKENS.some((token) => readFileSync(join(ROOT, file), 'utf8').includes(token))
  );

  it('the parallel lane is clean apart from the stated exemptions', () => {
    expect(offenders.filter((f) => !(f in EXEMPT))).toEqual([]);
  });

  it('every exemption is still load-bearing', () => {
    // An exemption that no longer matches anything is a claim nobody checks. Drop it, or the
    // next real offender inherits its cover.
    expect(Object.keys(EXEMPT).filter((f) => !offenders.includes(f))).toEqual([]);
  });

  it('the serial lane is where the dist/ touchers actually live', () => {
    // The other half of the invariant: it is not enough that the parallel lane is empty; the
    // known touchers have to be somewhere serialised, or one of them was quietly deleted.
    const touchers = [
      'tests/integration/budget-tarball-gate.test.ts', // rebuilds: npm pack -> prepare -> build
      'tests/integration/build-output.test.ts', // rebuilds: explicit `npm run build` in beforeAll
      'tests/e2e/mcp-startup.test.ts', // rebuilds on demand, then spawns dist/index.js
      'tests/integration/studio-runs-proxy.test.ts', // reads dist/ from a child process
    ];
    const present = allTestFiles();
    for (const file of touchers) {
      expect(present).toContain(file);
      expect(file.startsWith('tests/integration/') || file.startsWith('tests/e2e/')).toBe(true);
    }
  });
});

describe('the serial lane is actually serial', () => {
  // The guard above is worth nothing if `spawn-serial` stops being one fork with file
  // parallelism off, because then the touchers race EACH OTHER instead.
  const config = readFileSync(join(ROOT, 'vitest.config.ts'), 'utf8');
  const serial = config.slice(config.indexOf("name: 'spawn-serial'"));

  it('runs the integration + e2e globs in a single non-parallel fork', () => {
    expect(serial).toContain("'tests/integration/**/*.test.ts'");
    expect(serial).toContain("'tests/e2e/**/*.test.ts'");
    expect(serial).toContain("pool: 'forks'");
    expect(serial).toContain('singleFork: true');
    expect(serial).toContain('fileParallelism: false');
  });

  it('the unit project excludes exactly that lane, so the two never overlap', () => {
    const unit = config.slice(config.indexOf("name: 'unit'"), config.indexOf("name: 'contract'"));
    expect(unit).toContain("'tests/integration/**'");
    expect(unit).toContain("'tests/e2e/**'");
  });

  it('names the dist/ race in the config, so the split is not undone as tidying', () => {
    expect(config).toMatch(/dist\//);
  });
});
