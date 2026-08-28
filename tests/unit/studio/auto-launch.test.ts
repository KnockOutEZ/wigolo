import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { defaultLaunch, ensureStudioRunning, normalizeLaunch, resetAutoLaunchState } from '../../../src/studio/auto-launch.js';
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
    // `memoMs: 0` because this case is about `inFlight` clearing, not about the negative memo that
    // would otherwise swallow the second call — see the memo suite at the foot of this file.
    const launch = vi.fn();
    await ensureStudioRunning({ dataDir: dir, launch, launchable: () => true, timeoutMs: 0, memoMs: 0, sleep: noSleep });
    await ensureStudioRunning({ dataDir: dir, launch, launchable: () => true, timeoutMs: 0, memoMs: 0, sleep: noSleep });
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

  /**
   * THE PLANT IS CONFINED TO A DIRECTORY THIS FILE CREATED, and before this it was not.
   *
   * `substrateRoot()` takes no data dir — `studioLaunchable()` reaches it through
   * `substratePresent()`, which is why the helper above plants at its ambient answer rather than
   * under a per-test dir. That answer comes from the memoized config, so it follows
   * `WIGOLO_DATA_DIR`; and `tests/setup.ts:179` repoints that var ONLY WHEN UNSET, deliberately
   * (`:23` — "the guard respects it"). So a developer who exported the documented config knob and
   * ran `npm test` had this helper forge a record at their REAL substrate root and its caller
   * `rmSync(root, { recursive: true, force: true })` the whole directory — one the suite never
   * created. Measured on `89f423b1`: 37/37 green, exit 0, `$WIGOLO_DATA_DIR/substrate` gone with
   * everything under it. A green suite that silently uninstalls the product.
   *
   * The residue was the second half: a SIGKILL between the plant and the cleanup left a forged
   * record naming a real on-disk executable at the very path the launcher reads, passing every
   * containment check. Planting inside a temp dir puts that residue somewhere nothing consults.
   */
  it('plants and cleans inside the per-test dir even when WIGOLO_DATA_DIR names a real substrate root', async () => {
    const decoy = mkdtempSync(join(tmpdir(), 'wig-decoy-'));
    try {
      const keep = join(decoy, 'substrate', 'existing-component', 'keep.txt');
      mkdirSync(dirname(keep), { recursive: true });
      writeFileSync(keep, 'user data');

      // Force the precondition and prove the forcing took effect. `resetConfig()` is what makes
      // the export bite — the data dir is memoized on first resolve, so without it this arm would
      // assert against the harness dir and pass while the defect stood. The equality below is
      // therefore not decoration: it names the directory the UNFIXED helper plants in and deletes.
      process.env.WIGOLO_DATA_DIR = decoy;
      const { resetConfig } = await import('../../../src/config.js');
      resetConfig();
      const { substrateRoot } = await import('../../../src/studio/substrate-acquire.js');
      expect(substrateRoot()).toBe(join(decoy, 'substrate'));

      const root = await plantAcquiredSubstrate();
      try {
        expect(root).toBe(join(dir, 'substrate'));
        // …and the isolation did not buy safety by planting where nothing reads: the record is
        // still the one `studioLaunchable()` answers from. Without this the helper could satisfy
        // the arm above by writing to a directory no production path consults.
        const { studioLaunchable } = await import('../../../src/studio/auto-launch.js');
        expect(studioLaunchable()).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }

      // The user's data survived the plant AND the cleanup — the assertion the repro is for.
      expect(existsSync(keep)).toBe(true);
    } finally {
      rmSync(decoy, { recursive: true, force: true });
    }
  });
});

/**
 * THE OFF SWITCH IS A VALUE COMPARISON, and it was exact-match against two lowercase literals.
 *
 * `WIGOLO_STUDIO_AUTO_LAUNCH=False` — or `FALSE`, or `Off` — therefore read as "not disabled", and
 * the substrate was spawned detached and hidden on the fetch path against the operator's stated
 * intent. A hidden desktop process the human asked not to have is a consent surface in this design
 * language, not a preference that failed to apply.
 *
 * The house comparison is case-insensitive (`envBool`, src/config.ts), and this phase has already
 * fixed the same class twice for `WIGOLO_STUDIO_HIDDEN` (#179, #187) — those were the KEY's casing,
 * this is the VALUE's, which is the half no key-side fix reaches. `off` is honoured beyond the house
 * set because the disable half is now this variable's whole job and `off` is what an operator writes
 * for a switch; see DECISIONS-AUTO 2026-08-28 for the reversal condition.
 */
describe('the auto-launch off switch reads its value case-insensitively', () => {
  for (const spelling of ['0', 'false', 'False', 'FALSE', 'off', 'Off', 'OFF', ' false ']) {
    it(`declines when the variable is ${JSON.stringify(spelling)}`, async () => {
      process.env.WIGOLO_STUDIO_AUTO_LAUNCH = spelling;
      const launch = vi.fn();
      expect(await ensureStudioRunning({ dataDir: dir, launch, launchable: () => true, sleep: noSleep })).toBeNull();
      expect(launch).not.toHaveBeenCalled();
    });
  }

  it('LAUNCHES when the variable is unset — the switch cannot be satisfied by never launching', async () => {
    // The anti-vacuity arm. Every case above wants `null` and no launch, so a `return null` at the
    // top of `ensureStudioRunning` — or a disable predicate that answered true for an absent
    // variable — satisfies all eight of them forever.
    delete process.env.WIGOLO_STUDIO_AUTO_LAUNCH;
    const launch = vi.fn(() => publishHandle());
    const h = await ensureStudioRunning({ dataDir: dir, launch, launchable: () => true, sleep: noSleep });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(h?.endpoint).toBe(HANDLE.endpoint);
  });

  it('LAUNCHES on a value that is not an off spelling — the widening is not "any value disables"', async () => {
    // The second half of the same guard, and a different claim from the arm above: an unset
    // variable is a distinct code path from a SET one carrying an unrecognised value. `1` is the
    // retired opt-in, so it is the spelling an operator most plausibly still has exported.
    process.env.WIGOLO_STUDIO_AUTO_LAUNCH = '1';
    const launch = vi.fn(() => publishHandle());
    const h = await ensureStudioRunning({ dataDir: dir, launch, launchable: () => true, sleep: noSleep });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(h?.endpoint).toBe(HANDLE.endpoint);
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
    expect(defaultLaunch({ dataDir: dir, spawnFn }).started).toBe(false);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('spawns the executable the record names, hidden, detached and unreferenced', () => {
    const executable = plantSubstrateRecord(dir);
    const unref = vi.fn();
    const on = vi.fn();
    const spawnFn = vi.fn(() => ({ unref, on }));

    expect(defaultLaunch({ dataDir: dir, spawnFn }).started).toBe(true);
    expect(spawnFn).toHaveBeenCalledTimes(1);

    const [command, args, options] = spawnFn.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
    // The target comes from the record, not from a path this module guesses at.
    expect(command).toBe(executable);
    expect(args).toEqual([]);
    // Detached, stdio ignored and unref'd: the session outlives this process and never holds it open.
    expect(options.detached).toBe(true);
    expect(options.stdio).toBe('ignore');
    expect(unref).toHaveBeenCalledTimes(1);
    // An asynchronous spawn failure has somewhere to go — see the suite at the foot of this file
    // for why an unlistened `'error'` is a dead MCP process rather than a logged one.
    expect(on).toHaveBeenCalledWith('error', expect.any(Function));
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
    expect(defaultLaunch({ dataDir: dir, spawnFn }).started).toBe(false);
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

    expect(defaultLaunch({ dataDir: dir, spawnFn: vi.fn(() => child) }).started).toBe(true);
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

/**
 * THE DEAD SPAWN, which is the commoner half of the stall and the one the decline fix does not
 * reach.
 *
 * The listener above keeps the process alive, which was #167's whole job, but it only LOGS — and by
 * the time it fires, `defaultLaunch` has already returned "started". So `ensureStudioRunning` is
 * inside the handle poll waiting on a process that is already dead, and it waits out the entire
 * 30 s budget: 120 ticks at the shipped 250 ms cadence, once per challenged URL.
 *
 * The failure is already OBSERVED — nothing new has to be detected, only reported. The launcher's
 * return widens from a bare boolean to an outcome carrying `failed()`, and the poll reads it each
 * tick.
 */
describe('a spawn that died must not be polled for the full budget', () => {
  /** A stand-in child that can be made to report its failure on a later tick, as `spawn` does. */
  function fakeChild(): EventEmitter & { unref(): void } {
    const child = new EventEmitter() as EventEmitter & { unref(): void };
    child.unref = () => {};
    return child;
  }

  it('breaks the poll on the tick after the error listener sees the failure', async () => {
    plantSubstrateRecord(dir);
    const child = fakeChild();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.useFakeTimers();
    try {
      let ticks = 0;
      const sleep = async (ms: number): Promise<void> => {
        ticks += 1;
        // Emitted from inside the wait, not before it: an ENOENT/EACCES/EPERM spawn hands back a
        // child and reports the failure on a later tick, so the poll is already running when it
        // lands. Emitting it earlier would test a shape `spawn` never produces.
        if (ticks === 1) child.emit('error', new Error('spawn EACCES'));
        vi.advanceTimersByTime(ms);
      };
      const h = await ensureStudioRunning({
        dataDir: dir,
        launch: () => defaultLaunch({ dataDir: dir, spawnFn: vi.fn(() => child) }),
        launchable: () => true,
        // The SHIPPED budget, not a shrunken one: the stall this closes is only visible against
        // 30 s / 250 ms, and a test that pre-shrank it could not tell the fix from the timeout.
        timeoutMs: 30_000,
        pollMs: 250,
        sleep,
      });
      expect(h).toBeNull();
      // One tick to let the failure land, then out. Unbroken this is 120.
      expect(ticks).toBe(1);
    } finally {
      vi.useRealTimers();
      stderr.mockRestore();
    }
  });

  it('keeps polling a spawn that has NOT reported a failure', async () => {
    // The paired positive arm. Without it, a `failed: () => true` hardwired into the launcher — or
    // a poll that bails on the first empty read — satisfies the arm above forever.
    plantSubstrateRecord(dir);
    const child = fakeChild();
    let ticks = 0;
    const sleep = async (): Promise<void> => { if (++ticks === 4) publishHandle(); };
    const h = await ensureStudioRunning({
      dataDir: dir,
      launch: () => defaultLaunch({ dataDir: dir, spawnFn: vi.fn(() => child) }),
      launchable: () => true,
      pollMs: 1,
      sleep,
    });
    expect(h?.endpoint).toBe(HANDLE.endpoint);
    expect(ticks).toBe(4);
  });

  it('a declined launch carries no failure probe to read', async () => {
    // The decline arm still short-circuits ahead of the poll, so `failed()` is never consulted on
    // it. Pins that widening the return did not move the decline behind the new check.
    const spawnFn = vi.fn();
    const outcome = defaultLaunch({ dataDir: dir, spawnFn });
    expect(outcome.started).toBe(false);
    expect(outcome.failed()).toBe(false);
    expect(spawnFn).not.toHaveBeenCalled();
  });
});

/**
 * THE NEGATIVE MEMO, which is the per-URL half of the same stall.
 *
 * `inFlight` is single-flight, not a cache: it clears in the `finally`, so it only collapses
 * launches that OVERLAP. A crawl does not overlap — `src/fetch/router.ts` reaches the bridge rung
 * once per page, sequentially, and `src/fetch/studio-bridge.ts` awaits `ensureStudioRunning` each
 * time. Against a substrate that cannot start, 20 challenged pages therefore paid 20 separate
 * budgets: ~10 minutes of sleeping and 20 dead spawn attempts for one broken install.
 *
 * So a launch that produced no handle is remembered for ~60 s. Short on purpose: the failure modes
 * are things a human fixes in seconds (chmod +x, approve the Gatekeeper dialog, reinstall), and the
 * memo must not outlive the fix. A handle appearing invalidates it immediately, which is the arm
 * that keeps it from becoming a lockout.
 */
describe('a launch that produced no handle is remembered briefly', () => {
  it('costs the second caller zero poll ticks inside the memo window', async () => {
    vi.useFakeTimers();
    try {
      let ticks = 0;
      const sleep = async (ms: number): Promise<void> => {
        ticks += 1;
        vi.advanceTimersByTime(ms);
      };
      const launch = vi.fn();
      const args = { dataDir: dir, launch, launchable: () => true, timeoutMs: 30_000, pollMs: 250, sleep };

      // The first challenged page pays the budget in full — that part is unchanged, and has to be:
      // a wedged-but-live app really might publish on tick 119.
      expect(await ensureStudioRunning(args)).toBeNull();
      expect(ticks).toBe(120);

      // The second one is what used to cost another 120. It must not even re-spawn.
      const paid = ticks;
      expect(await ensureStudioRunning(args)).toBeNull();
      expect(ticks - paid).toBe(0);
      expect(launch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('expires, so a machine that gets fixed is retried', async () => {
    // The paired positive arm. Without it a permanent kill switch — or a bare `return null` at the
    // top of the function — satisfies the arm above forever.
    vi.useFakeTimers();
    try {
      const sleep = async (ms: number): Promise<void> => { vi.advanceTimersByTime(ms); };
      const launch = vi.fn();
      const args = { dataDir: dir, launch, launchable: () => true, timeoutMs: 0, memoMs: 60_000, sleep };

      expect(await ensureStudioRunning(args)).toBeNull();
      expect(launch).toHaveBeenCalledTimes(1);

      // Still inside the window: memoized.
      expect(await ensureStudioRunning(args)).toBeNull();
      expect(launch).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(60_001);
      expect(await ensureStudioRunning(args)).toBeNull();
      expect(launch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is invalidated by a handle appearing — a human starting the app mid-crawl recovers', async () => {
    vi.useFakeTimers();
    try {
      const sleep = async (ms: number): Promise<void> => { vi.advanceTimersByTime(ms); };
      const launch = vi.fn();
      const args = { dataDir: dir, launch, launchable: () => true, timeoutMs: 0, sleep };

      expect(await ensureStudioRunning(args)).toBeNull();
      expect(launch).toHaveBeenCalledTimes(1);

      // The human starts the app themselves, well inside the memo window. The handle read is ahead
      // of the memo check, so this call is answered rather than declined.
      publishHandle();
      expect((await ensureStudioRunning(args))?.endpoint).toBe(HANDLE.endpoint);

      // …and the memo is GONE, not merely bypassed. When that session ends the next caller launches
      // instead of being declined by a memo the recovery should have cleared.
      rmSync(join(dir, 'studio', 'current.json'), { force: true });
      expect(await ensureStudioRunning(args)).toBeNull();
      expect(launch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not memoize a launchable that says no — there was no launch to remember', async () => {
    // The memo is about launches that produced nothing, not about machines with no substrate. Those
    // already decline in zero ticks at the gate, and folding them in would mean a substrate
    // installed mid-session waited out a window for no reason.
    const launch = vi.fn();
    expect(await ensureStudioRunning({ dataDir: dir, launch, launchable: () => false, sleep: noSleep })).toBeNull();
    expect(await ensureStudioRunning({ dataDir: dir, launch, launchable: () => true, timeoutMs: 0, sleep: noSleep })).toBeNull();
    expect(launch).toHaveBeenCalledTimes(1);
  });

  /**
   * THE SECOND HALF OF THE SAME RULE, and the one the gate arm above could not reach.
   *
   * `launchable() === false` is not the only way to reach "nothing was started": the LAUNCHER
   * declines too, and `defaultLaunch`'s own docstring calls that a NORMAL outcome rather than a
   * defect — `substratePresent()` memoizes for 5 s while the launcher re-reads the record uncached,
   * so for the rest of that TTL the gate says yes and the launcher finds nothing. That decline
   * arrives back through the shared promise as a bare `null`, indistinguishable there from a launch
   * that ran and timed out, so it was remembered for 60 s: reinstall the substrate one second later
   * and the fixed machine is declined without a spawn attempt — the exact lockout the memo's
   * docstring says it must not become.
   */
  it('does not memoize a LAUNCHER decline — a substrate reinstalled a tick later is retried', async () => {
    vi.useFakeTimers();
    try {
      let ticks = 0;
      const sleep = async (ms: number): Promise<void> => {
        ticks += 1;
        vi.advanceTimersByTime(ms);
      };
      // Force the precondition and prove the forcing took: no `deps.launch`, so this is the REAL
      // launcher declining against an empty data dir, not a stand-in shaped like one.
      expect(readSubstrateRecord(dir)).toBeNull();
      expect(await ensureStudioRunning({ dataDir: dir, launchable: () => true, pollMs: 250, sleep })).toBeNull();
      expect(ticks).toBe(0);

      // The human reinstalls, well inside the 60 s window. There is no handle yet, so the read at
      // the top cannot be what rescues this call — only an un-set memo can.
      const launch = vi.fn(() => { publishHandle(); });
      const h = await ensureStudioRunning({ dataDir: dir, launch, launchable: () => true, timeoutMs: 0, sleep });
      expect(launch).toHaveBeenCalledTimes(1);
      expect(h?.endpoint).toBe(HANDLE.endpoint);
    } finally {
      vi.useRealTimers();
    }
  });

  it('memoMs: 0 is honoured at the READ as well as the write — the escape hatch gets its attempt', async () => {
    // The docstring calls `0` "the escape hatch for a caller that genuinely wants every attempt",
    // and a write-only reading of it makes that false: a default caller's memo declines the
    // opted-out caller for the rest of the window. Honoured at the read, the promise holds.
    vi.useFakeTimers();
    try {
      const sleep = async (ms: number): Promise<void> => { vi.advanceTimersByTime(ms); };
      const launch = vi.fn();
      const args = { dataDir: dir, launch, launchable: () => true, timeoutMs: 0, sleep };

      // A launch that really ran and produced no handle is STILL remembered — the paired positive
      // arm, without which "never memoize" would satisfy every case here.
      expect(await ensureStudioRunning(args)).toBeNull();
      expect(await ensureStudioRunning(args)).toBeNull();
      expect(launch).toHaveBeenCalledTimes(1);

      expect(await ensureStudioRunning({ ...args, memoMs: 0 })).toBeNull();
      expect(launch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('pins the shipped default window — long enough to spare one fan-out, short enough not to lock out', async () => {
    // The constant is load-bearing and was unpinned: every arm above passes `memoMs` explicitly, so
    // `DEFAULT_NO_HANDLE_MEMO_MS` could be raised to an hour with the suite still green — turning
    // the memo into the lockout its own comment forbids. Asserted through behaviour rather than by
    // reading the constant, so it pins what the number DOES.
    vi.useFakeTimers();
    try {
      const sleep = async (ms: number): Promise<void> => { vi.advanceTimersByTime(ms); };
      const launch = vi.fn();
      // No `memoMs`: this is the shipped default and nothing else.
      const args = { dataDir: dir, launch, launchable: () => true, timeoutMs: 0, sleep };

      expect(await ensureStudioRunning(args)).toBeNull();
      expect(launch).toHaveBeenCalledTimes(1);

      // Just inside: still remembered, so one fan-out pays the budget once.
      vi.advanceTimersByTime(59_000);
      expect(await ensureStudioRunning(args)).toBeNull();
      expect(launch).toHaveBeenCalledTimes(1);

      // Just outside: retried, so a machine fixed by hand recovers in about a minute.
      vi.advanceTimersByTime(1_500);
      expect(await ensureStudioRunning(args)).toBeNull();
      expect(launch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * WHAT COUNTS AS AN OUTCOME.
 *
 * `normalizeLaunch` tolerates three legacy shapes because `deps.launch` is a test seam: `false` is
 * the decline, `true`/`void` is "started, no failure reporting". What it must NOT do is read any
 * object as an outcome. An async launcher hands back a Promise, whose `.started` is `undefined` —
 * falsy — so the launch was reported as a DECLINE on the same tick the real body started running:
 * the poll never ran, the handle was never read, and the caller was told nothing had been started
 * while a process was on its way up. TypeScript rejects the shape at the seam, which is what keeps
 * this latent, but a seam whose whole job is to be faked in tests must fail loudly rather than
 * silently agree.
 */
describe('normalizeLaunch rejects a shape it cannot honestly read', () => {
  it('throws on a thenable instead of reading it as a decline', () => {
    const thenable = Promise.resolve({ started: true, failed: () => false });
    expect(() => normalizeLaunch(thenable as never)).toThrow(/thenable|asynchronous/i);
  });

  it('throws on an object that is not a LaunchOutcome', () => {
    expect(() => normalizeLaunch({ launched: true } as never)).toThrow(/LaunchOutcome/);
  });

  it('still reads all three legacy shapes', () => {
    expect(normalizeLaunch(false).started).toBe(false);
    expect(normalizeLaunch(true).started).toBe(true);
    expect(normalizeLaunch(undefined).started).toBe(true);
    expect(normalizeLaunch({ started: true, failed: () => true }).failed()).toBe(true);
  });

  it('an async launcher resolves null without pretending it declined, and is not remembered', async () => {
    // Through the real entry point: `ensureStudioRunning` never throws, so the loud error becomes a
    // null — but it must not leave a memo behind, because nothing was established about the machine.
    const launch = vi.fn(async () => ({ started: true, failed: () => false }));
    const args = { dataDir: dir, launchable: () => true, timeoutMs: 0, sleep: noSleep };

    expect(await ensureStudioRunning({ ...args, launch: launch as never })).toBeNull();
    const started = vi.fn();
    expect(await ensureStudioRunning({ ...args, launch: started })).toBeNull();
    expect(started).toHaveBeenCalledTimes(1);
  });

  /**
   * `started` WAS VALIDATED AND `failed` WAS NOT, and the asymmetry is the defect. `failed` is
   * merged with `??`, which only replaces a NULLISH value — so a truthy non-function survives
   * normalization and is called by the poll, and the poll's first `failed()` sits OUTSIDE the
   * try/catch that guards the launcher call. The TypeError therefore rejects the shared promise,
   * whose `.then` memo mapper has no rejection branch, and `await inFlight` rethrows it into
   * `studioBridgeFetch` — which awaits with no catch. So a bad fake at the seam becomes the
   * user's fetch error, breaking the "never throws" contract in the one place the seam exists to
   * be exercised.
   */
  it('throws on an object whose `failed` is not callable', () => {
    // The plausible misreading: storing the ERROR the spawn reported instead of a probe of it.
    expect(() => normalizeLaunch({ started: true, failed: {} } as never)).toThrow(/failed/);
    expect(() => normalizeLaunch({ started: true, failed: true } as never)).toThrow(/failed/);
    // Nullish stays legal — that is the documented `true`/`void` legacy shape arriving as an object.
    expect(normalizeLaunch({ started: true } as never).failed()).toBe(false);
  });

  it('a non-callable `failed` resolves null through the fetch path rather than rejecting, and is not remembered', async () => {
    // END-TO-END, because the rejection this pins does NOT happen in `normalizeLaunch`: it happens
    // at the poll's first `failed()` call, one tick past the try/catch, and only the real entry
    // point puts those two in the same path. Nothing was started that anyone waited for, so per
    // A-185-2 the attempt must not be memoized either — the next caller gets its own launch.
    const launch = vi.fn(() => ({ started: true, failed: {} }));
    const args = { dataDir: dir, launchable: () => true, timeoutMs: 0, sleep: noSleep };

    await expect(ensureStudioRunning({ ...args, launch: launch as never })).resolves.toBeNull();
    expect(launch).toHaveBeenCalledTimes(1);

    const started = vi.fn();
    expect(await ensureStudioRunning({ ...args, launch: started })).toBeNull();
    expect(started).toHaveBeenCalledTimes(1);
  });
});

/**
 * THE HIDDEN FLAG SURVIVES A CASE-INSENSITIVE PARENT, which is not the same claim as "the flag is
 * set" that `defaultLaunch`'s spawn arm already makes.
 *
 * The spread collapses win32's case-insensitive env proxy into a plain object, so an inherited
 * `wigolo_studio_hidden=0` leaves TWO keys in the options and the child — reading through ITS proxy
 * — resolves whichever the OS hands back first. A window can then surface for a session that exists
 * only to serve the agent, and in this design language a surfaced window is a consent surface rather
 * than cosmetics. `runStudio` already strips case-insensitively for the mirror-image reason (it wants
 * the flag GONE); this arm wants it canonical, and both need the same mechanism.
 */
describe('defaultLaunch sets the hidden flag once, whatever casing the parent carried', () => {
  it('leaves exactly one key case-insensitively equal to WIGOLO_STUDIO_HIDDEN, set to 1', () => {
    plantSubstrateRecord(dir);
    // Force the precondition — a parent that already carries the flag in another casing, saying the
    // OPPOSITE thing — and assert below that the forcing took effect rather than trusting it.
    process.env.wigolo_studio_hidden = '0';
    const spawnFn = vi.fn(() => ({ unref: vi.fn(), on: vi.fn() }));

    expect(defaultLaunch({ dataDir: dir, spawnFn }).started).toBe(true);
    const env = (spawnFn.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }])[2].env;

    const hidden = Object.keys(env).filter((k) => k.toUpperCase() === 'WIGOLO_STUDIO_HIDDEN');
    expect(hidden).toEqual(['WIGOLO_STUDIO_HIDDEN']);
    expect(env.WIGOLO_STUDIO_HIDDEN).toBe('1');
    // The strip is narrow: everything else is still inherited.
    expect(env.PATH).toBe(process.env.PATH);
  });
});
