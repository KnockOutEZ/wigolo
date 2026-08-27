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

export interface AutoLaunchDeps {
  dataDir?: string;
  /**
   * Start the substrate. Injectable so tests never spawn a real process.
   *
   * Returning `false` means DECLINED — nothing was started, so there is nothing to wait for. Any
   * other return (including `void`) means a start was attempted and the handle poll is worth
   * running. See {@link defaultLaunch} for why a launcher that answered `launchable` can still
   * decline.
   */
  launch?: () => boolean | void;
  /** True when the substrate can actually be started on this machine. Injectable. */
  launchable?: () => boolean;
  timeoutMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  readHandleFn?: (dataDir?: string) => SessionHandle | null;
}

/**
 * The narrowest shape of `child_process.spawn` this module uses. Narrow ON PURPOSE: a test seam
 * that had to build a whole `ChildProcess` would be a mock of Node rather than of the one call
 * being made, and the launcher only ever needs to unreference what it started.
 */
export type SpawnStudio = (
  command: string,
  args: readonly string[],
  options: SpawnOptions
) => { unref(): void };

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
 * ⚠ THE DECLINE IS RETURNED, and that return is load-bearing. `studioLaunchable()` answers from
 * `substratePresent()`, which memoizes for 5 s; this function reads the record uncached. Uninstall the
 * substrate and for the rest of that TTL window the gate says yes and the launcher finds nothing —
 * so a decline here is a NORMAL outcome, not a defect. When it was a bare `return`, the caller could
 * not tell it apart from a spawn that had yet to publish and sat out the entire 30 s poll budget with
 * no process running, once per TTL window, on the fetch path. Saying "declined" costs one boolean and
 * closes the window; widening the presence TTL or plumbing a shared probe would both reach further
 * than this file.
 */
export function defaultLaunch(deps: DefaultLaunchDeps = {}): boolean {
  const acquired = readSubstrateRecord(deps.dataDir);
  if (!acquired) {
    log.debug('studio auto-launch found no acquired substrate to start — declining');
    return false;
  }
  // Hidden: an auto-launched session is for the agent's benefit, not a window the human asked for. The
  // human summons a visible one themselves; a card that needs answering is surfaced by the app.
  const hidden = { ...process.env, WIGOLO_STUDIO_HIDDEN: '1' };
  const child = (deps.spawnFn ?? defaultSpawn)(join(acquired.path, acquired.executable), [], {
    detached: true,
    stdio: 'ignore',
    env: hidden,
  });
  child.unref();
  return true;
}

let inFlight: Promise<SessionHandle | null> | null = null;

/**
 * Return a live session handle, starting the substrate if it is not running. Returns null when auto-launch is
 * disabled, the substrate is absent, or it did not publish a handle inside the budget — never throws, because
 * every caller has a degraded path and a launch problem must not become the user's error.
 */
export async function ensureStudioRunning(deps: AutoLaunchDeps = {}): Promise<SessionHandle | null> {
  const read = deps.readHandleFn ?? readHandle;
  const existing = read(deps.dataDir);
  if (existing) return existing;

  if (process.env[AUTO_LAUNCH_ENV] === '0' || process.env[AUTO_LAUNCH_ENV] === 'false') return null;
  if (!(deps.launchable ?? studioLaunchable)()) {
    log.debug('studio substrate not launchable on this machine — declining auto-launch');
    return null;
  }

  if (inFlight) return inFlight;
  inFlight = (async () => {
    const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); if (typeof t.unref === 'function') t.unref(); }));
    try {
      const started = (deps.launch ?? (() => defaultLaunch({ dataDir: deps.dataDir })))();
      // An explicit decline means nothing was started, so there is nothing the poll below could ever
      // see. Waiting out the budget on it is the 30 s stall this branch exists to prevent.
      if (started === false) {
        log.debug('studio auto-launch declined — nothing was started, so nothing is polled for');
        return null;
      }
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
      if (Date.now() >= deadline) {
        log.debug('studio auto-launch did not publish a handle within budget');
        return null;
      }
      await sleep(pollMs);
    }
  })();
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

/** Test seam: drop a memoized in-flight launch between cases. */
export function resetAutoLaunchState(): void {
  inFlight = null;
}
