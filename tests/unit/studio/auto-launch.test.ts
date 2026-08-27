import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultLaunch, ensureStudioRunning, resetAutoLaunchState } from '../../../src/studio/auto-launch.js';
import { readSubstrateRecord, SUBSTRATE_RECORD } from '../../../src/studio/substrate-acquire.js';
import type { SessionHandle } from '../../../src/studio/handle.js';

/**
 * S9 — amended-D4 auto-launch.
 *
 * The ruling this implements: starting a process is not a consent event, so a clean-profile launch is free and
 * prompt-less; spending the human's identity IS, and D9's card gates that. So the tests here are about
 * mechanics rather than permission — that a launch happens at most once, that nothing hangs, and that a
 * machine with no substrate degrades to the pre-S9 decline instead of a confusing failure.
 */

let dir: string;
let originalEnv: NodeJS.ProcessEnv;

const HANDLE: SessionHandle = { id: 's1', endpoint: 'http://127.0.0.1:1/mcp', token: 't', pid: 1, instanceId: 'other' };

function publishHandle(): void {
  mkdirSync(join(dir, 'studio'), { recursive: true });
  writeFileSync(join(dir, 'studio', 'current.json'), JSON.stringify(HANDLE));
}

/**
 * Plant a valid acquisition record under an ISOLATED data dir and hand back the executable path it
 * names.
 *
 * `readSubstrateRecord` insists the executable the record names is still on disk, so writing the
 * JSON alone would read as absent and prove nothing. Unlike the ceiling suite's helper further down
 * — which must plant at `substrateRoot()`'s own memoized answer, because `studioLaunchable()` takes
 * no data dir — this one writes under the per-test temp dir, so it cannot leak a record into any
 * test that runs after it.
 */
function plantSubstrateRecord(dataDir: string): string {
  const root = join(dataDir, 'substrate');
  const componentDir = join(root, 'component');
  mkdirSync(componentDir, { recursive: true });
  const executable = join(componentDir, 'studio-app');
  writeFileSync(executable, '#!/bin/sh\nexit 0\n');
  writeFileSync(
    join(root, SUBSTRATE_RECORD),
    JSON.stringify({ version: '0.0.1', path: componentDir, executable: 'studio-app' })
  );
  return executable;
}

beforeEach(() => {
  originalEnv = process.env;
  process.env = { ...originalEnv };
  dir = mkdtempSync(join(tmpdir(), 'wig-launch-'));
  resetAutoLaunchState();
});
afterEach(async () => {
  process.env = originalEnv;
  resetAutoLaunchState();
  // `substratePresent()` memoizes for 5s, which is forever at test speed: without this, a test
  // that plants an acquisition record hands its `true` to every test that runs after it.
  const { resetSubstratePresenceCache } = await import('../../../src/studio/substrate-acquire.js');
  resetSubstratePresenceCache();
  rmSync(dir, { recursive: true, force: true });
});

const noSleep = async (): Promise<void> => {};

describe('ensureStudioRunning', () => {
  it('returns the existing handle without launching anything', async () => {
    publishHandle();
    const launch = vi.fn();
    const h = await ensureStudioRunning({ dataDir: dir, launch, launchable: () => true, sleep: noSleep });
    expect(h?.endpoint).toBe(HANDLE.endpoint);
    expect(launch).not.toHaveBeenCalled();
  });

  it('launches, then returns the handle once the host publishes one', async () => {
    // The handle is written LAST, after the host's handlers are wired, so its appearance is the only honest
    // "ready" signal — watching the child process would report ready before the gateway could answer.
    const launch = vi.fn(() => publishHandle());
    const h = await ensureStudioRunning({ dataDir: dir, launch, launchable: () => true, sleep: noSleep });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(h?.endpoint).toBe(HANDLE.endpoint);
  });

  it('is prompt-less — nothing in the module asks for a decision', async () => {
    const src = readFileSync(new URL('../../../src/studio/auto-launch.ts', import.meta.url), 'utf-8');
    expect(src).not.toMatch(/approval|confirm|prompt\(|readline/i);
  });

  it('declines when the substrate is not present, instead of shelling at an app that is not there', async () => {
    const launch = vi.fn();
    expect(await ensureStudioRunning({ dataDir: dir, launch, launchable: () => false, sleep: noSleep })).toBeNull();
    expect(launch).not.toHaveBeenCalled();
  });

  it('honours the operator kill switch', async () => {
    process.env.WIGOLO_STUDIO_AUTO_LAUNCH = '0';
    const launch = vi.fn();
    expect(await ensureStudioRunning({ dataDir: dir, launch, launchable: () => true, sleep: noSleep })).toBeNull();
    expect(launch).not.toHaveBeenCalled();
  });

  it('returns null on a launch that never publishes, rather than hanging', async () => {
    // A blocked page must not turn into a stalled tool call. The budget is bounded and the caller degrades.
    const launch = vi.fn();
    const h = await ensureStudioRunning({ dataDir: dir, launch, launchable: () => true, timeoutMs: 0, pollMs: 1, sleep: noSleep });
    expect(h).toBeNull();
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('returns null when the spawn itself throws — a launch problem is never the user-visible error', async () => {
    const launch = vi.fn(() => { throw new Error('ENOENT npm'); });
    expect(await ensureStudioRunning({ dataDir: dir, launch, launchable: () => true, sleep: noSleep })).toBeNull();
  });

  it('is SINGLE-FLIGHT: several blocked pages at once start ONE app, not one each', async () => {
    // A challenge wall usually blocks a handful of URLs in the same breath. Without this, each of them races
    // to spawn its own Electron app and the user gets a pile of windows for one wall.
    let ticks = 0;
    const launch = vi.fn(() => { /* publishes on the third poll below */ });
    const sleep = async (): Promise<void> => { if (++ticks === 3) publishHandle(); };
    const results = await Promise.all([
      ensureStudioRunning({ dataDir: dir, launch, launchable: () => true, pollMs: 1, sleep }),
      ensureStudioRunning({ dataDir: dir, launch, launchable: () => true, pollMs: 1, sleep }),
      ensureStudioRunning({ dataDir: dir, launch, launchable: () => true, pollMs: 1, sleep }),
    ]);
    expect(launch).toHaveBeenCalledTimes(1);
    for (const r of results) expect(r?.endpoint).toBe(HANDLE.endpoint);
  });

  it('a later call can launch again after the first attempt settled', async () => {
    const launch = vi.fn();
    await ensureStudioRunning({ dataDir: dir, launch, launchable: () => true, timeoutMs: 0, sleep: noSleep });
    await ensureStudioRunning({ dataDir: dir, launch, launchable: () => true, timeoutMs: 0, sleep: noSleep });
    expect(launch).toHaveBeenCalledTimes(2);
  });
});

describe('studioLaunchable — the recorded distribution ceiling', () => {
  /**
   * Plant a valid acquisition record and hand back the directory to tear down.
   *
   * `readSubstrateRecord` insists the executable the record names is still on disk, so writing
   * the JSON alone would read as absent and this helper would prove nothing — hence the stub
   * executable beside it.
   *
   * It plants at `substrateRoot()`'s OWN answer rather than under this file's per-test temp dir,
   * and the caller must remove exactly that path. `substrateRoot()` reads `getConfig().dataDir`,
   * which is memoized on first resolve — by the time any test here runs, that has already
   * happened, so setting `WIGOLO_DATA_DIR` now would move where the record is LOOKED FOR not at
   * all while moving where a naive plant WROTE it. Planting and cleaning at the same resolved
   * path is what keeps the record from outliving this test.
   */
  async function plantAcquiredSubstrate(): Promise<string> {
    const { substrateRoot, SUBSTRATE_RECORD, resetSubstratePresenceCache } = await import(
      '../../../src/studio/substrate-acquire.js'
    );
    const root = substrateRoot();
    const componentDir = join(root, 'component');
    mkdirSync(componentDir, { recursive: true });
    writeFileSync(join(componentDir, 'studio-app'), '#!/bin/sh\nexit 0\n');
    writeFileSync(
      join(root, SUBSTRATE_RECORD),
      JSON.stringify({ version: '0.0.1', path: componentDir, executable: 'studio-app' })
    );
    resetSubstratePresenceCache();
    return root;
  }

  it('is FALSE by default in a repo checkout — the test suite must not spawn a desktop app', async () => {
    // This is how the ceiling was found: with the dev launcher unconditional, a challenge-blocked fetch in
    // this repo's own suite really did try to run `npm run dev -w apps/studio` and then wait out its budget.
    // An unasked desktop launch out of someone's checkout is not acceptable.
    delete process.env.WIGOLO_STUDIO_AUTO_LAUNCH;
    const { studioLaunchable } = await import('../../../src/studio/auto-launch.js');
    expect(studioLaunchable()).toBe(false);
  });

  it('is TRUE once a substrate has been ACQUIRED — the answer is not hardwired false', async () => {
    // The outside signal, and the reason the assertions either side of it are worth anything.
    // Both of those want `false`, and a `studioLaunchable` stubbed to `return false` would satisfy
    // them forever. This is the arm that fails on that stub.
    const root = await plantAcquiredSubstrate();
    try {
      const { studioLaunchable } = await import('../../../src/studio/auto-launch.js');
      expect(studioLaunchable()).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('the opt-in env no longer manufactures a substrate — the dev-checkout rung is retired', async () => {
    // `WIGOLO_STUDIO_AUTO_LAUNCH=1` used to make a checkout launchable via `npm run dev -w
    // apps/studio`. The app is a separate repository now and consumes this package as a
    // dependency, so there is no sibling workspace to start and the opt-in half of the variable
    // went with it. What remains is the disable half, pinned by the test below.
    process.env.WIGOLO_STUDIO_AUTO_LAUNCH = '1';
    const { studioLaunchable } = await import('../../../src/studio/auto-launch.js');
    expect(studioLaunchable()).toBe(false);
  });

  it('the explicit disable still wins over the opt-in', async () => {
    process.env.WIGOLO_STUDIO_AUTO_LAUNCH = '0';
    const launch = vi.fn();
    expect(await ensureStudioRunning({ dataDir: dir, launch, launchable: () => true, sleep: noSleep })).toBeNull();
    expect(launch).not.toHaveBeenCalled();
  });
});

describe('a launch that declines must not be polled for', () => {
  /**
   * THE WINDOW THIS CLOSES. `studioLaunchable()` answers from a 5-second-memoized presence probe;
   * the launcher re-reads the record uncached. Uninstall the substrate and for the rest of that TTL
   * the two disagree: the gate says "launchable", the launcher finds nothing and declines. Before
   * this, a decline was indistinguishable from a spawn that had not published yet, so the caller
   * entered the handle poll with no process started and burned the entire 30 s budget — once per
   * TTL window, on the fetch path.
   *
   * The tick counter is the assertion, not the wall clock: a decline costs zero polls, the stall
   * costs `timeoutMs / pollMs` of them. The fake clock is what makes the difference readable in
   * milliseconds instead of thirty seconds.
   */
  it('resolves in zero poll ticks when the record is gone under a launchable that says yes', async () => {
    // Force the precondition and prove the forcing took: the launch path must genuinely find
    // nothing, or the test passes for the wrong reason.
    expect(readSubstrateRecord(dir)).toBeNull();

    vi.useFakeTimers();
    try {
      let ticks = 0;
      const sleep = async (ms: number): Promise<void> => {
        ticks += 1;
        vi.advanceTimersByTime(ms);
      };
      // No `deps.launch`: this drives the REAL launcher, which is the half of the pair that declines.
      const h = await ensureStudioRunning({ dataDir: dir, launchable: () => true, pollMs: 250, sleep });
      expect(h).toBeNull();
      expect(ticks).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still polls when the launcher did start something', async () => {
    // The other side of the branch: a decline short-circuits, a real spawn does not. Without this,
    // "return null immediately" would satisfy the test above forever.
    let ticks = 0;
    const sleep = async (): Promise<void> => { if (++ticks === 2) publishHandle(); };
    const h = await ensureStudioRunning({ dataDir: dir, launch: () => {}, launchable: () => true, pollMs: 1, sleep });
    expect(h?.endpoint).toBe(HANDLE.endpoint);
    expect(ticks).toBe(2);
  });
});

/**
 * THE REAL LAUNCHER, not an injected stand-in.
 *
 * Every case above hands `ensureStudioRunning` a `deps.launch`, which is right for testing the
 * poll contract and means this function's own body never ran in the suite: the decline, the spawn
 * target derived from the record, `detached`/`unref`, and the hidden-window env were all unasserted
 * — `WIGOLO_STUDIO_HIDDEN` appeared only in `src/`. The spawn seam is what makes running it safe.
 */
describe('defaultLaunch', () => {
  it('declines and spawns nothing when no substrate has been acquired', () => {
    const spawnFn = vi.fn();
    expect(defaultLaunch({ dataDir: dir, spawnFn })).toBe(false);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('spawns the executable the record names, hidden, detached and unreferenced', () => {
    const executable = plantSubstrateRecord(dir);
    const unref = vi.fn();
    const spawnFn = vi.fn(() => ({ unref }));

    expect(defaultLaunch({ dataDir: dir, spawnFn })).toBe(true);
    expect(spawnFn).toHaveBeenCalledTimes(1);

    const [command, args, options] = spawnFn.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
    // The target comes from the record, not from a path this module guesses at.
    expect(command).toBe(executable);
    expect(args).toEqual([]);
    // Detached, stdio ignored and unref'd: the session outlives this process and never holds it open.
    expect(options.detached).toBe(true);
    expect(options.stdio).toBe('ignore');
    expect(unref).toHaveBeenCalledTimes(1);
    // Hidden: an auto-launched session is for the agent's benefit, so it must not steal the human's focus.
    expect((options.env as NodeJS.ProcessEnv).WIGOLO_STUDIO_HIDDEN).toBe('1');
    // …and it INHERITS the rest of the environment rather than replacing it.
    expect((options.env as NodeJS.ProcessEnv).PATH).toBe(process.env.PATH);
  });

  it('declines when the record survives but the executable it names does not', () => {
    // The uninstall shape the stall came from: half the evidence is still on disk.
    const executable = plantSubstrateRecord(dir);
    rmSync(executable, { force: true });
    const spawnFn = vi.fn();
    expect(defaultLaunch({ dataDir: dir, spawnFn })).toBe(false);
    expect(spawnFn).not.toHaveBeenCalled();
  });
});

/**
 * THE ASYNCHRONOUS SPAWN FAILURE, which is a different failure from the one the suite above
 * already covers.
 *
 * `spawn()` does NOT throw for ENOENT, EACCES or EPERM. It returns a child and reports the
 * failure by emitting `'error'` on a later tick — so `ensureStudioRunning`'s try/catch, which
 * can only ever see a synchronous throw, is not in the path at all. An `'error'` event with no
 * listener is rethrown by `EventEmitter` as an uncaught exception, and this arm runs unattended
 * on the fetch path, so the blast radius is the whole MCP process rather than one request.
 *
 * `runStudio` has carried this listener since it was written (src/cli/studio.ts); this arm was
 * created without it, and the asymmetry is the defect.
 *
 * THE FAKE IS A REAL `EventEmitter` ON PURPOSE. The throw it produces with no listener attached
 * is Node's own behaviour, not a simulation of it, which is what lets a bare `expect(...)` stand
 * in for "the process would have died here" without actually killing the test runner.
 */
describe('a spawn that fails asynchronously must not kill the process', () => {
  /** A stand-in child that records the state of its own listeners at `unref()` time. */
  function fakeChild(order: string[]): EventEmitter & { unref(): void } {
    const child = new EventEmitter() as EventEmitter & { unref(): void };
    child.unref = () => order.push(`unref:errorListeners=${child.listenerCount('error')}`);
    return child;
  }

  it('attaches the error listener BEFORE unref, so there is no window', () => {
    plantSubstrateRecord(dir);
    const order: string[] = [];
    const child = fakeChild(order);

    expect(defaultLaunch({ dataDir: dir, spawnFn: vi.fn(() => child) })).toBe(true);
    // Not merely "a listener exists by the time the test looks" — it existed at the one moment
    // the launcher hands the child away and stops being able to attach anything.
    expect(order).toEqual(['unref:errorListeners=1']);
  });

  it('logs the failure and resolves null, instead of rethrowing it as an uncaught exception', async () => {
    plantSubstrateRecord(dir);
    const order: string[] = [];
    const child = fakeChild(order);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const h = await ensureStudioRunning({
        dataDir: dir,
        launch: () => defaultLaunch({ dataDir: dir, spawnFn: vi.fn(() => child) }),
        launchable: () => true,
        timeoutMs: 0,
        pollMs: 1,
        sleep: noSleep,
      });
      expect(h).toBeNull();

      // Emitted only now, and that ordering IS the bug: the failure arrives after the launcher
      // has returned, so nothing on the synchronous path can still be holding a catch for it.
      let rethrown: unknown = null;
      try {
        child.emit('error', new Error('spawn EACCES'));
      } catch (e) {
        rethrown = e;
      }
      expect(rethrown).toBeNull();
      // …and it is not swallowed either: an unattended launcher that fails silently leaves the
      // operator with a degraded rung and no reason for it.
      expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toMatch(/spawn EACCES/);
    } finally {
      stderr.mockRestore();
    }
  });
});
