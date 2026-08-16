import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import globalSetup, {
  DEFAULT_STALE_MS,
  RUN_DIR_ENV,
  TEST_HOME_ROOT,
  reapStaleTestHomes,
} from '../../global-setup.js';

/**
 * The harness used to mint one throwaway HOME per test-file process and never
 * remove any of them: 73,547 directories on a developer machine, 15,950 of them
 * from the preceding 24 hours. Named by pid, and pids are reused — 2,054 held files
 * written 76-118 hours after the directory was created, i.e. a live process
 * resolving $HOME onto a dead one's state.
 *
 * These probes assert the two properties the fix has to hold SIMULTANEOUSLY, since
 * either one alone is trivial to satisfy: abandoned homes are reclaimed, and a
 * concurrently RUNNING suite's home is never touched. A reaper that deletes
 * everything passes the first and is catastrophic; the untouched-fresh-directory
 * and live-own-home probes are the must-not-fire controls that exclude it.
 */

/** Sandbox roots are grandchildren of the harness home, so nothing here is ever a
 *  direct child of TEST_HOME_ROOT and no probe can be confused with a real home. */
function sandboxParent(): string {
  const home = process.env.VITEST_WIGOLO_TEST_HOME;
  if (!home) throw new Error('harness home missing — tests/setup.ts did not run');
  return home;
}

function ageDirectory(path: string, ms: number): void {
  const stamp = new Date(Date.now() - ms);
  utimesSync(path, stamp, stamp);
}

describe('test-home lifecycle -- reaping abandoned harness homes', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(sandboxParent(), 'reap-probe-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('removes a home nothing has touched for longer than the staleness window', () => {
    const abandoned = join(root, 'home-abandoned');
    mkdirSync(join(abandoned, '.wigolo'), { recursive: true });
    writeFileSync(join(abandoned, '.wigolo', 'config.json'), '{}');
    ageDirectory(abandoned, DEFAULT_STALE_MS * 2);

    const report = reapStaleTestHomes({ root });

    expect(existsSync(abandoned)).toBe(false);
    expect(report.removed).toBe(1);
  });

  it('leaves a home whose heartbeat is fresh, so a concurrent run is never reaped', () => {
    // MUST-NOT-FIRE CONTROL. Three suites ran concurrently on this machine the day
    // the leak was found; a reaper that cannot tell them apart from garbage would
    // delete a running suite's $HOME mid-test. This is the property that rules out
    // the trivial "delete the whole root" implementation.
    const live = join(root, 'home-live');
    mkdirSync(join(live, '.wigolo'), { recursive: true });

    const report = reapStaleTestHomes({ root });

    expect(existsSync(live)).toBe(true);
    expect(report.removed).toBe(0);
    expect(report.skippedLive).toBe(1);
  });

  it('reaps only the abandoned sibling when stale and live homes share a root', () => {
    const abandoned = join(root, 'home-abandoned');
    const live = join(root, 'home-live');
    mkdirSync(abandoned, { recursive: true });
    mkdirSync(live, { recursive: true });
    ageDirectory(abandoned, DEFAULT_STALE_MS + 60_000);

    reapStaleTestHomes({ root });

    expect(existsSync(abandoned)).toBe(false);
    expect(existsSync(live)).toBe(true);
  });

  it('a home just under the staleness window survives, one just over it does not', () => {
    // Pins the boundary to the documented window rather than to "old-ish". Without
    // this, DEFAULT_STALE_MS could be silently changed to 0 and every other probe
    // here would still pass.
    const inside = join(root, 'home-inside');
    const outside = join(root, 'home-outside');
    mkdirSync(inside, { recursive: true });
    mkdirSync(outside, { recursive: true });
    ageDirectory(inside, DEFAULT_STALE_MS - 60_000);
    ageDirectory(outside, DEFAULT_STALE_MS + 60_000);

    reapStaleTestHomes({ root });

    expect(existsSync(inside)).toBe(true);
    expect(existsSync(outside)).toBe(false);
  });

  it('never follows a symlink out of the root, even an ancient one', () => {
    // The fence that protects a real ~/.wigolo. A symlinked child is the only way a
    // caller-supplied name can name a path outside the root, and an aged symlink is
    // exactly what a naive mtime check would happily delete THROUGH.
    const outside = mkdtempSync(join(sandboxParent(), 'reap-outside-'));
    const sentinel = join(outside, 'cache.db');
    writeFileSync(sentinel, 'precious');
    try {
      const link = join(root, 'home-link');
      symlinkSync(outside, link, 'dir');
      ageDirectory(root, 0);

      const report = reapStaleTestHomes({ root });

      expect(existsSync(sentinel)).toBe(true);
      expect(report.removed).toBe(0);
      expect(report.skippedNonDirectory).toBe(1);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('ignores plain files sitting in the root', () => {
    const stray = join(root, 'not-a-home.log');
    writeFileSync(stray, 'x');
    ageDirectory(stray, DEFAULT_STALE_MS * 2);

    const report = reapStaleTestHomes({ root });

    expect(existsSync(stray)).toBe(true);
    expect(report.removed).toBe(0);
  });

  it('stops at the wall-clock budget instead of stalling a run on a large backlog', () => {
    // The backlog measured on the machine was 73k directories; draining it inside
    // one globalSetup would stall the run for minutes. A budget of 0 forces the
    // ceiling deterministically rather than depending on how slow the disk is.
    for (const name of ['home-a', 'home-b', 'home-c']) {
      const dir = join(root, name);
      mkdirSync(dir, { recursive: true });
      ageDirectory(dir, DEFAULT_STALE_MS * 2);
    }

    const report = reapStaleTestHomes({ root, budgetMs: 0 });

    expect(report.budgetExhausted).toBe(true);
    expect(report.removed).toBe(0);
    expect(readdirSync(root)).toHaveLength(3);
  });

  it('is a no-op on a missing root rather than throwing', () => {
    const missing = join(root, 'does-not-exist');

    const report = reapStaleTestHomes({ root: missing });

    expect(report.removed).toBe(0);
    expect(report.scanned).toBe(0);
  });

  it('sees a run directory as fresh from the home minted inside it, with no heartbeat', () => {
    // WHY THIS IS NOT INCIDENTAL. `tests/setup.ts` deliberately does NOT write a
    // heartbeat for a test file that finishes inside the throttle window, because
    // the filesystem has already done it: minting a child advances the PARENT's
    // mtime, and every file mints its home directly inside the run directory as it
    // starts. Delete that property and the throttle silently becomes a leak of live
    // directories to a concurrent reaper, with no test to say so. No `utimesSync`
    // appears below on purpose — the refresh has to come from the mkdir alone.
    const runDir = join(root, 'run-fresh');
    mkdirSync(runDir, { recursive: true });
    ageDirectory(runDir, DEFAULT_STALE_MS * 2);
    expect(statSync(runDir).mtimeMs).toBeLessThan(Date.now() - DEFAULT_STALE_MS);

    mkdtempSync(join(runDir, 'home-'));

    expect(reapStaleTestHomes({ root }).removed).toBe(0);
    expect(existsSync(runDir)).toBe(true);
  });

  it('does not see a GRANDCHILD write as freshness, which is why the run dir is the reaped unit', () => {
    // The must-not-fire half. If a nested write refreshed the reaped unit, the
    // heartbeat could safely target the home — it cannot, and aiming it one level
    // too deep would leave the reaped unit frozen at creation time.
    const runDir = join(root, 'run-stale');
    const home = join(runDir, 'home-x');
    mkdirSync(home, { recursive: true });
    ageDirectory(runDir, DEFAULT_STALE_MS * 2);

    mkdirSync(join(home, '.wigolo'), { recursive: true });

    expect(statSync(runDir).mtimeMs).toBeLessThan(Date.now() - DEFAULT_STALE_MS);
  });
});

describe('test-home lifecycle -- run scoping and teardown', () => {
  let savedRunDir: string | undefined;

  beforeEach(() => {
    savedRunDir = process.env[RUN_DIR_ENV];
  });

  afterEach(() => {
    if (savedRunDir === undefined) delete process.env[RUN_DIR_ENV];
    else process.env[RUN_DIR_ENV] = savedRunDir;
  });

  it('publishes a fresh run directory and deletes exactly that on teardown', () => {
    const teardown = globalSetup();
    const runDir = process.env[RUN_DIR_ENV] as string;

    expect(runDir).toBeTruthy();
    expect(existsSync(runDir)).toBe(true);
    expect(dirname(runDir)).toBe(TEST_HOME_ROOT);

    // A worker's home lands inside; teardown must take it with the run directory.
    const workerHome = mkdtempSync(join(runDir, 'home-'));
    teardown();

    expect(existsSync(workerHome)).toBe(false);
    expect(existsSync(runDir)).toBe(false);
  });

  it('teardown leaves a concurrent invocation run directory untouched', () => {
    // MUST-NOT-FIRE CONTROL for the second mechanism. Teardown is scoped by
    // containment rather than age, so it must be safe to fire while another suite
    // is mid-run — the case that made a naive "empty the root" teardown unusable.
    const other = globalSetup();
    const otherRunDir = process.env[RUN_DIR_ENV] as string;

    const mine = globalSetup();
    const myRunDir = process.env[RUN_DIR_ENV] as string;
    expect(myRunDir).not.toBe(otherRunDir);

    mine();

    expect(existsSync(myRunDir)).toBe(false);
    expect(existsSync(otherRunDir)).toBe(true);
    other();
    expect(existsSync(otherRunDir)).toBe(false);
  });

  it('teardown is idempotent, so a second call cannot escalate into deleting the root', () => {
    const teardown = globalSetup();
    const runDir = process.env[RUN_DIR_ENV] as string;
    teardown();
    teardown();
    expect(existsSync(runDir)).toBe(false);
    expect(existsSync(TEST_HOME_ROOT)).toBe(true);
  });
});

describe('test-home lifecycle -- the running suite own home', () => {
  const home = process.env.VITEST_WIGOLO_TEST_HOME as string;
  const runDir = process.env[RUN_DIR_ENV];

  it('is minted inside this invocation run directory, which teardown deletes wholesale', () => {
    // Scoping by containment is what makes teardown safe to run while other suites
    // are mid-flight: it removes one directory that structurally cannot hold a
    // concurrent run's homes. If the home escaped the run directory, teardown would
    // silently stop reclaiming anything and only the 30-minute reap would be left.
    expect(home).toBeTruthy();
    expect(runDir).toBeTruthy();
    // RAW strings, deliberately. The previous spelling of this assertion wrapped both
    // sides in `resolve()` under the comment "compare resolved paths", and that is a
    // false reassurance: `resolve()` is purely LEXICAL. It normalises separators and
    // `..` segments and does not touch the filesystem, so it cannot reconcile Windows'
    // 8.3 short form with the long form. It duly reported
    // `...\RUNNER~1\...\run-lcSOqi` != `...\runneradmin\...\run-lcSOqi` — one
    // directory, two names, and the run identifier identical in both.
    //
    // Comparing the raw strings is the STRONGER claim, not a weaker one: it pins that
    // the root, the run directory and this home all share ONE spelling, which is the
    // invariant `global-setup.ts` establishes by canonicalising the root. Re-normalise
    // here and the assertion would go green again the moment that invariant broke.
    expect(dirname(home)).toBe(runDir);
  });

  it('sits under the shared root, so the staleness reap can still see it', () => {
    expect((runDir as string).startsWith(TEST_HOME_ROOT + sep)).toBe(true);
  });

  it('is not named after the pid, so a reused pid cannot alias a dead run state', () => {
    // The measured determinism hazard: 2,054 leftover homes held files written
    // 76-118 hours after creation because a new process landed on an old pid.
    expect(basename(home)).not.toBe(String(process.pid));
    expect(basename(home).startsWith('home-')).toBe(true);
  });

  it('two claims that land on the same pid get different directories', () => {
    // THE COLLISION, pinned directly rather than inferred from the name. The sharp
    // evidence for this bug was not the volume of leftover directories, it was that
    // 2,054 of them held files written 76-118 HOURS after their own birthtime —
    // i.e. two unrelated test runs sharing one $HOME, one of them reading state the
    // other left. Volume is a disk problem; this is a determinism problem, and a
    // cleanup-only fix would pass every other probe in this file while leaving it
    // wide open.
    //
    // Both schemes are replayed side by side because the assertion has to be able to
    // FAIL for the old one — a probe that only exercises the new scheme cannot show
    // that the old scheme was broken, and would pass just as happily if the fix were
    // reverted to a differently-spelled pid derivation.
    const parent = mkdtempSync(join(sandboxParent(), 'collision-'));
    try {
      const pidScheme = [join(parent, String(process.pid)), join(parent, String(process.pid))];
      expect(pidScheme[0]).toBe(pidScheme[1]);

      const mintedScheme = [
        mkdtempSync(join(parent, 'home-')),
        mkdtempSync(join(parent, 'home-')),
      ];
      expect(mintedScheme[0]).not.toBe(mintedScheme[1]);
      expect(existsSync(mintedScheme[0])).toBe(true);
      expect(existsSync(mintedScheme[1])).toBe(true);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('is tagged with the live pid, so an inherited value cannot be claimed by a child', () => {
    // The memoisation that stops `mkdtemp` minting a home per FILE should a process
    // ever evaluate the setup file twice. Measured caveat, so nobody re-derives the
    // wrong model from this test: under `isolate: true` vitest starts a fresh
    // process per test file even in the `spawn-serial` singleFork project (five
    // files produced five homes), so today the memo is a guard, not a live saving.
    // The tag names the RUNNING pid rather than recording history — a value
    // inherited by a spawned child names its parent and is correctly rejected.
    expect(process.env.VITEST_WIGOLO_TEST_HOME_PID).toBe(String(process.pid));
  });

  it('beats its heartbeat onto the directory the reaper actually ages', () => {
    // The end-to-end tie between setup.ts and global-setup.ts, asserted as the
    // TARGET rather than as freshness. Freshness is unfalsifiable here: the run
    // directory is minted seconds before this file loads, so "mtime is recent" holds
    // even if the heartbeat writes to the wrong path or is deleted outright.
    //
    // The target has to be the run directory, because that is the direct child of
    // the root whose mtime reapStaleTestHomes compares. Touching the nested home
    // instead leaves the reaped unit frozen at creation time, and a `spawn-serial`
    // fork outliving the window gets deleted out from under itself by another run.
    expect(process.env.VITEST_WIGOLO_REAP_UNIT).toBe(runDir);
    const age = Date.now() - statSync(runDir as string).mtimeMs;
    expect(age).toBeLessThan(DEFAULT_STALE_MS);
  });
});
