import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { stopBrokerChild, BROKER_STOP_GRACE_MS, BROKER_KILL_REAP_MS } from '../../../src/studio/broker-stop.js';

/**
 * The stop mechanism itself, away from a real broker. The cross-process proof that the graceful door
 * actually drains `events.jsonl` lives in `run-store-restart.test.ts`; what CANNOT be shown there is
 * the other half — what happens when that door is not answered, and what happens when it is asked of a
 * process that is already gone. Both are states a real child will not enter on command.
 */
interface FakeChild {
  stdin: { end(): void } | null;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  stdinEnded: boolean;
  killedWith: NodeJS.Signals | undefined;
  kill(signal?: NodeJS.Signals): boolean;
  once(ev: string, cb: () => void): void;
}

/** `answersStdin: false` models a wedged broker: the pipe closes and nothing reacts to it. */
function fakeChild(opts: { answersStdin: boolean }): FakeChild {
  const bus = new EventEmitter();
  const child: FakeChild = {
    exitCode: null,
    signalCode: null,
    stdinEnded: false,
    killedWith: undefined,
    stdin: {
      end: () => {
        child.stdinEnded = true;
        if (!opts.answersStdin) return;
        child.exitCode = 0;
        bus.emit('exit');
      },
    },
    kill: (signal?: NodeJS.Signals) => {
      child.killedWith = signal ?? 'SIGTERM';
      child.signalCode = child.killedWith;
      bus.emit('exit');
      return true;
    },
    once: (ev: string, cb: () => void) => { bus.once(ev, cb); },
  };
  return child;
}

const stop = (child: FakeChild, graceMs?: number): Promise<void> =>
  stopBrokerChild(child as unknown as ChildProcess, graceMs);

describe('stopBrokerChild', () => {
  it('closes stdin and resolves without signalling a broker that answers', async () => {
    const child = fakeChild({ answersStdin: true });
    await stop(child);
    expect(child.stdinEnded).toBe(true);
    // The whole point: a signal cannot run the child's exit hook on Windows, so a stop that reaches
    // for one has already lost the tail of the run log it was supposed to drain.
    expect(child.killedWith).toBeUndefined();
  });

  it('escalates to SIGKILL — not SIGTERM — when the graceful door goes unanswered, and still returns', async () => {
    const child = fakeChild({ answersStdin: false });
    await stop(child, 20);
    expect(child.stdinEnded, 'the graceful door must be tried first').toBe(true);
    // SIGTERM is the door we just found closed on Windows; on POSIX it would only re-enter a handler
    // this child has evidently stopped serving. A stop that cannot complete leaves the app unquittable.
    expect(child.killedWith).toBe('SIGKILL');
  });

  it('does nothing to a child that has already exited', async () => {
    // The pid may have been recycled by now. Signalling it would be signalling a stranger, and waiting
    // on an `exit` that has already fired would burn the full grace period before doing so.
    const reaped = fakeChild({ answersStdin: true });
    reaped.exitCode = 0;
    await stop(reaped);
    expect(reaped.stdinEnded).toBe(false);
    expect(reaped.killedWith).toBeUndefined();

    const killed = fakeChild({ answersStdin: true });
    killed.signalCode = 'SIGKILL';
    await stop(killed);
    expect(killed.stdinEnded).toBe(false);
    expect(killed.killedWith).toBeUndefined();
  });

  it('tolerates a child with no stdin, and a null child, rather than throwing on the quit path', async () => {
    const child = fakeChild({ answersStdin: false });
    child.stdin = null;
    await stop(child, 20);
    expect(child.killedWith).toBe('SIGKILL');
    await expect(stopBrokerChild(null)).resolves.toBeUndefined();
    await expect(stopBrokerChild(undefined)).resolves.toBeUndefined();
  });

  /**
   * The budget is not a taste question: `before-quit` bounds the app's whole shutdown at 10s and a
   * healthy quit already spends ~4.15s of it before the broker is stopped at all. If a wedged broker
   * could spend the rest, the quit would miss its deadline and lose the teardown that runs after the
   * stop — so the worst case this module can cost is pinned here rather than left to drift.
   */
  it('costs a wedged broker well under the app quit deadline', () => {
    expect(BROKER_STOP_GRACE_MS + BROKER_KILL_REAP_MS).toBeLessThanOrEqual(5_000);
  });
});
