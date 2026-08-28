import { spawn, type SpawnOptions } from 'node:child_process';
import { join } from 'node:path';
import { readHandle, type SessionHandle } from './handle.js';
import { readSubstrateRecord, substratePresent } from './substrate-acquire.js';
import { createLogger } from '../logger.js';

const log = createLogger('studio');

/**
 * S9 — amended-D4 AUTO-LAUNCH.
 *
 * > Clean-profile auto-launch is free and prompt-less. Spending the human's identity is the consent event,
 * > and D9's grant card is what gates that.
 *
 * The reasoning behind "free": starting a process is not a consent event, and wigolo already starts a browser
 * lazily on the fetch path without treating it as one. A session opened this way uses an in-memory partition —
 * a clean profile — so nothing of the human's is spent by the launch itself. The moment the agent tries to
 * drive an origin the human is signed in to, D9's card fires. Same machinery, different trigger.
 *
 * There is no `studio_unavailable` outcome any more: a caller that needs the substrate asks for it, and either
 * gets a live handle or a decline it can degrade around.
 *
 * TWO THINGS DELIBERATELY CONSTRAIN IT:
 *  - It only fires when there is a substrate it may start — see `studioLaunchable` for the recorded ceiling
 *    on what that means before the app is distributed. An absent substrate declines silently, which is the
 *    pre-S9 behaviour, because shelling at an app that is not there trades a clean decline for a confusing
 *    failure.
 *  - It is SINGLE-FLIGHT. A page that fails the challenge ladder tends to fail it for several URLs at once,
 *    and each of those would otherwise race to spawn its own app. One in-flight launch is shared by all of
 *    them.
 */

/**
 * `0`/`false` disables auto-launch entirely.
 *
 * It used to have a second job — `1`/`true` opted the dev-checkout launcher in — which retired with the
 * studio repo split: there is no `apps/studio` beside this package to opt into any more. The disable half
 * is the whole variable now, and it is still load-bearing (this repo's own suite sets it).
 */
const AUTO_LAUNCH_ENV = 'WIGOLO_STUDIO_AUTO_LAUNCH';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_MS = 250;

/**
 * How long a launch that produced no handle is remembered.
 *
 * SHORT ON PURPOSE. Every failure mode behind it is one a human fixes in seconds — `chmod +x`, an
 * approved Gatekeeper dialog, a reinstall, starting the app by hand — so the memo must not outlive
 * the fix. Long enough that one fan-out pays the timeout once; short enough that the next fan-out
 * re-checks. A handle appearing invalidates it immediately, which is what keeps it a memo rather
 * than a lockout, so this number only bounds the no-signal case.
 */
const DEFAULT_NO_HANDLE_MEMO_MS = 60_000;

/**
 * What a launcher reports back, and the reason it is not a bare boolean.
 *
 * A boolean can only answer "did I attempt a start", which leaves the caller blind to the failure
 * that arrives AFTER the attempt: `spawn` reports ENOENT/EACCES/EPERM by emitting `'error'` on a
 * later tick, so by then the launcher has returned `true` and the handle poll is already running
 * against a process that is already dead. That failure is observed — the listener {@link
 * defaultLaunch} must attach anyway sees it — it just had nowhere to be reported to. `failed()` is
 * that somewhere: a probe the poll reads each tick.
 */
export interface LaunchOutcome {
  /** False means DECLINED — nothing was started, so there is nothing to wait for. */
  started: boolean;
  /** True once the spawn has reported an asynchronous failure. Polled, not awaited. */
  failed: () => boolean;
}

export interface AutoLaunchDeps {
  dataDir?: string;
  /**
   * Start the substrate. Injectable so tests never spawn a real process.
   *
   * Returning `false` means DECLINED — nothing was started, so there is nothing to wait for. Any
   * other return (including `void`) means a start was attempted and the handle poll is worth
   * running. A {@link LaunchOutcome} says both, and additionally lets the poll give up early on a
   * start that has since died. See {@link defaultLaunch} for why a launcher that answered
   * `launchable` can still decline.
   */
  launch?: () => boolean | void | LaunchOutcome;
  /** True when the substrate can actually be started on this machine. Injectable. */
  launchable?: () => boolean;
  timeoutMs?: number;
  pollMs?: number;
  /**
   * How long a launch that produced no handle is remembered. `0` disables the memo — the shape the
   * pre-memo suite asserts, and the escape hatch for a caller that genuinely wants every attempt.
   */
  memoMs?: number;
  sleep?: (ms: number) => Promise<void>;
  readHandleFn?: (dataDir?: string) => SessionHandle | null;
}

/**
 * The narrowest shape of `child_process.spawn` this module uses. Narrow ON PURPOSE: a test seam
 * that had to build a whole `ChildProcess` would be a mock of Node rather than of the one call
 * being made.
 *
 * It carries `on('error')` as well as `unref()` because the launcher genuinely needs both, not
 * because a `ChildProcess` happens to have them: an error listener is the only way to observe a
 * spawn that fails asynchronously (see {@link defaultLaunch}), so a seam without it cannot
 * express the launcher's real contract and a fake built against it would be green while the
 * production path crashed. Still one function, still two methods, still trivially fake-able.
 */
export type SpawnStudio = (
  command: string,
  args: readonly string[],
  options: SpawnOptions
) => {
  unref(): void;
  on(event: 'error', listener: (err: Error) => void): void;
};

const defaultSpawn: SpawnStudio = (command, args, options) => spawn(command, args, options);

export interface DefaultLaunchDeps {
  /** Where the acquisition record lives. Defaults to the configured data dir. */
  dataDir?: string;
  /** Injectable so a test asserts the spawn arms without starting a desktop app. */
  spawnFn?: SpawnStudio;
}

/**
 * Is there a substrate this process may start on its own?
 *
 * RECORDED CEILING, and the reason auto-launch is not unconditional. The policy — free and prompt-less —
 * is implemented in full below; what constrains it is whether anything is actually installed.
 *
 * THE DEV-CHECKOUT RUNG IS GONE. It existed because the app used to sit at `apps/studio` inside this
 * repo, so `npm run dev -w apps/studio` was a substrate a checkout could start — gated behind
 * `WIGOLO_STUDIO_AUTO_LAUNCH=1` because starting it unasked from an agent's fetch is not acceptable, and
 * because it fired during this repo's own suite (which is how the ceiling was found in the first place).
 * The studio app now lives in its own repository and consumes this package as a dependency, so there is
 * no sibling workspace left to probe: the rung could only ever answer false. This is exactly the
 * retirement `installedSubstrateExists` was written to absorb, and it needs no replacement — an installed
 * substrate launches freely, and nothing else is launchable.
 *
 * EXPORTED for the tier resolver (D-S10-2), which needs the D13 deferral answer and must not grow a second
 * probe of its own. One seam, two readers — not two seams.
 *
 * S10-d MADE THIS REAL (D-S10-3). It is no longer a hardcoded `false`: it answers from the acquisition
 * record, and the record is only written after the executable it names has been probed on disk. The two
 * halves that meet here are exactly D-S10-3's split — S10 acquires and records, S16-alpha publishes the
 * artifact that gets acquired — so this function needs no further change when distribution lands.
 *
 * ⚠ It reads the RECORD, never the substrate directory. A directory that happens to exist proves nothing:
 * it can be a half-extracted archive or the leavings of an interrupted install, and treating it as an
 * installed substrate is how a machine ends up deferring acquisition (D13) in favour of a rung that cannot
 * start. The record is written last, which makes its presence the only honest "installed" signal — the same
 * reasoning that makes `ensureStudioRunning` poll for the session handle rather than watch the child.
 */
export function installedSubstrateExists(): boolean {
  return substratePresent();
}

export function studioLaunchable(): boolean {
  return installedSubstrateExists();
}

/**
 * Spawn the substrate detached and hidden, so it neither blocks nor steals focus from whatever the human is
 * doing.
 *
 * THE ACQUISITION RECORD IS THE ONLY SUBSTRATE. It used to be one of two — the other being a
 * `npm run dev -w apps/studio` in a sibling workspace — and the record won when both were present. The
 * split retired the other one (see `studioLaunchable`), so what is left is a single path.
 *
 * The record is still re-read here rather than trusted from the `studioLaunchable()` call above: nothing
 * holds a lock between the two, and `deps.launchable` is injectable, so this function must be able to
 * find nothing. It declines rather than throwing, for the same reason `ensureStudioRunning` never throws —
 * a launch problem must not become the caller's error.
 *
 * ⚠ THIS RETURN IS LOAD-BEARING, AND IT CLOSES TWO DIFFERENT WINDOWS — one each, by a different
 * mechanism. Unreported, both end the same way: `ensureStudioRunning` enters the handle poll and
 * waits out the full 30 s budget for a handle no live process will ever write, on the fetch path.
 *
 *  1. NOTHING WAS STARTED — closed by `started: false`. `studioLaunchable()` answers from
 *     `substratePresent()`, which memoizes for 5 s; this function reads the record uncached.
 *     Uninstall the substrate and for the rest of that TTL window the gate says yes and the launcher
 *     finds nothing, so a decline here is a NORMAL outcome rather than a defect. Reported, the caller
 *     skips the poll entirely and pays zero ticks. Widening the presence TTL or plumbing a shared
 *     probe would both reach further than this file.
 *  2. SOMETHING WAS STARTED AND DIED — closed by `failed()`. `spawn` does not throw for ENOENT,
 *     EACCES or EPERM; it hands back a child and emits `'error'` on a later tick, by which point
 *     this function has already returned "started". The listener below has to exist regardless — an
 *     unlistened `'error'` is a dead MCP process, not a logged one — so the failure is already
 *     observed, and `failed()` is only what carries it to the poll. The poll reads the probe each
 *     tick and gives up on the tick after the failure lands instead of on tick 120. This is the
 *     commoner real-world shape: a lost +x bit, a Gatekeeper EPERM, an uninstall mid-crawl.
 *
 * Neither reaches the residual case — a start that neither declines nor errors and simply never
 * publishes, i.e. a genuinely wedged app. That one is bounded by the timeout and then REMEMBERED, so
 * a fan-out pays it once rather than per URL; see the negative memo in `ensureStudioRunning`.
 */
export function defaultLaunch(deps: DefaultLaunchDeps = {}): LaunchOutcome {
  const acquired = readSubstrateRecord(deps.dataDir);
  if (!acquired) {
    log.debug('studio auto-launch found no acquired substrate to start — declining');
    return { started: false, failed: () => false };
  }
  // Hidden: an auto-launched session is for the agent's benefit, not a window the human asked for. The
  // human summons a visible one themselves; a card that needs answering is surfaced by the app.
  const hidden = { ...process.env, WIGOLO_STUDIO_HIDDEN: '1' };
  const child = (deps.spawnFn ?? defaultSpawn)(join(acquired.path, acquired.executable), [], {
    detached: true,
    stdio: 'ignore',
    env: hidden,
  });
  // BEFORE `unref`, and before this function returns — there must be no tick in which the child
  // exists with nobody listening.
  //
  // `spawn()` does not throw for ENOENT, EACCES or EPERM. It hands back a child and reports the
  // failure by EMITTING `'error'` on a later tick, so `ensureStudioRunning`'s try/catch — which
  // can only see a synchronous throw — never gets the chance. An `'error'` with no listener is
  // rethrown by `EventEmitter` as an uncaught exception, and this arm runs unattended on the
  // fetch path, so what dies is the whole MCP process rather than one request. `runStudio` has
  // had this listener since it was written; this arm was created without it.
  //
  // The window is narrow — the record's executable was probed on disk at read time — but it is
  // real: an uninstall between the read and the exec, a lost +x bit, or a Gatekeeper EPERM.
  let spawnFailed = false;
  child.on('error', (err) => {
    spawnFailed = true;
    log.warn('studio auto-launch could not start the desktop component', {
      error: err instanceof Error ? err.message : String(err),
    });
  });
  child.unref();
  return { started: true, failed: () => spawnFailed };
}

const NEVER_FAILED = (): boolean => false;

/**
 * Read any launcher's answer as a {@link LaunchOutcome}.
 *
 * The three legacy shapes stay legal because `deps.launch` is a test seam and most of the suite has
 * no interest in spawn failures: `false` is the decline, `true`/`void` is "started, no failure
 * reporting". Only a launcher that actually spawns something can say more, and only `defaultLaunch`
 * does.
 */
export function normalizeLaunch(result: boolean | void | LaunchOutcome): LaunchOutcome {
  if (result === false) return { started: false, failed: NEVER_FAILED };
  if (result && typeof result === 'object') {
    return { started: result.started, failed: result.failed ?? NEVER_FAILED };
  }
  return { started: true, failed: NEVER_FAILED };
}

let inFlight: Promise<SessionHandle | null> | null = null;

/**
 * When the last launch that produced no handle stops being remembered. `0` means nothing to remember.
 *
 * `inFlight` IS NOT THIS. Single-flight only collapses launches that OVERLAP — it clears in the
 * `finally` — and a crawl does not overlap: `src/fetch/router.ts` reaches the bridge rung once per
 * page, sequentially, and `src/fetch/studio-bridge.ts` awaits `ensureStudioRunning` each time. So
 * against a substrate that cannot start, 20 challenged pages paid 20 separate budgets: ~10 minutes
 * of sleeping and 20 dead spawn attempts for one broken install. The memo is what makes a fan-out
 * pay it once.
 */
let noHandleUntil = 0;

/**
 * Return a live session handle, starting the substrate if it is not running. Returns null when auto-launch is
 * disabled, the substrate is absent, a recent launch produced no handle, or this one did not publish a handle
 * inside the budget — never throws, because every caller has a degraded path and a launch problem must not
 * become the user's error.
 */
export async function ensureStudioRunning(deps: AutoLaunchDeps = {}): Promise<SessionHandle | null> {
  const read = deps.readHandleFn ?? readHandle;
  const existing = read(deps.dataDir);
  if (existing) {
    // AHEAD OF THE MEMO CHECK, and it clears it: a handle on disk is direct evidence that whatever
    // stopped the last launch has been resolved — most often a human who started the app by hand
    // mid-crawl. Remembering a failure past its own disproof is a lockout, not a memo.
    noHandleUntil = 0;
    return existing;
  }

  if (process.env[AUTO_LAUNCH_ENV] === '0' || process.env[AUTO_LAUNCH_ENV] === 'false') return null;
  if (!(deps.launchable ?? studioLaunchable)()) {
    log.debug('studio substrate not launchable on this machine — declining auto-launch');
    return null;
  }
  // AFTER the launchable gate, so an absent substrate is never what gets remembered: that case
  // already declines in zero ticks, and folding it in would make a substrate installed mid-session
  // wait out a window for no reason.
  if (noHandleUntil > Date.now()) {
    log.debug('studio auto-launch recently produced no handle — declining without re-launching');
    return null;
  }

  if (inFlight) return inFlight;
  const memoMs = deps.memoMs ?? DEFAULT_NO_HANDLE_MEMO_MS;
  inFlight = (async () => {
    const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); if (typeof t.unref === 'function') t.unref(); }));
    let failed: () => boolean;
    try {
      const outcome = normalizeLaunch((deps.launch ?? (() => defaultLaunch({ dataDir: deps.dataDir })))());
      // An explicit decline means nothing was started, so there is nothing the poll below could ever
      // see. Waiting out the budget on it is the 30 s stall this branch exists to prevent.
      if (!outcome.started) {
        log.debug('studio auto-launch declined — nothing was started, so nothing is polled for');
        return null;
      }
      failed = outcome.failed;
    } catch (err) {
      log.debug('studio auto-launch failed to spawn', { error: err instanceof Error ? err.message : String(err) });
      return null;
    }
    // Poll for the handle rather than watching the child: the handle is written LAST, after the host's
    // handlers are wired, so its appearance is the only honest "ready" signal.
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const h = read(deps.dataDir);
      if (h) return h;
      // Checked AFTER the handle read, because a spawn can both publish and then error, and a
      // published handle is the answer the caller wanted either way. Checked BEFORE the deadline
      // because that is the whole point: a dead process is knowable now, and the alternative is
      // 120 more ticks of waiting for a handle nothing will write.
      if (failed()) {
        log.debug('studio auto-launch spawned a process that failed to start — abandoning the handle poll');
        return null;
      }
      if (Date.now() >= deadline) {
        log.debug('studio auto-launch did not publish a handle within budget');
        return null;
      }
      await sleep(pollMs);
    }
  })().then((handle) => {
    // Recorded on the SHARED promise rather than in the first caller's `await` below: the other
    // single-flight participants return `inFlight` directly and never reach that code, so putting it
    // there would leave the memo down for whoever happened not to be first.
    if (!handle && memoMs > 0) noHandleUntil = Date.now() + memoMs;
    return handle;
  });
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

/** Test seam: drop a memoized in-flight launch and the negative memo between cases. */
export function resetAutoLaunchState(): void {
  inFlight = null;
  noHandleUntil = 0;
}
