/**
 * The run store as the `/v1/runs` REST surface reaches it (SD1 mini-spec §6 / A-43-5).
 *
 * §6 rules that exactly ONE process owns the run store: the process hosting the studio gateway when
 * the app is running, else the daemon. Both of those processes serve the same REST contract, and
 * only one of them can hold a native SQLite handle — the Electron main cannot load better-sqlite3
 * at all, so its store lives behind the broker child and is reachable only over async RPC.
 *
 * That asymmetry is the whole reason this port exists. Writing a second REST implementation for the
 * app would put the contract — id normalization, resume semantics, list paging, the create
 * validation — in two places, and law 1 says every surface is a projection of ONE event stream, not
 * of one stream per implementation. So the handlers speak this async port and the two owners bind
 * it differently: the daemon to its own SQLite handle, the app to the broker.
 *
 * Async even for the SQLite binding: a port whose fastest implementation is synchronous would let a
 * `.then()`-free call site compile and then deadlock the slow one.
 */
import type Database from 'better-sqlite3';
import {
  createRun,
  getRun,
  runExists,
  listRuns,
  eventsSince,
  type CreateRunInput,
  type Driver,
  type ListRunsOptions,
  type ListRunsResult,
  type Run,
  type RunEvent,
} from '../../studio/run-store.js';
import { appendRunEventWithTail, createRunWithTail } from '../../studio/run-bus.js';
import { clientAttachedEvent, profileClient } from '../capability-handshake.js';
import {
  denyWheel,
  grantWheel,
  releaseWheel,
  requestWheel,
  takeWheel,
  type BatonResult,
} from '../driver-baton.js';
import {
  listMessages,
  queueMessage,
  type QueueMessageInput,
  type QueueMessageResult,
  type RunMessage,
} from '../message-queue.js';

/**
 * Every method the REST surface needs and nothing else. There is deliberately no `append` and no
 * `update`: the REST surface only ever creates and reads, and the log is append-only.
 *
 * Implementations MUST publish a created run's birth event onto the in-process bus
 * (`run-bus.ts`), because an SSE tail opened on THIS process is fanned out from that bus alone.
 */
export interface RunsStore {
  create(input: CreateRunInput): Promise<Run>;
  list(opts: ListRunsOptions): Promise<ListRunsResult>;
  get(runId: string): Promise<Run | undefined>;
  /**
   * Existence WITHOUT projecting the run — `get` replays the whole log, which is exactly what the
   * SSE route's paged replay exists to avoid doing in one synchronous burst.
   */
  exists(runId: string): Promise<boolean>;
  eventsSince(runId: string, since: number, limit: number): Promise<RunEvent[]>;
  /**
   * SD2 §1.3 — move the baton. The one WRITE besides `create`, and it is still not an `append`: the
   * caller names a GESTURE and the baton decides which events (if any) that gesture is worth, which
   * is what keeps "transitions happen only via the explicit gesture" true of every surface at once.
   *
   * OPTIONAL because a binding that cannot reach the log directly — the Electron main's
   * broker-backed store — has no baton to move; the route answers `store_unavailable` there rather
   * than pretending. Additive on purpose: an existing binding stays valid without changing.
   */
  driver?(runId: string, input: DriverGesture): Promise<BatonResult>;
  /**
   * SD2 §3 — accept a message into the run's delivery queue. A WRITE, and still not an `append`:
   * the caller names a text and the queue decides which row that is worth, exactly as `driver`
   * names a gesture. It delivers nothing; law 7 says a pull transport queues and we say so, and
   * what comes back is a `queued` message whose own state line says when it will reach the agent.
   */
  sendMessage?(runId: string, input: QueueMessageInput): Promise<QueueMessageResult>;
  /** The run's messages, newest first, each folded to the state its rows put it in. */
  messages?(runId: string, limit: number): Promise<RunMessage[]>;
}

/** The five gestures, and nothing else: there is no way to set the driver field directly. */
export type DriverGestureKind = 'request' | 'grant' | 'release' | 'takeover' | 'deny';

export interface DriverGesture {
  gesture: DriverGestureKind;
  /** Who is making the gesture. */
  by: Driver;
  /** `grant`/`deny`: the queued request being answered. */
  requestId?: string;
  /** `grant`: an explicit successor, when the queue holds no request to answer. */
  to?: Driver;
  reason?: string;
}

function applyGesture(db: Database.Database, runId: string, input: DriverGesture): BatonResult {
  const reason = input.reason !== undefined ? { reason: input.reason } : {};
  switch (input.gesture) {
    case 'request':
      return requestWheel(db, runId, { by: input.by, ...reason });
    case 'grant':
      return grantWheel(db, runId, {
        by: input.by,
        ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
        ...(input.to !== undefined ? { to: input.to } : {}),
        ...reason,
      });
    case 'release':
      return releaseWheel(db, runId, { by: input.by, ...reason });
    case 'takeover':
      return takeWheel(db, runId, { by: input.by, ...reason });
    case 'deny':
      return denyWheel(db, runId, { by: input.by, requestId: input.requestId ?? '', ...reason });
  }
}

/**
 * Creating a run IS attaching to it, so the birth event is followed by the SD2 §2 record of what
 * the creating client could do at the time (its capability set, plus the phrasing key its name
 * bought — the only thing a name ever buys). Written here rather than in the REST handler because
 * the store binding is what owns the handle and the bus; the port itself gains no `append`, and the
 * log stays the single source of truth for the answer.
 *
 * An anonymous creator gets no second event: `run.created` already carries everything known about
 * it, and an append-only log is the wrong place to record the absence of information.
 */
function createWithAttach(db: Database.Database, input: CreateRunInput): Run {
  const run = createRunWithTail(db, input);
  const profile = profileClient(input.driver?.client);
  if (!profile.client) return run;
  const event = appendRunEventWithTail(db, run.id, clientAttachedEvent(profile));
  // `lastSeq` is what a caller resumes an SSE tail from, so it has to name the log's real head.
  // `client.attached` is not a projection event, so no other field on the run moves with it.
  return { ...run, lastSeq: event.seq, updatedAt: event.ts };
}

/** The daemon's binding: a native handle it opened itself. `createRun` goes through the bus. */
export function sqliteRunsStore(db: Database.Database): RunsStore {
  return {
    create: async (input) => createWithAttach(db, input),
    list: async (opts) => listRuns(db, opts),
    get: async (runId) => getRun(db, runId),
    exists: async (runId) => runExists(db, runId),
    eventsSince: async (runId, since, limit) => eventsSince(db, runId, since, limit),
    driver: async (runId, input) => applyGesture(db, runId, input),
    sendMessage: async (runId, input) => queueMessage(db, runId, input),
    messages: async (runId, limit) => listMessages(db, runId, limit),
  };
}

export type { BatonResult };
export type { QueueMessageInput, QueueMessageResult, RunMessage };
export type { CreateRunInput, ListRunsOptions, ListRunsResult, Run, RunEvent };
