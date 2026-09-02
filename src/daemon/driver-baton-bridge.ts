/**
 * The baton ↔ control-token bridge (SD2 mini-spec §1.6, ruling A-51-1).
 *
 * TWO QUESTIONS, TWO SCOPES. The baton is run-scoped, durable and five-kind: *who has authority
 * over this run*. The control token is session-scoped, in-memory, two-party and epoch-fenced:
 * *whose input reaches this browser right now*. The ruling is that the baton sits ABOVE the token
 * and delegates to it — so this file is the delegation, and it is the ONLY place the two meet.
 *
 * PROJECTION, ONE DIRECTION. `toControlParty` collapses five kinds to two. When a baton transition
 * changes that collapsed value for a run with a live session, the bridge calls the token's existing
 * public API — `reclaim()` for →human, `grant('agent')` for →agent. A swap between two agent-side
 * drivers (`cli` → `sdk`) is invisible to the token BY CONSTRUCTION rather than by a special case:
 * the projection did not change, so nothing is called, so the epoch does not move. That matters —
 * an epoch bump invalidates every input in flight, and a change of run authority has no input
 * meaning at all.
 *
 * REFLECTION, THE OTHER DIRECTION. A flip to `human` the baton did not initiate — the human grabbed
 * the browser, or the credential wall reclaimed on their behalf — is reported UPWARD as
 * `driver.changed {cause:'takeover'}`. One authority (the log) with a session-local fast path;
 * never two sources of truth disagreeing for longer than one append.
 *
 * WHY THE REFLECTION IS DEFERRED BY A TICK. `ControlToken.onChange` carries `{holder, epoch}` and
 * nothing else — no reason, no actor — and the callbacks fire SYNCHRONOUSLY from inside `flipTo`.
 * The credential arc reclaims at `handoff.ts:228` and only marks itself `human-holding` on the line
 * after, so a handler that asks "why?" from inside the callback is guaranteed to be told "no reason"
 * for the one flip that has the best reason of all. Rather than edit the token or the handoff — both
 * are consumed through their public API and NOT edited under A-51-1 — the bridge asks on the next
 * microtask, by which point the session has finished saying what it is doing (A-217-3).
 *
 * NOTHING HERE IS A FENCE. The token's `assertCanDrive`/`epoch` contract is the fence and is
 * untouched; this only keeps the run log honest about who is driving.
 */
import type Database from 'better-sqlite3';
import { subscribeRunEvents } from '../studio/run-bus.js';
import type { Driver } from '../studio/run-store.js';
import type { ControlParty } from '../studio/control-token.js';
import { createLogger } from '../logger.js';
import { DRIVER_CHANGED, takeWheel } from './driver-baton.js';

const log = createLogger('studio');

/**
 * The slice of `ControlToken` the bridge uses — structural on purpose, so the bridge depends on the
 * four published members and not on the class, and a test can drive it without a browser.
 */
export interface BridgeControlToken {
  readonly holder: ControlParty;
  reclaim(): void;
  grant(to: ControlParty): void;
  onChange(cb: (s: { holder: ControlParty; epoch: number }) => void): void;
}

/** §1.6's projection, whole. Five kinds in, two parties out, one direction only. */
export function toControlParty(driver: Driver): ControlParty {
  return driver.kind === 'human' ? 'human' : 'agent';
}

export interface BatonTokenBridgeOptions {
  token: BridgeControlToken;
  /** The run bound to this session. Absent ⇒ the bridge is inert: there is nothing to project onto. */
  runId: string | undefined;
  /** The run log. Allowed to fail — a session that cannot reach it keeps driving, unbridged. */
  openDb: () => Database.Database | undefined;
  /**
   * Why the token just flipped to the human, asked on the tick AFTER the flip (see the header). The
   * session supplies it; `undefined` means nobody claimed the takeover, which is the honest answer
   * for a human who simply grabbed the browser.
   */
  takeoverReason?: () => string | undefined;
  /** Injectable so a test can make the deferral observable; production uses `queueMicrotask`. */
  defer?: (fn: () => void) => void;
}

export interface BatonTokenBridge {
  /** Release the run-log subscription and stop reflecting. A leaked bridge outlives its session. */
  dispose(): void;
}

/**
 * Wire one session's token to one run's baton. Returns the disposer.
 *
 * Neither direction may ever throw at its caller: the projection runs on a run-log listener that the
 * append already committed behind, and the reflection runs inside a token flip that has already
 * happened. Failing either would corrupt a state change that is over, so both degrade to a warning
 * and leave the log to be reconciled by the next transition.
 */
export function createBatonTokenBridge(options: BatonTokenBridgeOptions): BatonTokenBridge {
  const { token, runId, openDb } = options;
  const defer = options.defer ?? queueMicrotask;
  const reason = options.takeoverReason ?? ((): string | undefined => undefined);
  let disposed = false;
  /**
   * True only while the bridge itself is moving the token. The token calls its handlers
   * synchronously from inside `flipTo`, so a plain flag is a complete guard here — and it is what
   * stops the projection and the reflection from chasing each other around one transition.
   */
  let applying = false;
  let unsubscribe: (() => void) | undefined;

  const withDb = (what: string, fn: (db: Database.Database) => void): void => {
    try {
      const db = openDb();
      if (!db) return;
      fn(db);
    } catch (err) {
      log.warn(`baton bridge could not ${what}`, { runId, error: String(err) });
    }
  };

  // REFLECTION — the token moved under us; tell the run log who drives now.
  token.onChange((state) => {
    if (disposed || applying || !runId) return;
    // Only a grab BY the human is authority the run does not already know about. A flip to the
    // agent is either this bridge's own doing (guarded above) or the session handing input back
    // inside a run the agent already drives — no new fact, and never a route by which an agent
    // could seize a run it was not granted.
    if (state.holder !== 'human') return;
    defer(() => {
      if (disposed) return;
      withDb('record the human takeover', (db) => {
        const result = takeWheel(db, runId, { by: { kind: 'human' }, ...(reason() ? { reason: reason()! } : {}) });
        if (!result.ok) log.warn('human takeover not recorded on the run log', { runId, reason: result.error_reason });
      });
    });
  });

  // PROJECTION — the baton moved; make the session's input gate agree.
  if (runId) {
    unsubscribe = subscribeRunEvents(runId, (event) => {
      if (disposed || event.type !== DRIVER_CHANGED) return;
      const to = event.payload.to;
      if (!to || typeof to !== 'object' || Array.isArray(to)) return;
      const kind = (to as { kind?: unknown }).kind;
      if (typeof kind !== 'string') return;
      const party = toControlParty({ kind } as Driver);
      if (party === token.holder) return; // §1.3.4: never bump the epoch spuriously
      applying = true;
      try {
        if (party === 'human') token.reclaim();
        else token.grant('agent');
      } catch (err) {
        log.warn('baton bridge could not move the control token', { runId, error: String(err) });
      } finally {
        applying = false;
      }
    });
  }

  return {
    dispose(): void {
      disposed = true;
      unsubscribe?.();
      unsubscribe = undefined;
    },
  };
}
