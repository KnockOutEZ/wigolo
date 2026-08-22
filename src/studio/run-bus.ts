/**
 * In-process live tail for the run log (SD1 mini-spec §5.5).
 *
 * SQLite does not push, so an SSE stream cannot learn about a new event by watching the table. The
 * store already offers an `onEvent` hook that fires AFTER the append commits; this module is the
 * one place that hook is wired to subscribers, so every surface in a process tails the same fan-out
 * rather than growing its own.
 *
 * The bus carries no history and no buffering on purpose: replay comes from the durable log (the
 * single source of truth, law 1), and the bus only covers the window from "I subscribed" onward.
 * That split is what makes the subscribe-then-replay contract gapless.
 */
import type Database from 'better-sqlite3';
import { createLogger } from '../logger.js';
import {
  appendEvent,
  createRun,
  resolveRunId,
  type CreateRunInput,
  type Run,
  type RunEvent,
  type RunEventInput,
  type RunStoreOptions,
} from './run-store.js';

const log = createLogger('studio');

type Listener = (event: RunEvent) => void;

const listeners = new Map<string, Set<Listener>>();

function busKey(runId: string): string {
  return resolveRunId(runId) ?? String(runId).trim().toLowerCase();
}

/** Returns the unsubscribe. Callers MUST call it — a leaked listener holds a dead connection alive. */
export function subscribeRunEvents(runId: string, listener: Listener): () => void {
  // The bus keys an in-memory fan-out, so an unmintable id is simply a key nothing publishes to —
  // never a reason to throw at a caller that is only registering interest.
  const id = busKey(runId);
  let set = listeners.get(id);
  if (!set) {
    set = new Set();
    listeners.set(id, set);
  }
  set.add(listener);
  return () => {
    const current = listeners.get(id);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) listeners.delete(id);
  };
}

/**
 * One subscriber throwing must not cost the others their event, and must never unwind into the
 * append that produced it — the DB write already committed by the time we get here.
 */
export function publishRunEvent(runId: string, event: RunEvent): void {
  const set = listeners.get(busKey(runId));
  if (!set || set.size === 0) return;
  for (const listener of [...set]) {
    try {
      listener(event);
    } catch (err) {
      log.warn('run event listener threw', { runId, seq: event.seq, error: String(err) });
    }
  }
}

/** Test/diagnostic seam — a non-zero count after a connection closes is a leak. */
export function runEventListenerCount(runId: string): number {
  return listeners.get(busKey(runId))?.size ?? 0;
}

function withTail(opts: RunStoreOptions): RunStoreOptions {
  return {
    ...opts,
    onEvent: (runId, event) => {
      opts.onEvent?.(runId, event);
      publishRunEvent(runId, event);
    },
  };
}

/** `createRun`, with the birth event on the tail. Prefer this over the bare store call in-process. */
export function createRunWithTail(db: Database.Database, input: CreateRunInput, opts: RunStoreOptions = {}): Run {
  return createRun(db, input, withTail(opts));
}

/** `appendEvent`, with the committed envelope on the tail. */
export function appendRunEventWithTail(
  db: Database.Database,
  runId: string,
  input: RunEventInput,
  opts: RunStoreOptions = {},
): RunEvent {
  return appendEvent(db, runId, input, withTail(opts));
}
