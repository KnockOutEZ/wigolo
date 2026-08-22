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
  getRun,
  listRuns,
  eventsSince,
  normalizeRunId,
  MAX_TASK_CHARS,
  MAX_LIST_LIMIT,
  DEFAULT_LIST_LIMIT,
  type Driver,
  type DriverKind,
  type RunEvent,
  type RunStatus,
} from '../../studio/run-store.js';
import { createRunWithTail, subscribeRunEvents } from '../../studio/run-bus.js';

const log = createLogger('rest');

/** The route label used for body caps and log lines. `bodyCapFor` gives it the 1 MiB default. */
export const RUNS_ROUTE_LABEL = 'runs';

const RUN_STATUSES = new Set<string>(['running', 'needs_you', 'paused', 'done', 'failed', 'cancelled']);
const DRIVER_KINDS = new Set<string>(['cli', 'sdk', 'api', 'studio', 'human']);

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

function replayPageSize(): number {
  const raw = process.env.WIGOLO_STUDIO_RUN_REPLAY_PAGE;
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_REPLAY_PAGE;
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
 * running without it (studio-only mode) must say so with a structured 503 rather than a stack.
 */
async function resolveDb(opts: RunsRequestOptions): Promise<Database.Database | null> {
  if (opts.openDb) {
    try {
      return opts.openDb();
    } catch {
      return null;
    }
  }
  try {
    const { getDatabase } = await import('../../cache/db.js');
    return getDatabase();
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

  const db = await resolveDb(opts);
  if (!db) {
    opts.sendError(storeUnavailable());
    return;
  }

  try {
    if (route.kind === 'collection') {
      if (method === 'POST') await handleCreate(req, opts, db);
      else handleList(opts, db);
      return;
    }
    if (route.kind === 'item') {
      handleGet(opts, db, route.id);
      return;
    }
    await handleEvents(req, res, opts, db, route.id);
  } catch (err) {
    log.error('runs route failed', { route: route.kind, error: String(err) });
    opts.sendError(internalError());
  }
}

/** Store-level validation errors are the caller's fault, not ours — they must not surface as 500s. */
function invalidInputFrom(err: unknown): HttpError {
  return invalidInput(err instanceof Error ? err.message : String(err));
}

async function handleCreate(req: IncomingMessage, opts: RunsRequestOptions, db: Database.Database): Promise<void> {
  const cap = bodyCapFor(RUNS_ROUTE_LABEL);
  let body: unknown;
  try {
    body = await readJsonBodyCapped(req, cap);
  } catch (err) {
    opts.sendError(err instanceof BodyTooLargeError ? bodyTooLarge(cap) : invalidJson());
    return;
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

  if (input.spaceId !== undefined && typeof input.spaceId !== 'string') {
    opts.sendError(invalidInput('Field "spaceId" must be a string.'));
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
    const run = createRunWithTail(db, {
      task,
      ...(typeof input.spaceId === 'string' ? { spaceId: input.spaceId } : {}),
      ...(driver ? { driver } : {}),
    });
    opts.respond(201, { ok: true, run });
  } catch (err) {
    opts.sendError(invalidInputFrom(err));
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
    driver.client = { name: client.name, version: client.version };
  }
  return { ok: true, driver };
}

function handleList(opts: RunsRequestOptions, db: Database.Database): void {
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

  const result = listRuns(db, {
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

function handleGet(opts: RunsRequestOptions, db: Database.Database, rawId: string): void {
  const run = getRun(db, decodeURIComponent(rawId));
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
export interface OrderedEmitter {
  emit(event: RunEvent): void;
  offer(event: RunEvent): void;
  goLive(): void;
  lastEmitted(): number;
}

export function createOrderedEmitter(since: number, write: (event: RunEvent) => void): OrderedEmitter {
  let last = since;
  let replaying = true;
  const held: RunEvent[] = [];

  const emit = (event: RunEvent): void => {
    if (event.seq <= last) return;
    last = event.seq;
    write(event);
  };

  return {
    emit,
    offer(event) {
      if (replaying) held.push(event);
      else emit(event);
    },
    goLive() {
      replaying = false;
      const pending = held.splice(0);
      pending.sort((a, b) => a.seq - b.seq);
      for (const event of pending) emit(event);
    },
    lastEmitted: () => last,
  };
}

async function handleEvents(
  req: IncomingMessage,
  res: ServerResponse,
  opts: RunsRequestOptions,
  db: Database.Database,
  rawId: string,
): Promise<void> {
  const id = normalizeRunId(decodeURIComponent(rawId));
  if (!getRun(db, id)) {
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

  let heartbeat: NodeJS.Timeout | undefined;
  let closed = false;

  const armHeartbeat = (): void => {
    if (heartbeat) clearTimeout(heartbeat);
    heartbeat = setTimeout(() => {
      if (closed) return;
      res.write(': ping\n\n');
      armHeartbeat();
    }, SSE_HEARTBEAT_MS);
    heartbeat.unref?.();
  };

  const emitter = createOrderedEmitter(resume.since, (event) => {
    if (closed) return;
    res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    armHeartbeat();
  });

  // Step 1 — subscribe BEFORE reading the log, so nothing appended during the replay is missed.
  const unsubscribe = subscribeRunEvents(id, (event) => emitter.offer(event));

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    unsubscribe();
    if (heartbeat) clearTimeout(heartbeat);
    openSseConnections--;
  };
  req.on('close', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Tells any reverse proxy in front of a self-hosted daemon not to buffer the stream.
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  res.write(`retry: ${SSE_RETRY_MS}\n\n`);
  armHeartbeat();

  try {
    // Step 2 — the durable replay, a page at a time. Nothing is dropped here: the backing log is
    // the DB, not a ring. The yield between pages is what keeps a long log from freezing the daemon,
    // and is also what makes the emitter's overlap window real.
    const pageSize = replayPageSize();
    let cursor = resume.since;
    for (;;) {
      if (closed) return;
      const page = eventsSince(db, id, cursor, pageSize);
      if (page.length === 0) break;
      for (const event of page) emitter.emit(event);
      cursor = page[page.length - 1].seq;
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
  emitter.goLive();
}
