import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readHandle, type SessionHandle } from './handle.js';
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

/** `0`/`false` disables auto-launch entirely; `1`/`true` additionally opts the dev-checkout launcher in. */
const AUTO_LAUNCH_ENV = 'WIGOLO_STUDIO_AUTO_LAUNCH';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_MS = 250;

/**
 * The dev-checkout workspace holding the app. Stated ONCE because it was spelled two ways — a path
 * segment list for the existence probe and an `npm -w` argument for the spawn — which can drift apart
 * silently. This is the sibling-workspace assumption `installedSubstrateExists` exists to retire: when
 * the app ships as a distributed substrate, or moves to its own repository, this const and that
 * function are the whole coupling.
 */
const DEV_WORKSPACE = 'apps/studio';

export interface AutoLaunchDeps {
  dataDir?: string;
  /** Start the substrate. Injectable so tests never spawn a real process. */
  launch?: () => void;
  /** True when the substrate can actually be started on this machine. Injectable. */
  launchable?: () => boolean;
  timeoutMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  readHandleFn?: (dataDir?: string) => SessionHandle | null;
}

/** Repo root as seen from the built output, used to find the app workspace. */
function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/**
 * Is there a substrate this process may start on its own?
 *
 * RECORDED CEILING, and the reason auto-launch is not yet unconditional. The policy — free and prompt-less —
 * is implemented in full below. What does not exist yet is an INSTALLED substrate: until the app ships as a
 * distributable (S16-alpha) the only thing to launch is a dev checkout, and starting `npm run dev` in an
 * arbitrary repo from an agent's fetch is not something to do unasked. It also fires during this repo's own
 * test suite, which is how the constraint was found.
 *
 * So: an installed app (when one exists) launches freely; the dev checkout requires
 * `WIGOLO_STUDIO_AUTO_LAUNCH=1`. When S16-alpha lands, `installedSubstrateExists()` becomes real and the dev
 * clause stops mattering — the policy does not change, only what it can find.
 *
 * EXPORTED for the tier resolver (D-S10-2), which needs the D13 deferral answer and must not grow a second
 * probe of its own. One seam, two readers — not two seams.
 */
export function installedSubstrateExists(): boolean {
  // No installed substrate exists yet (S16-alpha). Deliberately a named seam rather than an inline `false`,
  // so the distribution work has one obvious place to land.
  return false;
}

function devCheckoutExists(): boolean {
  return existsSync(join(repoRoot(), ...DEV_WORKSPACE.split('/'), 'package.json'));
}

export function studioLaunchable(): boolean {
  if (installedSubstrateExists()) return true;
  const optIn = process.env[AUTO_LAUNCH_ENV];
  return (optIn === '1' || optIn === 'true') && devCheckoutExists();
}

/** Spawn the substrate detached and hidden, so it neither blocks nor steals focus from whatever the human is doing. */
function defaultLaunch(): void {
  const child = spawn('npm', ['run', 'dev', '-w', DEV_WORKSPACE], {
    cwd: repoRoot(),
    detached: true,
    stdio: 'ignore',
    // Hidden: an auto-launched session is for the agent's benefit, not a window the human asked for. The
    // human summons a visible one themselves; a card that needs answering is surfaced by the app.
    env: { ...process.env, WIGOLO_STUDIO_HIDDEN: '1' },
  });
  child.unref();
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
      (deps.launch ?? defaultLaunch)();
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
