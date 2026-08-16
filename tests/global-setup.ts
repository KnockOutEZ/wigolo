import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

/**
 * Lifecycle for the throwaway HOME trees that `tests/setup.ts` mints.
 *
 * THE DEFECT. `tests/setup.ts` repoints $HOME at a directory under this root so the
 * suite can never write to a developer's real `~/.wigolo`. That isolation is
 * load-bearing and stays. What was missing is the other half: nothing ever removed
 * those directories. Measured on this machine before the fix — 73,547 directories,
 * 15,950 of them created in the preceding 24 hours (~36/min), and a separate
 * reclaim earlier the same day had already freed 43 GB. Under vitest's `forks`
 * pool with `isolate: true` each TEST FILE runs in its own process, so a full suite
 * mints roughly one directory per test file and abandons every one of them.
 *
 * A second defect rode along. The directories were named after `process.pid`, and
 * pids are reused: 2,054 of the 73,547 held files written 76-118 HOURS after the
 * directory itself was created — a later, unrelated process inheriting a dead one's
 * state. That is a determinism hazard, not just clutter, so the name is now minted
 * by `mkdtemp` (see `tests/setup.ts`) and no longer aliases.
 *
 * TWO MECHANISMS, BECAUSE ONE IS NOT ENOUGH.
 *
 * 1. RUN SCOPING (the common case). Setup mints one `run-*` directory per vitest
 *    invocation and publishes it; every worker mints its own home INSIDE it. The
 *    teardown then deletes that single directory, which by construction contains
 *    exactly this run's homes and none of a concurrent run's. No registry and no
 *    bookkeeping — the scope is structural.
 *
 *    A per-worker `process.on('exit')` hook was implemented first and MEASURED not
 *    to fire at all: vitest's `forks` pool terminates workers with a signal rather
 *    than letting them exit, so a 31-file suite still left 31 directories behind
 *    with the hook installed. It was removed rather than left in as decoration.
 *
 * 2. STALENESS REAP (the crash case). Teardown does not run if the main process is
 *    SIGKILLed, OOM-killed, or dies hard — and those are exactly the paths that
 *    produced the 73k backlog. So each invocation also reclaims abandoned
 *    directories left by earlier runs. Crash-safe by construction: it does not care
 *    HOW a directory was abandoned, only that nothing has touched it lately.
 *
 * WHY STALENESS RATHER THAN A LIVENESS PROBE.
 * Three suites ran concurrently on this machine today, so the reaper must never
 * delete a directory a running suite still owns. `process.kill(pid, 0)` is the
 * obvious probe and is WRONG here for the same reason the naming was: with pid
 * reuse an unrelated live process makes a dead suite's directory look owned
 * forever. POSIX `flock` would be authoritative and is released by the kernel on
 * death, but Node exposes it only via `O_EXLOCK` on macOS/BSD — this suite gates
 * on three OSes, so it is not available.
 *
 * What is left is a heartbeat: `tests/setup.ts` touches the run directory's mtime
 * from `beforeEach` (throttled to 30s). "Alive" therefore means "made test progress
 * recently", which is the property that actually matters, and it needs no timer and
 * no event-loop liveness.
 *
 * THE WINDOW IS IDLE TIME, NOT RUN TIME — and that distinction is the whole reason
 * this is safe. A reaper whose window had to exceed the longest legitimate run would
 * be a worse defect than the leak it fixes: it would delete a live directory
 * intermittently, under load, and the failure would surface as unrelated ENOENTs in
 * whatever subsystem happened to touch disk next. `DEFAULT_STALE_MS` is therefore
 * NOT a ceiling on how long a suite may run. A six-hour run refreshes its mtime
 * every 30 seconds and is never eligible; what has to elapse is 30 minutes with no
 * test making progress, against vitest ceilings of 20s per test and 20s per hook.
 * The heartbeat is the mechanism; the window is only how long a corpse stays warm.
 * If that ever stops holding, lengthen the heartbeat's reach — do not widen this.
 *
 * WHAT THIS DOES NOT COVER.
 *  - A run wedged for >30 minutes with a fully blocked event loop runs no
 *    `beforeEach`, so a concurrent reap could take its run directory.
 *    `ensureTestDataDir()` re-creates the tree on the next hook, so it self-heals,
 *    but an in-flight write inside that window can fail. Narrow, and strictly
 *    better than the status quo.
 *  - A SIGKILLed run leaves its directory until the NEXT run's reap notices it is
 *    30 minutes cold. Reclaim is eventual, not immediate.
 *  - Garbage only drains when a suite next runs. This is not a daemon.
 *  - The budget is deliberate: a huge pre-existing backlog drains over several
 *    runs rather than stalling one of them for minutes.
 *  - Sibling temp trees that are NOT under this root (`wigolo-test-empty-*` and
 *    friends from `mkdtempSync` inside individual tests, and the hardcoded
 *    `/tmp/wigolo-test*` dataDirs some suites mock) are a different leak and are
 *    deliberately out of reach — see the fence in `reapStaleTestHomes`.
 *
 * NO `src/` EDGES. This module imports node builtins only. `tests/setup.ts`
 * imports it statically, and that is safe for exactly the reason `net-fence.ts` is:
 * a static `src/` import there hoists above the env assignments and poisons the
 * config cache, while a leaf module cannot.
 */

/**
 * The one directory this module is ever allowed to delete inside. Shared with
 * `tests/setup.ts` so the mint site and the reap site cannot drift apart.
 */
export const TEST_HOME_ROOT = join(tmpdir(), 'wigolo-test');

/**
 * Where this invocation's per-worker homes live. Published to workers through the
 * environment, which is the only channel that survives the fork boundary AND
 * vitest's per-file module-registry reset.
 */
export const RUN_DIR_ENV = 'VITEST_WIGOLO_RUN_DIR';

/** No test progress for this long => the owning process is gone. */
export const DEFAULT_STALE_MS = 30 * 60 * 1000;

/** Wall-clock ceiling for one reap, so a large backlog never stalls a run. */
export const DEFAULT_BUDGET_MS = 2_000;

export interface ReapOptions {
  root?: string;
  staleMs?: number;
  budgetMs?: number;
}

export interface ReapReport {
  root: string;
  scanned: number;
  removed: number;
  skippedLive: number;
  skippedNonDirectory: number;
  failed: number;
  budgetExhausted: boolean;
}

/**
 * The safety fence. Only a direct child of `root` may be removed, and only when
 * the dirent itself is a real directory.
 *
 * `Dirent.isDirectory()` is decided by lstat semantics, so a SYMLINK to a
 * directory answers false here and is never followed — which is what stops a
 * planted `wigolo-test/evil -> ~/.wigolo` (a real 750 MB user cache) from being
 * deleted through this path. The prefix re-check is belt-and-braces on top: it
 * makes "never outside the root" a checkable predicate rather than a property
 * inferred from readdir's behaviour, and it is what the fence test asserts.
 */
function isReapable(root: string, name: string): boolean {
  const resolvedRoot = resolve(root);
  const candidate = resolve(resolvedRoot, name);
  const prefix = resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep;
  return candidate.startsWith(prefix) && candidate !== resolvedRoot;
}

/**
 * Remove abandoned test homes under `root`. Never throws: a reaper that can fail a
 * test run is worse than the leak it fixes.
 */
export function reapStaleTestHomes(options: ReapOptions = {}): ReapReport {
  const root = options.root ?? TEST_HOME_ROOT;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;

  const report: ReapReport = {
    root,
    scanned: 0,
    removed: 0,
    skippedLive: 0,
    skippedNonDirectory: 0,
    failed: 0,
    budgetExhausted: false,
  };

  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    // Root absent on a clean machine, or unreadable. Nothing to do either way.
    return report;
  }

  const startedAt = Date.now();
  const cutoff = startedAt - staleMs;

  for (const entry of entries) {
    // Checked BEFORE the stat, so the ceiling bounds the scan and not just the
    // deletes — with a 73k backlog the stat loop alone outruns the budget.
    if (Date.now() - startedAt >= budgetMs) {
      report.budgetExhausted = true;
      break;
    }

    if (!entry.isDirectory() || !isReapable(root, entry.name)) {
      report.skippedNonDirectory++;
      continue;
    }

    const path = join(root, entry.name);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      // Vanished under us — another concurrent reaper got there first.
      continue;
    }

    report.scanned++;
    if (mtimeMs > cutoff) {
      report.skippedLive++;
      continue;
    }

    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 1 });
      report.removed++;
    } catch {
      report.failed++;
    }
  }

  return report;
}

/**
 * Vitest global setup. Runs ONCE per invocation in the main process, before any
 * worker forks — so the scan happens once rather than once per test file, and every
 * directory minted afterwards is younger than the cutoff by construction.
 *
 * The returned teardown deletes this run's directory and nothing else. It is scoped
 * by containment rather than by age, so it is safe to run while other suites are
 * mid-flight: a concurrent run's homes are simply not inside it.
 */
export default function setup(): () => void {
  reapStaleTestHomes();

  let runDir: string | undefined;
  try {
    mkdirSync(TEST_HOME_ROOT, { recursive: true });
    runDir = mkdtempSync(join(TEST_HOME_ROOT, 'run-'));
    process.env[RUN_DIR_ENV] = runDir;
  } catch {
    // Workers fall back to minting directly under the root; the staleness reap
    // still reclaims them. Losing the fast path must not fail the run.
    delete process.env[RUN_DIR_ENV];
  }

  return () => {
    if (!runDir) return;
    try {
      rmSync(runDir, { recursive: true, force: true, maxRetries: 1 });
    } catch {
      // Falls through to the next run's staleness reap.
    }
  };
}
