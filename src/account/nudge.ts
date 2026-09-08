/**
 * `<dataDir>/account/nudge.json` — the counter behind the ONE registration
 * nudge (PX brief §0a.2: "one nudge after N successful runs, never repeated").
 *
 * WHY IT IS A FILE AND NOT A PROCESS COUNTER. The surfaces that produce a
 * successful run are mostly short-lived — a one-shot `wigolo search`, an MCP
 * server the harness restarts every session. A counter in memory would reset
 * before it ever reached N on the CLI, and would reach N once per session on
 * MCP, i.e. it would either never fire or fire forever. "Never repeated" is a
 * property of the disk or it is not a property at all.
 *
 * WHY COUNTING AND CLAIMING ARE TWO CALLS. `recordSuccessfulRun` is called by
 * every tool-dispatch seam, including the daemon's REST surface — which has no
 * channel to print a nudge into. `takeRegistrationNudge` is called only by the
 * surfaces that can actually render one, and it is the call that burns the
 * once-only flag. Splitting them is what keeps a REST-heavy user's runs
 * counting toward a nudge they will see on their next CLI or MCP call, instead
 * of silently spending the single nudge on a surface with nowhere to put it.
 *
 * WHY THE FLAG IS WRITTEN BEFORE THE CALLER RENDERS. `takeRegistrationNudge`
 * persists `nudged: true` and THEN returns true. If the render fails the user
 * loses one nudge; if the order were reversed a crash between render and write
 * would repeat it, and §0a.2's word is "never". Losing a nudge is a nudge; the
 * other way round is a nag.
 *
 * NOTHING HERE IS SECRET, and unlike `state.json` this file carries no email —
 * but it is written 0600 into the same 0700 directory anyway, because the
 * directory is already that and a second mode in one place is a question
 * somebody has to answer later.
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createLogger } from '../logger.js';

const log = createLogger('account');

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/**
 * How many successful runs before the single nudge.
 *
 * Five, chosen so it lands after the user has seen wigolo work rather than
 * during their first look at it — a nudge on run one is an install prompt
 * wearing a footer, and a nudge at fifty is one nobody reaches. Recorded with
 * its reversal condition in DECISIONS-AUTO (A-336-2).
 */
export const NUDGE_AFTER_RUNS = 5;

export interface NudgeState {
  /** Successful tool runs seen on this install, across every surface. */
  successful_runs: number;
  /** True once the single nudge has been handed to a surface to render. */
  nudged: boolean;
}

export const EMPTY_NUDGE_STATE: Readonly<NudgeState> = Object.freeze({
  successful_runs: 0,
  nudged: false,
});

export function nudgeStatePath(dataDir: string): string {
  return join(dataDir, 'account', 'nudge.json');
}

/**
 * The store. Every method is TOTAL: a corrupt file, an unwritable disk or a
 * read-only data dir degrades to "no nudge", never to a thrown error — this
 * sits on the tail of every successful tool call, and a footer is not allowed
 * to be the reason a result never reaches its caller.
 */
export class NudgeStore {
  private readonly path: string;

  constructor(dataDir: string) {
    this.path = nudgeStatePath(dataDir);
  }

  read(): NudgeState {
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<NudgeState>;
      const runs = typeof raw.successful_runs === 'number' && Number.isFinite(raw.successful_runs)
        ? Math.max(0, Math.floor(raw.successful_runs))
        : 0;
      return { successful_runs: runs, nudged: raw.nudged === true };
    } catch {
      return { ...EMPTY_NUDGE_STATE };
    }
  }

  write(next: NudgeState): boolean {
    try {
      const dir = dirname(this.path);
      mkdirSync(dir, { recursive: true, mode: DIR_MODE });
      const tmp = `${this.path}.${randomBytes(6).toString('hex')}.tmp`;
      try {
        writeFileSync(tmp, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: FILE_MODE });
        renameSync(tmp, this.path);
      } catch (err) {
        try { unlinkSync(tmp); } catch { /* the temp file may never have been created */ }
        throw err;
      }
      return true;
    } catch (err) {
      log.debug('nudge state write failed', { error: String(err) });
      return false;
    }
  }
}

/** Count one successful run. Never renders anything; never throws. */
export function recordSuccessfulRun(dataDir: string): void {
  try {
    const store = new NudgeStore(dataDir);
    const state = store.read();
    // Once the nudge is spent the counter has no reader, so stop writing to disk
    // on the tail of every tool call for the rest of the install's life.
    if (state.nudged) return;
    store.write({ ...state, successful_runs: state.successful_runs + 1 });
  } catch (err) {
    log.debug('nudge count failed', { error: String(err) });
  }
}

/**
 * Claim the single nudge, if it is due. Returns true AT MOST ONCE per install.
 *
 * The caller has already established that this install is unregistered — the
 * nudge has no meaning otherwise, and asking the gate from in here would put a
 * second activation read on the tail of every call.
 */
export function takeRegistrationNudge(dataDir: string): boolean {
  try {
    const store = new NudgeStore(dataDir);
    const state = store.read();
    if (state.nudged) return false;
    if (state.successful_runs < NUDGE_AFTER_RUNS) return false;
    // Write first, return second — see the header note on ordering.
    if (!store.write({ ...state, nudged: true })) return false;
    return true;
  } catch (err) {
    log.debug('nudge claim failed', { error: String(err) });
    return false;
  }
}
