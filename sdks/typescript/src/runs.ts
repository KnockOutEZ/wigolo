/**
 * The `runs` namespace — a PROJECTION CLIENT over the daemon's existing runs routes, not a new
 * transport (SD8 §9, ruling A-19-8).
 *
 * A run is the unit of everything: task, transcript, tab group, action log and pending decisions,
 * living in the daemon as an append-only event log that outlives every UI. Everything here is a
 * read of that log or a write through a route that appends to it. There is deliberately no local
 * run state, no cache and no derived status — a second source of truth for who drives or what
 * happened is the one thing this shape exists to prevent.
 *
 * The stream is `GET /v1/runs/:id/events`, whose SSE `id` IS the event `seq`. That identity is the
 * whole resume contract: a reconnect sends `Last-Event-ID` and the server replays from strictly
 * greater, so a dropped socket costs a round trip and never an event.
 */
import { SseParser, LAST_EVENT_ID_HEADER } from './sse.js';

/** Law-3 driver vocabulary, verbatim. */
export type DriverKind = 'cli' | 'sdk' | 'api' | 'studio' | 'human';

export interface Driver {
  kind: DriverKind;
  /** Client identity when the transport knew one. */
  client?: { name: string; version: string };
}

/** Who an event is attributed to. */
export interface RunActor {
  kind: 'agent' | 'human' | 'daemon' | 'system';
  driver?: DriverKind;
  client?: { name: string; version: string };
}

/**
 * One event, every surface, one shape. `payload` is deliberately `unknown`-valued: a consumer that
 * knows a type narrows it itself, and a consumer that does not must not be able to read fields off
 * a type it has never seen.
 */
export interface RunEvent {
  /** Per-run, 1-based, monotonic, gap-free. Ordering is seq — never `ts`. */
  seq: number;
  ts: string;
  actor: RunActor;
  /** Dot-namespaced. The set is OPEN: unknown types are ignored, never rejected. */
  type: string;
  payload: Record<string, unknown>;
}

export type RunStatus = 'running' | 'needs_you' | 'paused' | 'done' | 'failed' | 'cancelled';

export interface PendingDecision {
  decisionId: string;
  kind: string;
  prompt: string;
  anchor?: { tabId: string; mark?: number };
  requestedAt: string;
  autoDenyAt?: string;
}

export interface RunCost {
  browserActions: number;
  tokensIn: number;
  tokensOut: number;
  spendUsd: number;
}

export interface Run {
  id: string;
  task: string;
  spaceId: string;
  createdAt: string;
  status: RunStatus;
  driver: Driver;
  tabIds: string[];
  pendingDecisions: PendingDecision[];
  cost: RunCost;
  visibility: 'hidden' | 'visible';
  lastSeq: number;
  updatedAt: string;
}

export interface CreateRunRequest {
  task: string;
  spaceId?: string;
  driver?: Driver;
}

export interface ListRunsRequest {
  status?: RunStatus | RunStatus[];
  spaceId?: string;
  limit?: number;
  cursor?: string;
}

export interface ListRunsResponse {
  runs: Run[];
  /** Opaque keyset cursor; absent on the last page. */
  nextCursor?: string;
}

/** The wire spelling of a queued message — snake_case, because that is what the route returns. */
export interface RunMessage {
  message_id: string;
  text: string;
  from: RunActor;
  urgent?: boolean;
  queued_at: string;
  queued_at_step: number;
  state: 'queued' | 'delivered' | 'acknowledged';
  delivered_at_step?: number;
  delivered_via?: string;
  acknowledged_at_step?: number;
  /**
   * The honesty rule as one string (law 7). Render THIS rather than composing your own — a pull
   * transport queues, and every surface says so in the same words.
   */
  state_line: string;
}

export interface SendMessageRequest {
  text: string;
  urgent?: boolean;
  /** Idempotency key. Retrying with it returns the first message and appends nothing. */
  messageId?: string;
}

export interface SendMessageResponse {
  message: RunMessage;
  /** True when the `messageId` was already in the log and this call appended nothing. */
  replayed?: boolean;
}

export type DriverGestureKind = 'request' | 'grant' | 'release' | 'takeover' | 'deny';

export interface DriverGestureRequest {
  gesture: DriverGestureKind;
  /** A gesture is made BY someone (law 3). Required. */
  by: Driver;
  to?: Driver;
  requestId?: string;
  reason?: string;
}

export interface DriverGestureResponse {
  run: Run;
  /** What the gesture was worth. EMPTY when it was a no-op — the honest answer. */
  events: RunEvent[];
  requestId?: string;
}

export interface EventsOptions {
  /**
   * Resume point: "I have everything up to and including this seq; send me strictly greater."
   * Omit for a full replay from seq 1.
   */
  since?: number;
  /** Abort the stream. Closing the iterator (`break`) does the same thing. */
  signal?: AbortSignal;
  /**
   * Reconnect after a dropped stream, resuming from the last seq seen. Default true — the daemon
   * never closes the stream on its own, so an end-of-stream means the socket died.
   */
  reconnect?: boolean;
  /** Ceiling on consecutive reconnect attempts. Default 10; `Infinity` to retry forever. */
  maxReconnects?: number;
  /** Override the server's `retry:` hint (ms). */
  reconnectDelayMs?: number;
}

/**
 * Fan-out for `watchRun`. Every callback is optional and every callback is best-effort: one that
 * throws is reported to `onError` and the watch continues. A watcher that could be killed by its
 * own handler would silently stop projecting a run that is still going.
 */
export interface WatchRunCallbacks {
  /** `message.queued` — a person typed something into this run. */
  onHumanMessage?: (event: RunEvent) => void | Promise<void>;
  /** `decision.requested` — the run is blocked on an approval, anchored where it can be answered. */
  onApproval?: (event: RunEvent) => void | Promise<void>;
  /** `driver.changed` with `cause: 'takeover'` — someone took the wheel. */
  onTakeover?: (event: RunEvent) => void | Promise<void>;
  /**
   * Every envelope, known type or not. This is the forward-compat seam: a type this SDK version
   * has never heard of reaches ONLY here, and reaches nothing at all when this is omitted.
   */
  onEvent?: (event: RunEvent) => void | Promise<void>;
  /** A callback threw, or the stream failed terminally. Never rethrown. */
  onError?: (error: unknown, event?: RunEvent) => void;
}

/** Handle on a running watch. */
export interface RunWatch {
  /** Stop watching. Idempotent. */
  stop(): void;
  /** Resolves when the watch has stopped and every dispatched callback has settled. */
  done: Promise<void>;
  /** Highest seq delivered so far — the resume point if you restart the watch yourself. */
  readonly lastSeq: number;
}

/** The transport `runs` needs: a request function, plus enough to stream one. */
export interface RunsTransport {
  request<T>(method: 'GET' | 'POST', path: string, body: unknown, timeoutMs: number): Promise<T>;
  /** Open an SSE stream and yield decoded text chunks until it ends. */
  stream(path: string, headers: Record<string, string>, signal: AbortSignal): AsyncIterable<string>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RECONNECT_DELAY_MS = 3_000;
const DEFAULT_MAX_RECONNECTS = 10;

function encodeRunId(id: string): string {
  return encodeURIComponent(id);
}

/**
 * Turn one `data:` payload into an envelope, or `undefined` when it is not one.
 *
 * Rejecting is not the same as throwing. A frame this SDK cannot read — malformed JSON, a shape
 * from a future the envelope contract has not reached — is DROPPED, because the alternative is a
 * client that a server-side addition can crash. `seq` and `type` are required because they are
 * what ordering and dispatch are built on; everything else is filled in defensively.
 */
export function parseRunEvent(data: string): RunEvent | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.seq !== 'number' || !Number.isFinite(obj.seq)) return undefined;
  if (typeof obj.type !== 'string' || obj.type.length === 0) return undefined;
  const actor =
    obj.actor !== null && typeof obj.actor === 'object' && !Array.isArray(obj.actor)
      ? (obj.actor as RunActor)
      : ({ kind: 'system' } as RunActor);
  const payload =
    obj.payload !== null && typeof obj.payload === 'object' && !Array.isArray(obj.payload)
      ? (obj.payload as Record<string, unknown>)
      : {};
  return {
    seq: obj.seq,
    ts: typeof obj.ts === 'string' ? obj.ts : '',
    actor,
    type: obj.type,
    payload,
  };
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
    signal.addEventListener('abort', finish, { once: true });
  });
}

export class Runs {
  constructor(private readonly transport: RunsTransport) {}

  /** `POST /v1/runs` — creates the run and writes `run.created` as seq 1. */
  create = async (params: CreateRunRequest): Promise<Run> => {
    const body = await this.transport.request<{ run: Run }>(
      'POST',
      '/v1/runs',
      params,
      DEFAULT_TIMEOUT_MS,
    );
    return body.run;
  };

  /** `GET /v1/runs/:id` — the run object, itself a projection of the log. */
  get = async (id: string): Promise<Run> => {
    const body = await this.transport.request<{ run: Run }>(
      'GET',
      `/v1/runs/${encodeRunId(id)}`,
      undefined,
      DEFAULT_TIMEOUT_MS,
    );
    return body.run;
  };

  /** `GET /v1/runs` — newest first, keyset-paged through `nextCursor`. */
  list = async (params: ListRunsRequest = {}): Promise<ListRunsResponse> => {
    const query = new URLSearchParams();
    if (params.status !== undefined) {
      query.set('status', Array.isArray(params.status) ? params.status.join(',') : params.status);
    }
    if (params.spaceId !== undefined) query.set('spaceId', params.spaceId);
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    if (params.cursor !== undefined) query.set('cursor', params.cursor);
    const suffix = query.toString();
    const body = await this.transport.request<{ runs: Run[]; next_cursor?: string }>(
      'GET',
      suffix.length > 0 ? `/v1/runs?${suffix}` : '/v1/runs',
      undefined,
      DEFAULT_TIMEOUT_MS,
    );
    return {
      runs: Array.isArray(body.runs) ? body.runs : [],
      ...(typeof body.next_cursor === 'string' ? { nextCursor: body.next_cursor } : {}),
    };
  };

  /**
   * `POST /v1/runs/:id/messages` — accept a message into the run's delivery queue.
   *
   * The route answers `202`, and the returned `state_line` says the same thing again: the message
   * is QUEUED and reaches the agent at its next tool call. Nothing here has been delivered.
   */
  sendMessage = async (id: string, params: SendMessageRequest): Promise<SendMessageResponse> => {
    const body = await this.transport.request<{ message: RunMessage; replayed?: boolean }>(
      'POST',
      `/v1/runs/${encodeRunId(id)}/messages`,
      {
        text: params.text,
        ...(params.urgent !== undefined ? { urgent: params.urgent } : {}),
        ...(params.messageId !== undefined ? { message_id: params.messageId } : {}),
      },
      DEFAULT_TIMEOUT_MS,
    );
    return {
      message: body.message,
      ...(body.replayed === true ? { replayed: true } : {}),
    };
  };

  /** `GET /v1/runs/:id/messages` — the run's messages, newest first. A read of the log. */
  messages = async (id: string, limit?: number): Promise<RunMessage[]> => {
    const suffix = limit !== undefined ? `?limit=${limit}` : '';
    const body = await this.transport.request<{ messages: RunMessage[] }>(
      'GET',
      `/v1/runs/${encodeRunId(id)}/messages${suffix}`,
      undefined,
      DEFAULT_TIMEOUT_MS,
    );
    return Array.isArray(body.messages) ? body.messages : [];
  };

  /**
   * `POST /v1/runs/:id/driver` — the baton gestures, and the only way the wheel moves.
   *
   * There is deliberately no "set the driver": a transition that did not go through a gesture
   * would be a second source of truth for who drives. Request-the-wheel is a gesture, never a race.
   */
  driverGesture = async (
    id: string,
    params: DriverGestureRequest,
  ): Promise<DriverGestureResponse> => {
    const body = await this.transport.request<{
      run: Run;
      events?: RunEvent[];
      requestId?: string;
    }>('POST', `/v1/runs/${encodeRunId(id)}/driver`, params, DEFAULT_TIMEOUT_MS);
    return {
      run: body.run,
      events: Array.isArray(body.events) ? body.events : [],
      ...(typeof body.requestId === 'string' ? { requestId: body.requestId } : {}),
    };
  };

  /**
   * `GET /v1/runs/:id/events` as an async iterator of envelopes — replay, then live tail.
   *
   * Resume is built in and is the reason this is hand-rolled rather than an `EventSource`: on a
   * dropped socket the loop reconnects with `Last-Event-ID` set to the highest seq it delivered,
   * and the server sends strictly greater. A monotone guard runs on THIS side too, so a server
   * that re-sent an event a client already has cannot make it appear twice — exactly-once
   * delivery per seq holds without either side coordinating.
   *
   * The daemon never closes the stream on its own, not even after a terminal event. Stop by
   * breaking out of the loop or aborting the signal.
   */
  async *events(id: string, options: EventsOptions = {}): AsyncGenerator<RunEvent> {
    const controller = new AbortController();
    const external = options.signal;
    const onExternalAbort = (): void => controller.abort();
    if (external) {
      if (external.aborted) controller.abort();
      else external.addEventListener('abort', onExternalAbort, { once: true });
    }

    const parser = new SseParser();
    let lastSeq = options.since ?? 0;
    if (lastSeq > 0) parser.setResumeId(String(lastSeq));
    const reconnect = options.reconnect !== false;
    const maxReconnects = options.maxReconnects ?? DEFAULT_MAX_RECONNECTS;
    let attempts = 0;

    try {
      while (!controller.signal.aborted) {
        const headers: Record<string, string> = { Accept: 'text/event-stream' };
        // `Last-Event-ID` outranks `?since=` server-side, so only ONE of them is ever sent — the
        // header, which is also what carries the resume point across a reconnect. An explicit
        // `since` is just the starting value of that same counter, which is why there is no
        // second code path for it.
        const path = `/v1/runs/${encodeRunId(id)}/events`;
        if (lastSeq > 0) headers[LAST_EVENT_ID_HEADER] = String(lastSeq);

        let delivered = false;
        try {
          for await (const chunk of this.transport.stream(path, headers, controller.signal)) {
            for (const message of parser.push(chunk)) {
              const event = parseRunEvent(message.data);
              // A frame that is not an envelope is dropped, not thrown on — forward compat.
              if (!event) continue;
              // The monotone guard. A replayed seq is a duplicate, never a rewind.
              if (event.seq <= lastSeq) continue;
              lastSeq = event.seq;
              delivered = true;
              attempts = 0;
              yield event;
            }
          }
        } finally {
          // Half-parsed bytes belong to a connection that is gone; the resume id survives.
          parser.reset();
        }

        if (controller.signal.aborted || !reconnect) return;
        if (!delivered) {
          attempts += 1;
          if (attempts > maxReconnects) return;
        }
        await sleep(
          options.reconnectDelayMs ?? parser.retryMs ?? DEFAULT_RECONNECT_DELAY_MS,
          controller.signal,
        );
      }
    } finally {
      if (external) external.removeEventListener('abort', onExternalAbort);
      controller.abort();
    }
  }

  /**
   * Watch a run and fan its envelopes out to typed callbacks.
   *
   * Mapping: `message.queued` → `onHumanMessage`, `decision.requested` → `onApproval`,
   * `driver.changed {cause:'takeover'}` → `onTakeover`. Every envelope — including one whose type
   * this SDK has never heard of — also reaches `onEvent`, which is the forward-compat seam.
   *
   * A `driver.changed` that is a grant or a release is NOT a takeover and does not fire
   * `onTakeover`; the cause is the whole distinction between someone being handed the wheel and
   * someone taking it.
   */
  watchRun = (id: string, callbacks: WatchRunCallbacks, options: EventsOptions = {}): RunWatch => {
    const controller = new AbortController();
    const external = options.signal;
    const onExternalAbort = (): void => controller.abort();
    if (external) {
      if (external.aborted) controller.abort();
      else external.addEventListener('abort', onExternalAbort, { once: true });
    }

    let lastSeq = options.since ?? 0;

    const dispatch = async (
      handler: ((event: RunEvent) => void | Promise<void>) | undefined,
      event: RunEvent,
    ): Promise<void> => {
      if (!handler) return;
      try {
        await handler(event);
      } catch (err) {
        // Never rethrown: a watcher killed by its own handler stops projecting a live run.
        try {
          callbacks.onError?.(err, event);
        } catch {
          // An onError that throws is out of options; swallowing is the only non-fatal answer.
        }
      }
    };

    const done = (async (): Promise<void> => {
      try {
        for await (const event of this.events(id, { ...options, signal: controller.signal })) {
          lastSeq = event.seq;
          switch (event.type) {
            case 'message.queued':
              await dispatch(callbacks.onHumanMessage, event);
              break;
            case 'decision.requested':
              await dispatch(callbacks.onApproval, event);
              break;
            case 'driver.changed':
              if (event.payload.cause === 'takeover') {
                await dispatch(callbacks.onTakeover, event);
              }
              break;
            default:
              // Unknown type: nothing to do here. `onEvent` below is its only destination.
              break;
          }
          await dispatch(callbacks.onEvent, event);
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          try {
            callbacks.onError?.(err);
          } catch {
            // As above.
          }
        }
      } finally {
        if (external) external.removeEventListener('abort', onExternalAbort);
      }
    })();

    return {
      stop: () => controller.abort(),
      done,
      get lastSeq(): number {
        return lastSeq;
      },
    };
  };
}
