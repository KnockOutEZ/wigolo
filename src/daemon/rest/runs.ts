/**
 * The `/v1/runs` REST family (SD1 mini-spec §5) — create, list, fetch, and tail a run.
 *
 * Law 1: the run is the unit of everything and every surface is a projection of the same event
 * stream. REST is not a lesser citizen than the desktop app or the MCP tools — it reads the same
 * durable log through the same store, so a run created with `curl` is the run the app shows.
 *
 * The SSE route is the load-bearing one. Its contract is exactly-once delivery per `seq` across a
 * dropped connection, which is why the subscription is registered BEFORE the replay query and every
 * frame goes out through a monotone guard: an event that lands between "subscribed" and "replayed"
 * is seen by both halves, and the guard is what makes that a no-op instead of a duplicate.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type Database from 'better-sqlite3';
import { createLogger } from '../../logger.js';
import {
  errorEnvelope,
  invalidJson,
  invalidInput,
  methodNotAllowed,
  notFound,
  bodyTooLarge,
  tooManyRequests,
  internalError,
  type HttpError,
} from './errors.js';
import { bodyCapFor, readJsonBodyCapped, BodyTooLargeError } from './limits.js';
import {
  normalizeRunId,
  MAX_TASK_CHARS,
  MAX_LIST_LIMIT,
  DEFAULT_LIST_LIMIT,
  type Driver,
  type DriverKind,
  type RunEvent,
  type RunStatus,
} from '../../studio/run-store.js';
import { subscribeRunEvents } from '../../studio/run-bus.js';
import { sqliteRunsStore, type RunsStore } from './runs-store.js';
import { resolveRunsOwner, proxyRunsRequest, type RunsOwner } from './runs-owner.js';

const log = createLogger('rest');

/** The route label used for body caps and log lines. `bodyCapFor` gives it the 1 MiB default. */
export const RUNS_ROUTE_LABEL = 'runs';

const RUN_STATUSES = new Set<string>(['running', 'needs_you', 'paused', 'done', 'failed', 'cancelled']);
const DRIVER_KINDS = new Set<string>(['cli', 'sdk', 'api', 'studio', 'human']);

/** Persisted into the log AND onto disk, so both need a bound the 1 MiB body cap does not give. */
export const MAX_SPACE_ID_CHARS = 200;
export const MAX_CLIENT_FIELD_CHARS = 200;

/** SSE frames are long-lived sockets, so they are capped separately from the request slot pool. */
const DEFAULT_MAX_SSE_CONNECTIONS = 32;
/** Idle streams get a comment frame so intermediaries do not reap them and dead peers surface. */
const SSE_HEARTBEAT_MS = 15_000;
/** Told to the client once at stream open; it governs the client's own reconnect backoff. */
const SSE_RETRY_MS = 3000;
/**
 * Replay reads the log a page at a time and yields between pages. A long-running run's log is
 * unbounded, and draining it in one synchronous loop would hold the event loop for the whole of it —
 * every other request on the daemon, including the other runs' tails, stops until it finishes.
 */
const DEFAULT_REPLAY_PAGE = 500;
/**
 * How many live events the replay may hold back before it stops holding at all.
 *
 * The hold-back is what keeps a live event from overtaking an older replayed one, and it is the
 * only place on this route where the daemon's heap grows with something it does not control: a run
 * appending while a long log replays is bounded by nothing but replay-duration × event-rate, and
 * the deliberate yield between pages widens that window on purpose. Past the ceiling the buffer is
 * DROPPED rather than trimmed — a trimmed buffer would put a hole in the middle of the stream and
 * call it delivery, where a dropped one ends the stream and lets the client resume from its
 * `Last-Event-ID` against the durable log, which is the same door every reconnect already uses.
 */
const DEFAULT_MAX_HELD_EVENTS = 2048;

function replayPageSize(): number {
  const raw = process.env.WIGOLO_STUDIO_RUN_REPLAY_PAGE;
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_REPLAY_PAGE;
}

function maxHeldEvents(): number {
  const raw = process.env.WIGOLO_STUDIO_SSE_MAX_HELD;
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_HELD_EVENTS;
}

function maxSseConnections(): number {
  const raw = process.env.WIGOLO_STUDIO_SSE_MAX_CONNECTIONS;
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_SSE_CONNECTIONS;
}

let openSseConnections = 0;

/** Diagnostic seam — a non-zero count with no live clients is a leak. */
export function openRunStreamCount(): number {
  return openSseConnections;
}

export type RunsRoute =
  | { kind: 'collection' }
  | { kind: 'item'; id: string }
  | { kind: 'events'; id: string };

/**
 * `/v1/runs`, `/v1/runs/<id>`, `/v1/runs/<id>/events` and nothing else. Anything deeper or with an
 * empty id is not a run route at all — it must 404 rather than be coerced into the nearest match.
 */
export function parseRunsPath(pathname: string): RunsRoute | null {
  const rest = pathname.slice('/v1/runs'.length);
  if (rest === '' || rest === '/') return { kind: 'collection' };
  const segments = rest.replace(/^\//, '').split('/');
  if (segments.length === 1 && segments[0]) return { kind: 'item', id: segments[0] };
  if (segments.length === 2 && segments[0] && segments[1] === 'events') return { kind: 'events', id: segments[0] };
  return null;
}

export interface RunsRequestOptions {
  pathname: string;
  method: string;
  url: URL;
  respond: (status: number, body: unknown, headers?: Record<string, string>) => void;
  sendError: (error: HttpError) => void;
  /** Injected by tests; production resolves the shared cache DB lazily. */
  openDb?: () => Database.Database;
  /**
   * The bound run store, when this process cannot open a native handle at all. The Electron main
   * passes a broker-backed one (SD1 §6 / A-43-5) — see `runs-store.ts`. Wins over `openDb`.
   */
  store?: RunsStore;
  /** Injected by tests; production reads the published studio handle (SD1 §6 / A-43-5). */
  resolveOwner?: () => RunsOwner;
}

function runNotFound(): HttpError {
  return {
    status: 404,
    body: errorEnvelope('not_found', 'run not found', {
      hint: 'List runs with GET /v1/runs. Run ids are case-insensitive.',
    }),
    headers: {},
  };
}

function storeUnavailable(): HttpError {
  return {
    status: 503,
    body: errorEnvelope('store_unavailable', 'The run store is not available in this process.', {
      hint: 'Runs require the full daemon; this process is running without the local store.',
    }),
    headers: {},
  };
}

/**
 * Resolved per request, not per router: the store opens during subsystem init, and a REST surface
 * running without one at all must say so with a structured 503 rather than a stack.
 *
 * A bound `store` is checked first because it is the only answer available to a process that cannot
 * open a native handle — falling through to `getDatabase()` there would 503 an owner that CAN serve.
 */
async function resolveStore(opts: RunsRequestOptions): Promise<RunsStore | null> {
  if (opts.store) return opts.store;
  if (opts.openDb) {
    try {
      return sqliteRunsStore(opts.openDb());
    } catch {
      return null;
    }
  }
  try {
    const { getDatabase } = await import('../../cache/db.js');
    return sqliteRunsStore(getDatabase());
  } catch {
    return null;
  }
}

export async function handleRunsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: RunsRequestOptions,
): Promise<void> {
  const route = parseRunsPath(opts.pathname);
  if (!route) {
    opts.sendError(notFound());
    return;
  }

  const method = opts.method;
  if (route.kind === 'collection' && method !== 'POST' && method !== 'GET') {
    opts.sendError(methodNotAllowed('GET, POST'));
    return;
  }
  if (route.kind !== 'collection' && method !== 'GET') {
    opts.sendError(methodNotAllowed('GET'));
    return;
  }

  // Ownership BEFORE the store resolve (SD1 §6 / A-43-5). A standalone daemon running beside a live
  // studio host has a perfectly good DB handle of its own — that is exactly the trap. Opening it
  // first and only then asking who owns the run would make the answer look optional, and the whole
  // rule exists because two processes appending to one log fan their live tails out separately.
  const owner = (opts.resolveOwner ?? resolveRunsOwner)();
  let createBody: unknown;
  if (owner.kind === 'proxy') {
    // The body has to be read HERE, before the hop, because a request stream can be consumed once
    // and the fallback below needs to create the run itself. Re-serializing it is safe in a way
    // re-serializing an SSE frame is not: a JSON body carries no framing contract, and reading it
    // here is also what keeps THIS daemon's body cap the one that applies.
    if (route.kind === 'collection' && method === 'POST') {
      const cap = bodyCapFor(RUNS_ROUTE_LABEL);
      try {
        createBody = await readJsonBodyCapped(req, cap);
      } catch (err) {
        opts.sendError(err instanceof BodyTooLargeError ? bodyTooLarge(cap) : invalidJson());
        return;
      }
    }
    const outcome = await proxyRunsRequest(req, res, {
      target: { endpoint: owner.endpoint, token: owner.token },
      path: `${opts.pathname}${opts.url.search}`,
      method,
      streaming: route.kind === 'events',
      sendError: opts.sendError,
      ...(createBody !== undefined ? { body: Buffer.from(JSON.stringify(createBody)) } : {}),
    });
    // `served` is every case where the owner answered — including its errors, which are the
    // client's errors. The single exception is the owner telling us it holds no store at all, and
    // a process with no store is not an owner: falling through is the ONLY branch that does not
    // hand the caller a 503 for a run this daemon can perfectly well serve. (A-70-1.)
    if (outcome === 'served') return;
  }

  const store = await resolveStore(opts);
  if (!store) {
    opts.sendError(storeUnavailable());
    return;
  }

  try {
    if (route.kind === 'collection') {
      if (method === 'POST') await handleCreate(req, opts, store, createBody);
      else await handleList(opts, store);
      return;
    }
    if (route.kind === 'item') {
      await handleGet(opts, store, route.id);
      return;
    }
    await handleEvents(req, res, opts, store, route.id);
  } catch (err) {
    log.error('runs route failed', { route: route.kind, error: String(err) });
    opts.sendError(internalError());
  }
}

/**
 * Every caller-supplied field is validated before `createRun` runs, so a throw from the store at
 * that point is a SERVER condition — a full or locked database, or an exhausted id space. Mapping
 * those to 400 would blame the caller for something they cannot fix and would put internal SQLite
 * strings on the wire. Anything the store rejects that we somehow missed is still a 400.
 */
const STORE_VALIDATION_MESSAGES = [/^task /, /^unknown driver/, /^unknown actor/, /^payload must be/, /^invalid event type/];

function createFailure(err: unknown): HttpError {
  const message = err instanceof Error ? err.message : String(err);
  if (STORE_VALIDATION_MESSAGES.some((re) => re.test(message))) return invalidInput(message);
  log.error('run create failed', { error: message });
  return internalError();
}

/**
 * `preRead` is set only on the fallback path, where the ownership hop already consumed the request
 * stream. Reading `req` again there would yield an empty body and reject a perfectly good create.
 */
async function handleCreate(
  req: IncomingMessage,
  opts: RunsRequestOptions,
  store: RunsStore,
  preRead?: unknown,
): Promise<void> {
  const cap = bodyCapFor(RUNS_ROUTE_LABEL);
  let body: unknown;
  if (preRead !== undefined) {
    body = preRead;
  } else {
    try {
      body = await readJsonBodyCapped(req, cap);
    } catch (err) {
      opts.sendError(err instanceof BodyTooLargeError ? bodyTooLarge(cap) : invalidJson());
      return;
    }
  }

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    opts.sendError(invalidInput('Body must be a JSON object.'));
    return;
  }
  const input = body as Record<string, unknown>;

  const task = input.task;
  if (typeof task !== 'string' || task.trim().length === 0) {
    opts.sendError(invalidInput('Field "task" is required and must be a non-empty string.'));
    return;
  }
  if (task.length > MAX_TASK_CHARS) {
    opts.sendError(invalidInput(`Field "task" exceeds ${MAX_TASK_CHARS} characters.`));
    return;
  }

  // Every field here is persisted twice — into the event log and into the run's `events.jsonl` — so
  // an uncapped string is a disk-fill primitive, not a cosmetic gap. The body cap alone would let
  // one request write a megabyte of `spaceId`.
  if (input.spaceId !== undefined && (typeof input.spaceId !== 'string' || input.spaceId.length > MAX_SPACE_ID_CHARS)) {
    opts.sendError(invalidInput(`Field "spaceId" must be a string of at most ${MAX_SPACE_ID_CHARS} characters.`));
    return;
  }

  let driver: Driver | undefined;
  if (input.driver !== undefined) {
    const parsed = parseDriver(input.driver);
    if (!parsed.ok) {
      opts.sendError(invalidInput(parsed.detail));
      return;
    }
    driver = parsed.driver;
  }

  try {
    const run = await store.create({
      task,
      ...(typeof input.spaceId === 'string' ? { spaceId: input.spaceId } : {}),
      ...(driver ? { driver } : {}),
    });
    opts.respond(201, { ok: true, run });
  } catch (err) {
    opts.sendError(createFailure(err));
  }
}

function parseDriver(raw: unknown): { ok: true; driver: Driver } | { ok: false; detail: string } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, detail: 'Field "driver" must be an object.' };
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.kind !== 'string' || !DRIVER_KINDS.has(obj.kind)) {
    return { ok: false, detail: `Field "driver.kind" must be one of ${[...DRIVER_KINDS].join(', ')}.` };
  }
  const driver: Driver = { kind: obj.kind as DriverKind };
  if (obj.client !== undefined) {
    const client = obj.client as Record<string, unknown> | null;
    if (client === null || typeof client !== 'object' || Array.isArray(client)
      || typeof client.name !== 'string' || typeof client.version !== 'string') {
      return { ok: false, detail: 'Field "driver.client" must be { name: string, version: string }.' };
    }
    if (client.name.length > MAX_CLIENT_FIELD_CHARS || client.version.length > MAX_CLIENT_FIELD_CHARS) {
      return { ok: false, detail: `Fields "driver.client.name" and "driver.client.version" are capped at ${MAX_CLIENT_FIELD_CHARS} characters.` };
    }
    driver.client = { name: client.name, version: client.version };
  }
  return { ok: true, driver };
}

async function handleList(opts: RunsRequestOptions, store: RunsStore): Promise<void> {
  const params = opts.url.searchParams;

  let status: RunStatus[] | undefined;
  const rawStatus = params.get('status');
  if (rawStatus !== null) {
    const parts = rawStatus.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
    const unknown = parts.find((p) => !RUN_STATUSES.has(p));
    if (parts.length === 0 || unknown !== undefined) {
      opts.sendError(invalidInput(`Query "status" must be a comma-separated list of ${[...RUN_STATUSES].join(', ')}.`));
      return;
    }
    status = parts as RunStatus[];
  }

  let limit: number | undefined;
  const rawLimit = params.get('limit');
  if (rawLimit !== null) {
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIST_LIMIT) {
      opts.sendError(invalidInput(`Query "limit" must be an integer between 1 and ${MAX_LIST_LIMIT} (default ${DEFAULT_LIST_LIMIT}).`));
      return;
    }
    limit = parsed;
  }

  const spaceId = params.get('spaceId') ?? undefined;
  const cursor = params.get('cursor') ?? undefined;

  const result = await store.list({
    ...(status ? { status } : {}),
    ...(spaceId ? { spaceId } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(cursor ? { cursor } : {}),
  });
  opts.respond(200, {
    ok: true,
    runs: result.runs,
    ...(result.nextCursor ? { next_cursor: result.nextCursor } : {}),
  });
}

/**
 * `new URL` does not percent-decode `pathname`, so a malformed escape reaches us intact and
 * `decodeURIComponent` throws a `URIError` on it. That is a caller's bad id, not a server fault —
 * reporting it as a 500 would also make an un-authenticated typo an error-log amplifier.
 */
function decodeRunId(rawId: string): string | null {
  try {
    return decodeURIComponent(rawId);
  } catch {
    return null;
  }
}

async function handleGet(opts: RunsRequestOptions, store: RunsStore, rawId: string): Promise<void> {
  const decoded = decodeRunId(rawId);
  const run = decoded === null ? undefined : await store.get(decoded);
  if (!run) {
    opts.sendError(runNotFound());
    return;
  }
  opts.respond(200, { ok: true, run });
}

/**
 * Resume point, in the spec's precedence order. `Last-Event-ID` wins because it is what an SSE
 * client re-sends by itself on reconnect — honouring the query string over it would silently replay
 * from a stale point the client never asked for.
 *
 * Both forms mean "I have everything up to and including this seq".
 */
export function resolveSince(
  lastEventIdHeader: string | string[] | undefined,
  sinceQuery: string | null,
): { ok: true; since: number } | { ok: false; detail: string } {
  const header = Array.isArray(lastEventIdHeader) ? lastEventIdHeader[0] : lastEventIdHeader;
  const raw = header !== undefined && header.trim() !== '' ? header.trim() : sinceQuery;
  if (raw === null || raw === undefined || raw === '') return { ok: true, since: 0 };
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return { ok: false, detail: 'Resume point must be a non-negative integer sequence number (Last-Event-ID header or ?since=).' };
  }
  return { ok: true, since: parsed };
}

/**
 * The exactly-once door. Everything the stream writes — replayed or live — goes through `emit`, and
 * `offer` is what the live subscription calls.
 *
 * Two rules, and both are load-bearing only because replay yields to the event loop between pages:
 *
 *  - While replaying, a live event is HELD. Emitting it immediately would put a newer seq on the
 *    wire ahead of older ones the replay has not reached yet.
 *  - A held event whose seq the replay already covered is DROPPED, not written again. The overlap
 *    window is real: an event appended during a yield is both published to us and visible to the
 *    next page's query.
 *
 * Together they are why a reconnecting client gets each seq exactly once with no coordination.
 */
/**
 * Wait for the socket to accept more, or for the connection to die — whichever comes first.
 * Waiting on `'drain'` alone would hang the replay forever on a client that vanished mid-page.
 */
function waitForDrain(res: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.on('drain', done);
    res.on('close', done);
  });
}

export interface OrderedEmitter {
  emit(event: RunEvent): void;
  offer(event: RunEvent): void;
  goLive(): void;
  lastEmitted(): number;
  /** True once the hold buffer hit its ceiling and was dropped. The stream must then END. */
  overflowed(): boolean;
}

export function createOrderedEmitter(
  since: number,
  write: (event: RunEvent) => void,
  maxHeld: number = maxHeldEvents(),
): OrderedEmitter {
  let last = since;
  let replaying = true;
  let overflow = false;
  const held: RunEvent[] = [];

  const emit = (event: RunEvent): void => {
    if (event.seq <= last) return;
    last = event.seq;
    write(event);
  };

  return {
    emit,
    offer(event) {
      if (!replaying) {
        emit(event);
        return;
      }
      // Nothing more is worth holding: the buffer is gone and the stream is ending.
      if (overflow) return;
      // The replay has already passed this seq, so the durable read covered it and `goLive` would
      // drop it anyway. Not holding it is what keeps an append storm the replay is KEEPING UP with
      // from spending the ceiling on events nobody would ever have written.
      if (event.seq <= last) return;
      if (held.length >= maxHeld) {
        held.length = 0;
        overflow = true;
        return;
      }
      held.push(event);
    },
    goLive() {
      replaying = false;
      const pending = held.splice(0);
      pending.sort((a, b) => a.seq - b.seq);
      for (const event of pending) emit(event);
    },
    lastEmitted: () => last,
    overflowed: () => overflow,
  };
}

async function handleEvents(
  req: IncomingMessage,
  res: ServerResponse,
  opts: RunsRequestOptions,
  store: RunsStore,
  rawId: string,
): Promise<void> {
  const decoded = decodeRunId(rawId);
  if (decoded === null) {
    opts.sendError(runNotFound());
    return;
  }
  const id = normalizeRunId(decoded);
  // Existence only — `get` would project the run, reading the whole log, which is exactly what the
  // paged replay below exists to avoid doing in one burst.
  if (!(await store.exists(id))) {
    opts.sendError(runNotFound());
    return;
  }

  const resume = resolveSince(req.headers['last-event-id'], opts.url.searchParams.get('since'));
  if (!resume.ok) {
    opts.sendError(invalidInput(resume.detail));
    return;
  }

  if (openSseConnections >= maxSseConnections()) {
    opts.sendError(tooManyRequests());
    return;
  }

  // This route deliberately escapes the request-work discipline the tool routes run under: a
  // deadline would 504 a healthy stream, and a concurrency slot held for the life of a tail would
  // starve the pool. The SSE connection cap above is what bounds it instead. Auth already ran.
  res.setTimeout(0);
  req.socket?.setTimeout(0);

  openSseConnections++;

  let closed = false;
  let lastWrite = Date.now();
  let needsDrain = false;

  // One repeating timer rather than a clear+set per event: a long replay would otherwise churn two
  // timer operations per envelope. The heartbeat only has to notice SILENCE, which a timestamp
  // answers in O(1).
  const heartbeat = setInterval(() => {
    if (closed) return;
    if (Date.now() - lastWrite < SSE_HEARTBEAT_MS) return;
    res.write(': ping\n\n');
    lastWrite = Date.now();
  }, SSE_HEARTBEAT_MS);
  heartbeat.unref?.();

  const emitter = createOrderedEmitter(resume.since, (event) => {
    if (closed) return;
    // Wire safety rests on the store's event-type grammar (`EVENT_TYPE_GRAMMAR`, run-store.ts):
    // `type` cannot contain CR or LF, so it cannot forge an SSE field line here. `data` is
    // JSON.stringify, which escapes both. Relax that grammar and this interpolation becomes an
    // injection point — `refuses an event type that could forge an SSE frame` pins it.
    needsDrain = !res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    lastWrite = Date.now();
  });

  // Step 1 — subscribe BEFORE reading the log, so nothing appended during the replay is missed.
  const unsubscribe = subscribeRunEvents(id, (event) => emitter.offer(event));

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    unsubscribe();
    clearInterval(heartbeat);
    openSseConnections--;
  };
  req.on('close', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);

  // The handler reached here across two awaits (the router's dynamic import and the store resolve).
  // A client that aborted during either one has ALREADY emitted 'close', so the listeners above will
  // never fire — and `res.write` on a destroyed response emits no 'error' either, so nothing else
  // would notice. Left unhandled, each lost race permanently leaks a connection slot (the route
  // 429s forever once 32 accumulate), a bus listener holding a dead response, and a live timer.
  if (req.destroyed || res.destroyed) {
    cleanup();
    res.end();
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Tells any reverse proxy in front of a self-hosted daemon not to buffer the stream.
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  res.write(`retry: ${SSE_RETRY_MS}\n\n`);
  lastWrite = Date.now();

  try {
    // Step 2 — the durable replay, a page at a time. Nothing is dropped here: the backing log is
    // the DB, not a ring. The yield between pages is what keeps a long log from freezing the daemon,
    // and is also what makes the emitter's overlap window real.
    const pageSize = replayPageSize();
    let cursor = resume.since;
    for (;;) {
      if (closed) return;
      const page = await store.eventsSince(id, cursor, pageSize);
      if (page.length === 0) break;
      for (const event of page) emitter.emit(event);
      cursor = page[page.length - 1].seq;
      // Replay is the only unbounded producer on this stream — the live path is paced by the run
      // itself. A client that opens a tail and stops reading would otherwise pull the whole log into
      // the daemon's heap, so wait for the socket to drain instead of racing ahead of it.
      if (needsDrain) {
        await waitForDrain(res);
        needsDrain = false;
      }
      if (closed) return;
      if (page.length < pageSize) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  } catch (err) {
    log.error('run event replay failed', { runId: id, error: String(err) });
    cleanup();
    res.end();
    return;
  }

  // Step 3 — release whatever arrived mid-replay through the same door, then run live.
  //
  // Unless the run out-appended the hold buffer, in which case the events it dropped are still in
  // the durable log and the honest move is to end the stream: the client reconnects with the last
  // seq it actually saw and replays the gap. Going live over a dropped buffer would skip those seqs
  // silently, which is the one thing this route promises never to do.
  if (emitter.overflowed()) {
    log.warn('run tail dropped its replay hold buffer under an append storm; ending the stream so the client resumes', {
      runId: id,
      lastEmitted: emitter.lastEmitted(),
    });
    cleanup();
    res.end();
    return;
  }
  emitter.goLive();
}
