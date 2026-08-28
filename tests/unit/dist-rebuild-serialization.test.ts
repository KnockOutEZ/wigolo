import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import vitestConfig from '../../vitest.config.js';

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
 * So the convention is asserted rather than remembered — and in BOTH directions, because the
 * race needs only one side of it to be in the wrong lane:
 *
 *   - nothing in the parallel lane may REBUILD `dist/` (the original half), and
 *   - nothing in the parallel lane may hand a `dist/` path to a CHILD PROCESS (the half added
 *     for #176, after two broker specs sat in `unit` spawning `dist/daemon/studio-db-broker.js`
 *     while the serial lane deleted it for ~300ms per rebuild).
 *
 * Lane membership below is READ FROM `vitest.config.ts`, never re-derived from a directory
 * prefix: the serial lane now contains named `tests/unit/**` files as well as the whole
 * integration + e2e trees, and a guard that assumed the prefix would quietly stop covering them.
 */

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Ways a test can end up rebuilding the working tree's `dist/`. `npm pack` and
 * `scripts/budget/measure.mjs` are on the list because both run the `prepare` lifecycle hook,
 * which builds — `npm pack` does so even under `--dry-run` and even under `--ignore-scripts`.
 */
const REBUILD_TOKENS = ['npm run build', 'npm pack', 'npx tsup', 'budget/measure.mjs'];

/**
 * A token handed to a child-process API. This is the shape that actually rebuilds, as opposed
 * to a file that merely names a build command in a comment or an assertion — and it is checked
 * even in exempted files, so an exemption granted for a mention cannot later cover a real
 * rebuild that gets added underneath it.
 */
const EXECUTES = new RegExp(
  `(?:execSync|execFileSync|spawnSync|execFile|spawn|exec)\\s*\\(` +
    `[^;]{0,200}?(?:${REBUILD_TOKENS.map((t) => t.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|')})`,
  's'
);

/**
 * Parallel-lane files that NAME a token without rebuilding anything. Each entry states WHY,
 * and the set is asserted to be exactly the set that still matches — a stale exemption is a
 * failure, so this cannot rot into a blanket mute. Note what an exemption does and does not
 * buy: it excuses the mention, never an `EXECUTES` match.
 */
const EXEMPT: Record<string, string> = {
  'tests/unit/dist-rebuild-serialization.test.ts':
    'this file — it names every token in order to search for them',
  'tests/unit/budget-protocol.test.ts':
    'reads measure.mjs as TEXT to assert which reducer it calls; never executes it',
  'tests/unit/electron-quarantine.test.ts':
    'asserts that the CI gate job has NO build step; the token appears inside that negative assertion',
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

interface ProjectShape {
  test: {
    name?: string;
    include?: string[];
    exclude?: string[];
    pool?: string;
    maxWorkers?: number;
    fileParallelism?: boolean;
  };
}

/** A project's own `test` block, straight out of the real config object — not a text match on it. */
function project(name: string): ProjectShape['test'] {
  const projects = (vitestConfig.test?.projects ?? []) as unknown as ProjectShape[];
  const found = projects.find((p) => p.test?.name === name);
  if (!found) throw new Error(`vitest.config.ts has no project named ${name}`);
  return found.test;
}

/**
 * The subset of glob syntax the two project globs actually use: `**\/` for any depth, `*` within a
 * segment, and bare paths. Deliberately not a glob library — the guard must state what it matches.
 */
function globToRegExp(pattern: string): RegExp {
  const body = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\/|\*\*|\*/g, (m) =>
      m === '**/' ? '(?:.*/)?' : m === '**' ? '.*' : '[^/]*'
    );
  return new RegExp(`^${body}$`);
}

const matchesAny = (patterns: string[] | undefined, file: string): boolean =>
  (patterns ?? []).some((p) => globToRegExp(p).test(file));

/** Files vitest gives the serial lane, per the config's own include list. */
function serialLaneFiles(): string[] {
  return allTestFiles().filter((p) => matchesAny(project('spawn-serial').include, p));
}

/** Everything else — the fully-parallel `unit` project. */
function parallelLaneFiles(): string[] {
  const serial = new Set(serialLaneFiles());
  return allTestFiles().filter((p) => !serial.has(p));
}

describe('no parallel-lane test can rebuild or clean dist/', () => {
  const scanned = parallelLaneFiles().map((file) => {
    const source = readFileSync(join(ROOT, file), 'utf8');
    return {
      file,
      mentions: REBUILD_TOKENS.some((token) => source.includes(token)),
      executes: EXECUTES.test(source),
    };
  });
  const offenders = scanned.filter((f) => f.mentions).map((f) => f.file);

  it('the parallel lane is clean apart from the stated exemptions', () => {
    expect(offenders.filter((f) => !(f in EXEMPT))).toEqual([]);
  });

  it('no parallel-lane file hands a build to a child process, exempt or not', () => {
    // The exemptions above are for files that NAME a build command — in a comment, or inside
    // an assertion about CI's shape. None of them may grow a real one later under that cover.
    expect(scanned.filter((f) => f.executes).map((f) => f.file)).toEqual([]);
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
    const serial = serialLaneFiles();
    for (const file of touchers) {
      expect(present).toContain(file);
      expect(serial).toContain(file);
    }
  });
});

/**
 * A `dist` path written as a string literal with no spaces in it — the shape a spawn can actually
 * resolve, as opposed to prose that happens to name the directory. Two narrowings do that work, and
 * both were measured against this tree rather than guessed:
 *
 *   - no spaces, so an `it()` title like `'…the shipped dist/ is the validated one'` is not a path
 *     (`tests/unit/prepare-build.test.ts` has exactly that one);
 *   - whole-line comments are dropped first (`codeOnly`), so a doc block quoting
 *     `["dist", "rust/*.node"]` is not a path either (`scripts/prune/wreq-binaries.mjs` has that).
 *
 * That is why this scan carries no exemption list: an exemption is what you need when the pattern
 * cannot tell prose from code, and narrowing the pattern beats maintaining a list of apologies.
 */
const DIST_PATH = /['"][^'"\n ]*\bdist(?:\/[^'"\n ]*)?['"]/;

/** Source with whole-line comments removed. Not a parser — a line that is only prose cannot spawn. */
const codeOnly = (source: string): string =>
  source
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
    .join('\n');

/** Any child-process API call — the thing that turns a resolved `dist/` path into a race. */
const SPAWNS = /(?:execSync|execFileSync|spawnSync|execFile|spawn|fork|exec)\s*\(/;

/** A relative script path a test names, resolved and kept only if it is really on disk. */
const LOCAL_SCRIPT = /['"](\.[^'"\n]*\.(?:mjs|cjs|js))['"]/g;

/**
 * Scripts a test file hands to a child process. A fixture is where the indirection bites:
 * `tests/unit/studio/run-store-disk-projection.test.ts` spawns
 * `fixtures/run-store-exit-drain-child.mjs`, and it is the FIXTURE that imports `dist/`. The
 * spawner's own source never says `dist`, so a scan of test files alone would call it clean while
 * its child died to the very same rebuild.
 */
function spawnedScripts(file: string, source: string): string[] {
  const base = join(ROOT, dirname(file));
  const out: string[] = [];
  for (const match of source.matchAll(LOCAL_SCRIPT)) {
    const abs = resolve(base, match[1]);
    if (existsSync(abs)) out.push(toPosix(relative(ROOT, abs)));
  }
  return out;
}

describe('no parallel-lane test can spawn a dist/ path', () => {
  // The reader half of the race (#176). `dist/` is absent for the whole of a tsup `clean: true`
  // rebuild — measured at ~300ms on this tree — and a spawn that lands in that window exits 1 with
  // a module-not-found. The rebuilders were already serialised; the readers were not, so two broker
  // specs in `unit` spawned `dist/daemon/studio-db-broker.js` straight into it, and one of them
  // then burned a 40s beforeAll hook timeout on a child that would never say `ready`.
  const readers = parallelLaneFiles().filter((file) => {
    const source = codeOnly(readFileSync(join(ROOT, file), 'utf8'));
    if (!SPAWNS.test(source)) return false;
    return (
      DIST_PATH.test(source) ||
      spawnedScripts(file, source).some((s) =>
        DIST_PATH.test(codeOnly(readFileSync(join(ROOT, s), 'utf8')))
      )
    );
  });

  it('the parallel lane spawns nothing out of dist/', () => {
    expect(readers).toEqual([]);
  });

  it('the known dist/ spawners are in the serial lane', () => {
    // Must-fire direction, and the reason the list is named rather than counted: a spawner that is
    // deleted or renamed has to be noticed here, not silently drop out of the scan above.
    const spawners = [
      'tests/unit/studio/broker-transport.test.ts', // spawns dist/daemon/studio-db-broker.js
      'tests/unit/studio/run-store-restart.test.ts', // spawns dist/daemon/studio-db-broker.js
      'tests/unit/studio/run-store-disk-projection.test.ts', // its fixture imports dist/ in a child
      'tests/integration/studio-runs-proxy.test.ts', // imports dist/ in a child process
      'tests/e2e/mcp-startup.test.ts', // spawns dist/index.js
    ];
    const present = allTestFiles();
    const serial = serialLaneFiles();
    for (const file of spawners) {
      expect(present).toContain(file);
      expect(serial).toContain(file);
    }
  });

  it('the two lanes partition the suite — no file is in both, none in neither', () => {
    // The scan above is only a guard while `parallelLaneFiles()` really is the complement of the
    // serial lane. If the `unit` project stopped excluding a serialised file, that file would run
    // in BOTH projects and the race would be back with the guard still green.
    const unit = project('unit');
    for (const file of serialLaneFiles()) {
      expect({ file, excludedFromUnit: matchesAny(unit.exclude, file) }).toEqual({
        file,
        excludedFromUnit: true,
      });
    }
    for (const file of parallelLaneFiles()) {
      expect({
        file,
        runsInUnit: matchesAny(unit.include, file) && !matchesAny(unit.exclude, file),
      }).toEqual({ file, runsInUnit: true });
    }
  });
});

describe('the serial lane is actually serial', () => {
  // The guard above is worth nothing if `spawn-serial` stops being one fork with file
  // parallelism off, because then the touchers race EACH OTHER instead.
  // Text, for the one claim that is about the config as a DOCUMENT rather than as options.
  const config = readFileSync(join(ROOT, 'vitest.config.ts'), 'utf8');

  it('runs the integration + e2e globs in a single non-parallel worker', () => {
    // Read off the config OBJECT, not its text. The text form of this assertion outlived the
    // option it named: `poolOptions.forks.singleFork` was removed in vitest 4 — the string
    // `singleFork` appears nowhere in 4.1.6 — so a `toContain('singleFork: true')` went on passing
    // against a line that configured nothing. A structural read cannot do that: an option vitest
    // does not have is an option this test cannot find.
    const lane = project('spawn-serial');
    expect(lane.include).toContain('tests/integration/**/*.test.ts');
    expect(lane.include).toContain('tests/e2e/**/*.test.ts');
    expect(lane.pool).toBe('forks');
    expect(lane.maxWorkers).toBe(1);
    expect(lane.fileParallelism).toBe(false);
  });

  it('the unit project excludes exactly that lane, so the two never overlap', () => {
    const unit = project('unit');
    expect(unit.exclude).toContain('tests/integration/**');
    expect(unit.exclude).toContain('tests/e2e/**');
  });

  it('names the dist/ race in the config, so the split is not undone as tidying', () => {
    expect(config).toMatch(/dist\//);
  });
});
