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
  resolveRunId,
  isValidListCursor,
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

/**
 * The two vocabularies this route enforces, exported so `openapi.ts` documents exactly what the
 * router accepts. A second literal copy in the served document is a contract that can drift green.
 */
export const RUN_STATUS_VALUES: readonly string[] = ['running', 'needs_you', 'paused', 'done', 'failed', 'cancelled'];
export const DRIVER_KIND_VALUES: readonly string[] = ['cli', 'sdk', 'api', 'studio', 'human'];

const RUN_STATUSES = new Set<string>(RUN_STATUS_VALUES);
const DRIVER_KINDS = new Set<string>(DRIVER_KIND_VALUES);

/** Persisted into the log AND onto disk, so both need a bound the 1 MiB body cap does not give. */
export const MAX_SPACE_ID_CHARS = 200;
export const MAX_CLIENT_FIELD_CHARS = 200;

/** SSE frames are long-lived sockets, so they are capped separately from the request slot pool. */
const DEFAULT_MAX_SSE_CONNECTIONS = 32;
/**
 * Idle streams get a comment frame so intermediaries do not reap them and dead peers surface.
 *
 * It is also the stream's only clock, which is why the silence reconcile (see `reconcile` in
 * `handleEvents`) rides on it: the interval fires exactly when nothing has been written for a full
 * period, which is the one state a lost terminal notify can hide in.
 */
const DEFAULT_SSE_HEARTBEAT_MS = 15_000;
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
/**
 * The same ceiling in the unit the heap actually grows in.
 *
 * A count alone bounds the wrong thing: an event's payload is capped at `MAX_EVENT_PAYLOAD_CHARS`
 * (64k), so 2048 held events is a ~257 MB hold buffer PER TAIL and the count never notices. Events
 * are small in practice, which is exactly why the count is the ceiling that normally trips — this
 * one exists for the traffic where it does not. Overflow behaviour is identical whichever ceiling
 * trips: the buffer is dropped and the stream ends, because half a buffer delivered is a hole in
 * the middle of the stream.
 *
 * THE UNIT IS RETAINED BYTES, NOT WIRE BYTES — see `SerializedEvent.retainedBytes`. This used to be
 * spent in the serialized envelope's JSON length, which is a third of what a held entry actually
 * keeps alive: the entry holds the ENVELOPE, the envelope keys the `serializedEvents` WeakMap, and
 * so the cached strings AND the parsed payload graph all stay reachable for exactly as long as the
 * entry does. Measured at the 64 KB payload ceiling: 65,643 charged against 196,917 retained, a 3.0x
 * undercharge — an 8 MB ceiling was really a ~24 MB buffer, and the 32-connection cap across 32
 * distinct runs reasoned about 256 MB while holding ~750 MB.
 *
 * Two changes make 8 MB here mean 8 MB of heap: the WeakMap record stopped retaining a second copy
 * of the payload nobody read (~196,917 -> ~131,524 per held event), and the charge became the figure
 * that survives (~131,828). Charge and retention now agree to ~0.2% at that ceiling.
 */
const DEFAULT_MAX_HELD_BYTES = 8 * 1024 * 1024;
/**
 * How many bytes any bulk write path may hand the socket before it stops and asks how the socket is
 * doing.
 *
 * The hold buffer already wrote down that a count bounds the wrong thing (see `DEFAULT_MAX_HELD_BYTES`)
 * and then applied it only to itself. Every other bulk writer on this route counted ITEMS: replay
 * checked drain once per PAGE, and a page is 500 events whose payloads are capped at 64k each, so
 * "one page" is up to ~32 MB handed to a socket that already said it was full. The budget below is
 * the same reasoning in the same unit, shared by the replay loop and the `goLive` flush so neither
 * can drift from the other.
 */
const DEFAULT_SSE_FLUSH_BYTES = 256 * 1024;
/**
 * How much a reader that has stopped reading may accumulate in this process before its tail ENDS.
 *
 * `res.write` returning false means the socket has not taken the frame; the bytes live in Node's
 * userland buffer until the peer reads. Live frames are paced by the run, not by us, so there is no
 * drain we could await that does not mean "hold the rest of the run in heap for as long as it runs".
 * Past this budget the honest move is the one the hold-buffer overflow already takes: end the stream
 * and let the client resume from `Last-Event-ID` against the durable log. Nothing is lost — the log
 * is the source of truth and the resume door is the same one every reconnect uses. See A-88-1.
 */
const DEFAULT_SSE_MAX_STALLED_BYTES = 4 * 1024 * 1024;
/**
 * How many heartbeat intervals a single drain wait may spend before the tail ends.
 *
 * `DEFAULT_SSE_MAX_STALLED_BYTES` bounds the reader that keeps taking frames too slowly. It does not
 * bound the reader that stops taking them ALTOGETHER while holding the socket open, because that
 * reader is never handed another byte: the await parks, so `stalledBytes` cannot grow past its
 * budget, and the heartbeat — the stream's only other writer — returns early on `needsDrain` and so
 * never writes the ping that would notice. Nothing else is left. The events route is exempt from the
 * router's slot and deadline discipline by design, so a parked drain holds its connection slot until
 * the daemon restarts, and `maxSseConnections()` of them 429 the route permanently.
 *
 * The wait therefore carries its own clock. It is expressed in heartbeats rather than in absolute
 * milliseconds so the one knob that already governs "how long may this stream say nothing" governs
 * this too — a deployment that widens the heartbeat widens the patience that hangs off it.
 */
const SSE_DRAIN_HEARTBEATS = 4;

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

function maxHeldBytes(): number {
  const raw = process.env.WIGOLO_STUDIO_SSE_MAX_HELD_BYTES;
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_HELD_BYTES;
}

function sseFlushBytes(): number {
  const raw = process.env.WIGOLO_STUDIO_SSE_FLUSH_BYTES;
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_SSE_FLUSH_BYTES;
}

function sseMaxStalledBytes(): number {
  const raw = process.env.WIGOLO_STUDIO_SSE_MAX_STALLED_BYTES;
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_SSE_MAX_STALLED_BYTES;
}

function sseHeartbeatMs(): number {
  const raw = process.env.WIGOLO_STUDIO_SSE_HEARTBEAT_MS;
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_SSE_HEARTBEAT_MS;
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

/**
 * A held connection slot. Released exactly once, whoever gets there first: the stream's `cleanup`,
 * an early return, or the outer handler's `finally` when something threw between them.
 */
export interface SseSlot {
  release(): void;
}

/**
 * The events route's ONLY meter, taken before the route does any work at all.
 *
 * It used to be taken deep inside the stream handler — after the ownership resolve (a synchronous
 * handle read) and after `store.exists`, which on the studio host is a broker RPC holding a
 * pending-map entry for up to the call timeout. Everything before the check was therefore metered by
 * nothing but the socket limit, and the 404 for an id that does not exist returned BEFORE the check
 * and so was metered by nothing at all: K requests for a nonexistent run bought K concurrent owner
 * resolves and K broker round-trips for free. The slot is now the first thing the route touches, so
 * the preamble is inside the bound rather than in front of it.
 *
 * The bound is FLEET-WIDE and deliberately so: one counter for the whole daemon, with no per-caller
 * share. A single client can therefore hold every slot and 429 everyone else off the route until it
 * lets go. That is accepted here because the daemon is a local, loopback, single-tenant surface —
 * the callers are this machine's own clients — so the bound exists to cap the process's socket and
 * heap footprint, not to arbitrate between mutually distrusting tenants. Per-caller fairness or
 * accounting is a recorded non-goal (`wigolo-studio-run#88`); it becomes required the day this
 * route is exposed to callers that do not already share a trust boundary, and the honest reading
 * until then is that availability of the tail is not defended against a local caller that wants it.
 */
function acquireSseSlot(): SseSlot | null {
  if (openSseConnections >= maxSseConnections()) return null;
  openSseConnections++;
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      openSseConnections--;
    },
  };
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

  // The events route is the one surface that escapes the router's slot and deadline discipline, so
  // its own cap has to be the FIRST thing it does — before the ownership resolve, before the store
  // resolve, before any existence check. Held for the life of the request: a proxied tail resolves
  // only when the stream dies, and a 404 releases on the way out.
  const slot = route.kind === 'events' ? acquireSseSlot() : null;
  if (route.kind === 'events' && !slot) {
    opts.sendError(tooManyRequests());
    return;
  }
  let slotHandedOff = false;
  try {
    await handleRunsRoute(req, res, opts, route, method, slot, () => { slotHandedOff = true; });
  } finally {
    if (!slotHandedOff) slot?.release();
  }
}

async function handleRunsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  opts: RunsRequestOptions,
  route: RunsRoute,
  method: string,
  slot: SseSlot | null,
  handOffSlot: () => void,
): Promise<void> {
  // Ownership BEFORE the store resolve (SD1 §6 / A-43-5). A standalone daemon running beside a live
  // studio host has a perfectly good DB handle of its own — that is exactly the trap. Opening it
  // first and only then asking who owns the run would make the answer look optional, and the whole
  // rule exists because two processes appending to one log fan their live tails out separately.
  //
  // A BOUND store is the exception, and it is not a shortcut: a process is handed one only by the
  // host that owns the store (the Electron gateway passes its broker-backed store — SD1 §6 /
  // A-43-5), so the answer is `local` by construction and resolving it would be a synchronous handle
  // read plus an interface enumeration per request to re-derive a constant.
  const owner: RunsOwner = opts.store ? { kind: 'local' } : (opts.resolveOwner ?? resolveRunsOwner)();
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
    // Past here the stream owns the slot: it outlives this call, and `cleanup` is what gives it back.
    handOffSlot();
    await handleEvents(req, res, opts, store, route.id, slot);
  } catch (err) {
    // Idempotent, and the one path where the stream may have taken the slot without reaching the
    // `cleanup` that hands it back — a slot leaked here is permanent for the life of the process.
    slot?.release();
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
  if (input.spaceId !== undefined) {
    if (typeof input.spaceId !== 'string' || input.spaceId.length > MAX_SPACE_ID_CHARS) {
      opts.sendError(invalidInput(`Field "spaceId" must be a string of at most ${MAX_SPACE_ID_CHARS} characters.`));
      return;
    }
    // An empty or whitespace-only space is not a smaller version of a valid one, it is a run nobody
    // can find. The `?? DEFAULT_SPACE_ID` substitution downstream fires only on `undefined`, so `""`
    // is persisted verbatim and the run is then invisible to `?spaceId=default` — the filter every
    // surface lists with — while still being a live run holding tabs. Validated on the trimmed value
    // and persisted verbatim, which is exactly what `task` above already does: trimming here would
    // quietly rewrite a caller's identifier, and the durable log is the wrong place to be clever.
    if (input.spaceId.trim().length === 0) {
      opts.sendError(invalidInput('Field "spaceId" must not be empty or whitespace-only. Omit it to use the default space.'));
      return;
    }
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
    // Accepted on write and erased on read is worse than either answer alone: the store rebuilds the
    // badge with `name && version` (`clientOf`, run-store.ts), so an empty string drops the WHOLE
    // client — the caller is told 201 for a badge that no surface will ever show. Law 3 makes the
    // driver shown identically everywhere; a field that silently evaporates between write and read
    // is the one shape that cannot be.
    if (client.name.trim().length === 0 || client.version.trim().length === 0) {
      return { ok: false, detail: 'Fields "driver.client.name" and "driver.client.version" must not be empty or whitespace-only. Omit "driver.client" instead.' };
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
  // A cursor that does not decode used to be treated as no cursor at all, so a corrupted or
  // truncated one silently restarted pagination — a client paging in a loop never terminates, and
  // one processing each page double-processes the first. `status` and `limit` are already 400s.
  if (cursor && !isValidListCursor(cursor)) {
    opts.sendError(invalidInput('Query "cursor" is not a cursor this server issued. Start the page again without it.'));
    return;
  }

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
 * A resume point the durable log cannot back, clamped back down to one it can.
 *
 * `resolveSince` validates the SHAPE of a cursor and nothing else, so a client can ask to resume
 * past the end of the run's log. That request opens a stream which is silent forever: the replay
 * finds nothing, the monotone emitter then drops every live event (`seq <= last`) because `last`
 * starts at the bogus cursor, and the silence reconcile probes past the tail and keeps finding
 * nothing. The heartbeat holds the connection open, so the client never reconnects and never learns
 * — every event of the run is swallowed until the log grows past the cursor. It is reachable
 * without a malicious client: a restored or rebuilt DB, or an `EventSource` re-sending a
 * `Last-Event-ID` it persisted against a run id that has since been re-minted.
 *
 * The check is the client's own claim, turned into a question the log can answer: "I have
 * everything up to and including `since`" is false if the log holds no event at or past `since`.
 * One indexed seek, only on a resumed tail — the same shape and cost as the silence probe, and it
 * keeps the pruned-log case intact, where the first surviving row is PAST the cursor and the read
 * comes back non-empty.
 *
 * Clamping to zero rather than to the tail exactly: the tail's seq is not on `RunsStore` and
 * putting it there is a six-seam change across the broker and the app-side stores. Zero is a
 * downward clamp reachable with the existing API which is provably at or below the tail, and it
 * delivers strictly MORE than a tail clamp would — the client whose cursor belongs to a rebuilt log
 * gets this run's history rather than only its future. See `DECISIONS-AUTO.md` (A-113-1).
 */
async function clampResumePoint(
  store: RunsStore,
  runId: string,
  since: number,
): Promise<{ since: number; clamped: boolean }> {
  if (since <= 0) return { since, clamped: false };
  let atOrPast: RunEvent[];
  try {
    atOrPast = await store.eventsSince(runId, since - 1, 1);
  } catch (err) {
    // A probe that could not run is not evidence of a bogus cursor. Resyncing every resumed tail
    // the moment the store hiccups would spend a full replay on each one, so honour it as given —
    // the same call the silence reconcile makes on the same failure.
    log.warn('run tail could not check its resume point against the durable log; honouring it as given', {
      runId,
      since,
      error: String(err),
    });
    return { since, clamped: false };
  }
  if (atOrPast.length > 0) return { since, clamped: false };
  return { since: 0, clamped: true };
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
 * Wait for the socket to accept more, for the connection to die, or for the deadline — whichever
 * comes first. Resolves `true` when the socket moved (drained or closed) and `false` on expiry.
 *
 * Waiting on `'drain'` alone would hang the replay forever on a client that vanished mid-page, and
 * adding `'close'` covers only the client that vanishes NOISILY. A peer that stops reading while
 * holding the TCP connection open emits neither event, ever: no drain because it is not reading, no
 * close because it has not left. That wait is unbounded and its caller holds a connection slot for
 * the life of the process — see `SSE_DRAIN_HEARTBEATS`. The deadline is what makes it a wait rather
 * than a leak, and the caller answers an expiry the same way every other back-pressure door on this
 * route answers: end the stream and let the client resume from `Last-Event-ID` against the log.
 */
function waitForDrain(res: ServerResponse, deadlineMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (drained: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      res.off?.('drain', moved);
      res.off?.('close', moved);
      resolve(drained);
    };
    const moved = (): void => { finish(true); };
    // Unref'd: a tail waiting on a stalled socket must not be the reason the process stays up.
    const timer = setTimeout(() => { finish(false); }, deadlineMs);
    timer.unref?.();
    res.on('drain', moved);
    res.on('close', moved);
  });
}

/**
 * Called by every bulk write path after each event, and awaited.
 *
 * It is where "how is the socket doing" lives, so the replay loop and the `goLive` flush share one
 * budget and one drain gate instead of each inventing its own. Returning `false` means stop — the
 * connection is gone, or the caller has decided to end the stream.
 */
export type WritePace = () => Promise<boolean> | boolean;

export interface OrderedEmitter {
  emit(event: RunEvent): void;
  offer(event: RunEvent): void;
  /**
   * Release the held events in seq order, then switch to live.
   *
   * Paced, because the flush is up to `maxHeld` events / `maxBytes` bytes handed to the socket in
   * one burst at the exact moment that socket is most likely already full — the same shape the
   * replay loop has, so it takes the same gate. The emitter stays in `replaying` for the whole
   * flush: anything the bus offers while a pace awaits is HELD and picked up by the next pass,
   * which is what stops a late arrival overtaking the tail of the buffer.
   *
   * Callable more than once: the gap door puts the emitter back into `replaying`, so a heal ends the
   * same way the first replay does.
   */
  goLive(pace?: WritePace): Promise<void>;
  /**
   * Put a LIVE emitter back into holding, without an event to blame it on.
   *
   * The gap door does this from inside `emit` because it has one — a seq that arrived and exposed a
   * hole. The silence reconcile has the opposite shape: it learns from the STORE that seqs exist
   * which never arrived, so there is nothing to hold and no `emit` call to do it from, and the
   * durable read it is about to run must not race the bus onto the wire. Same end state as the gap
   * door leaves behind: everything offered from here queues in the buffer until the next `goLive`.
   *
   * A no-op on an emitter that is already holding, so a caller need not know which phase it is in.
   */
  suspend(): void;
  lastEmitted(): number;
  /**
   * Whether this stream has written a single frame yet.
   *
   * Not the same question as `lastEmitted() > 0`: on a resumed tail `last` starts at the client's
   * resume point, so a stream that has delivered nothing still reports a positive seq. The flush's
   * gap door needs the difference — see `goLive`.
   */
  hasDelivered(): boolean;
  /** True once the hold buffer hit its ceiling and was dropped. The stream must then END. */
  overflowed(): boolean;
}

interface HeldEvent {
  event: RunEvent;
  /**
   * Retained bytes, measured once at offer time — the flush pages on the same number the ceiling
   * was taken on. `SerializedEvent.retainedBytes`, never the frame's wire size: this entry is the
   * reason the envelope, its cached frame and its parsed graph are all still reachable.
   */
  bytes: number;
}

/**
 * What a held entry costs beyond the frame and the payload text it demonstrably retains: the
 * envelope's own object graph (`seq`/`ts`/`actor`/`type`/`payload` and their maps), the WeakMap
 * record, and the `HeldEvent` wrapper. A flat figure rather than a multiplier because this part
 * does not scale with the payload — measured 2026-08-27 at ~347 bytes for a `payload: {}` event and
 * ~65 bytes on top of the payload string for a 64 KB one.
 */
const HELD_ENTRY_OVERHEAD_BYTES = 512;

/**
 * Everything about an event that is the same for every subscriber — which is all of it.
 *
 * Every field here is retained for as long as the envelope is, so a field nobody spends is heap
 * nobody accounts for. This record used to carry the `json` string beside the `frame` built from
 * it; nothing ever read it back, and it cost a second copy of the payload — a third of what a held
 * entry retained, for a field with no consumer. It is gone. Add one back only with a reader.
 */
interface SerializedEvent {
  /** The finished frame. Byte-identical on every tail, because nothing in it varies by subscriber. */
  frame: string;
  /** `Buffer.byteLength(frame)` — what the pace and stall budgets are spent in. */
  frameBytes: number;
  /**
   * What one held entry keeps alive, and what the hold buffer charges against `maxBytes`.
   *
   * Two components, because holding the envelope holds both: the `frame` string (`frameBytes`), and
   * the parsed payload graph the frame was serialized FROM, which the entry pins by holding the
   * envelope itself. The graph is allowed for at the JSON text's own length plus
   * `HELD_ENTRY_OVERHEAD_BYTES` — the text is a close proxy, because for the payloads this ceiling
   * exists for it is mostly one big string that appears in both.
   *
   * Charging the JSON length ALONE — what this used to do — counted neither the frame nor the graph
   * and let a stalled reader hold ~3x its budget.
   *
   * Calibrated against measured heap retention, and an over-charge across the traffic this ceiling
   * exists for: at the 64 KB payload ceiling it charges 131,828 against a measured 131,524, and at a
   * `payload: {}` event 750 against a measured 468. It UNDER-charges one shape — a payload of many
   * tiny keys, where per-property V8 overhead outruns the JSON text that describes it (60 integer
   * keys: 1,776 charged against 3,309 measured, ~1.9x). That residual is bounded by
   * `DEFAULT_MAX_HELD_EVENTS` at ~6.5 MB per tail, i.e. INSIDE this ceiling rather than past it, so
   * it is a stated margin and not a second undercharge. Closing it would need a structure-aware
   * scan — an extra O(n) pass over every frame on the writer's stack — to bound a shape no run
   * currently emits.
   */
  retainedBytes: number;
}

const serializedEvents = new WeakMap<RunEvent, SerializedEvent>();

/**
 * One serialization per event, however many tails are open on the run.
 *
 * This used to happen inside the per-subscriber write callback, and `publishRunEvent` invokes that
 * callback once per listener on the WRITER's stack — it is the post-commit hook of `appendEvent`, so
 * the cost lands on whoever appended, not on the readers. Nothing in the frame varies by subscriber,
 * so an identical `JSON.stringify` ran N times per event: at the 32-connection cap and the 64 KB
 * payload ceiling that is milliseconds of writer-stack blocking per append. The hold buffer then
 * stringified the same envelope a second time just to learn how many bytes it was retaining.
 *
 * Keyed on the envelope's identity rather than on `(runId, seq)` because that identity IS the pair —
 * an envelope object is one run's one seq, and the log is append-only, so a hit can never be stale —
 * and because a WeakMap needs no eviction policy where a keyed cache on a long-lived run would.
 * A fan-out that handed each listener its own copy would simply miss and pay what it paid before;
 * `serializes a published event once however many subscribers are watching` is the row that goes red
 * if that ever becomes the live path.
 *
 * What it trades: a frame is now retained for as long as its envelope is reachable, where before it
 * was garbage the moment `res.write` returned. Both places that hold an envelope are already bounded
 * and both drop it soon — the hold buffer by `DEFAULT_MAX_HELD_BYTES`, and the replay by its page,
 * whose events go out of scope at the page boundary — so the added retention is one page's frames at
 * worst, the same ~32 MB figure `DEFAULT_SSE_FLUSH_BYTES` already reasons about. It is shared across
 * tails rather than per-tail: N tails hold the SAME envelope objects, because the bus publishes one.
 *
 * "One page's frames" was the replay's half of that trade and it stated the hold buffer's half
 * wrong. The hold buffer is not bounded in frames — it was bounded in the envelope's JSON length,
 * which does not count the frame this WeakMap keeps alive beside it, so the multiplier this record
 * adds to a held entry never appeared in the figure `DEFAULT_MAX_HELD_BYTES` was reasoning about.
 * The ceiling is now spent in `retainedBytes`, which counts everything a live record holds; that is
 * what keeps the two halves of this trade honest against the same number.
 */
function serializeRunEvent(event: RunEvent): SerializedEvent {
  const cached = serializedEvents.get(event);
  if (cached !== undefined) return cached;
  // Wire safety rests on the store's event-type grammar (`EVENT_TYPE_GRAMMAR`, run-store.ts):
  // `type` cannot contain CR or LF, so it cannot forge an SSE field line here. `data` is
  // JSON.stringify, which escapes both. Relax that grammar and this interpolation becomes an
  // injection point — `refuses an event type that could forge an SSE frame` pins it.
  const json = JSON.stringify(event);
  const frame = `id: ${event.seq}\nevent: ${event.type}\ndata: ${json}\n\n`;
  const frameBytes = Buffer.byteLength(frame);
  const value: SerializedEvent = {
    frame,
    frameBytes,
    // The frame we retain, plus an allowance for the envelope graph a held entry pins alongside it.
    // See the field's doc for the calibration and for the one shape this under-covers.
    retainedBytes: frameBytes + Buffer.byteLength(json) + HELD_ENTRY_OVERHEAD_BYTES,
  };
  serializedEvents.set(event, value);
  return value;
}

export interface OrderedEmitterOptions {
  /**
   * What to do about a hole. Required, deliberately: an emitter with no gap policy is one that
   * writes `seq` N+2 straight after N and calls it delivery, which is the defect this door exists
   * to remove, so there is no default for a caller to inherit by omission.
   *
   * Called at most once per hole, with the last seq actually delivered and the seq that exposed the
   * hole. The emitter has already gone back to HOLDING by the time it fires — the triggering event
   * is in the buffer, and everything the bus offers next joins it — so the healer's job is to put
   * the missing seqs on the wire (or end the stream) and then call `goLive` again.
   */
  onGap: (from: number, arrivedAt: number) => void;
  maxHeld?: number;
  maxBytes?: number;
}

export function createOrderedEmitter(
  since: number,
  write: (event: RunEvent) => void,
  options: OrderedEmitterOptions,
): OrderedEmitter {
  const { onGap } = options;
  const maxHeld = options.maxHeld ?? maxHeldEvents();
  const maxBytes = options.maxBytes ?? maxHeldBytes();
  let last = since;
  let replaying = true;
  let overflow = false;
  /**
   * Set the first time a frame actually goes out. `last` cannot answer this — it starts at the
   * resume point — and the flush's gap door is unsound without the distinction.
   */
  let delivered = false;
  const held: HeldEvent[] = [];
  let heldBytes = 0;

  /**
   * Take an event into the hold buffer, or blow the ceiling and drop the lot.
   *
   * Shared by `offer` and the gap door below so both spend the same ceiling: a heal is a second
   * replay, and the events arriving during one grow this daemon's heap exactly the way the events
   * arriving during the first one do.
   */
  const hold = (event: RunEvent, measured?: number): void => {
    // Spent in RETAINED bytes, not wire bytes: the count says how MANY are held, this says how much
    // of the daemon's heap they own, and holding the envelope holds its cached frame and its parsed
    // graph along with it (see `SerializedEvent.retainedBytes`). `measured` is passed only when
    // the entry is coming BACK out of this same buffer (the flush's gap door re-holds), where
    // re-serializing to learn a number we already stored is pure waste — and it carries the same
    // unit, because it is the number this line put on the entry the first time round.
    const bytes = measured ?? serializeRunEvent(event).retainedBytes;
    if (held.length >= maxHeld || heldBytes + bytes > maxBytes) {
      held.length = 0;
      heldBytes = 0;
      overflow = true;
      return;
    }
    held.push({ event, bytes });
    heldBytes += bytes;
  };

  const emit = (event: RunEvent): void => {
    if (event.seq <= last) return;
    /**
     * The gap door — the live phase's half of the exactly-once promise.
     *
     * `seq > last + 1` while live means a seq that IS in the durable log never reached this stream:
     * the publish chain is a commit followed by a separate notify, so a writer that dies between
     * them, or a client-side buffer drop, loses one for an event that happened. Writing the newer
     * event anyway puts a permanent hole in a stream whose header promises none, and nothing
     * downstream can see it — heartbeats keep the connection alive, so the client never reconnects
     * and never resumes from `Last-Event-ID`. A lost `run.completed` is then a run every watcher
     * believes is still going.
     *
     * Only the LIVE phase. The replay pages the log in seq order by construction, and a gap there
     * would be the store's own, not a lost notify.
     */
    if (!replaying && event.seq > last + 1) {
      const from = last;
      // Back to holding BEFORE the healer is told, so everything the bus offers while it works
      // queues behind the missing seqs instead of racing them onto the wire.
      replaying = true;
      hold(event);
      onGap(from, event.seq);
      return;
    }
    last = event.seq;
    delivered = true;
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
      hold(event);
    },
    async goLive(pace) {
      // Drains to empty, not to "the buffer as it stood when we started": a pace that awaits gives
      // the bus a turn, and whatever it offered in that turn is still held behind us.
      for (;;) {
        const pending = held.splice(0);
        heldBytes = 0;
        if (pending.length === 0) break;
        pending.sort((a, b) => a.event.seq - b.event.seq);
        for (let i = 0; i < pending.length; i++) {
          const entry = pending[i];
          /**
           * The flush's half of the gap door, and it has to live HERE rather than in `emit`.
           *
           * `emit`'s door is live-only (`!replaying`), and the flush runs with `replaying` still
           * true, so a hold buffer that itself has a hole — a notify lost in the window between the
           * replay's last page and `goLive` — was written out whole. Simply dropping the
           * `!replaying` term does not fix it: measured 2026-08-23, that OOMs the process, because
           * `emit`'s door RE-HOLDS the event that tripped it and the drain-to-empty loop above then
           * re-splices and re-emits the same event forever. Deciding before the `emit` call and
           * RETURNING is what breaks that cycle — one pass, one hand-off, no second look.
           *
           * The predicate is not `seq > last + 1` alone either. During the flush `last` may still be
           * the resume point rather than a seq this stream delivered, so a log that legitimately
           * starts after `?since=` — a pruned log, or a reconnect whose next event has not committed
           * yet — would read as a hole and end a healthy stream. `delivered` is the difference: only
           * once a frame has actually gone out does `last + 1` mean "the next seq this client is
           * owed". A first held event past an undelivered resume point is deliberately let through;
           * `emit`'s live door and the silence reconcile cover the stream from there.
           */
          if (delivered && entry.event.seq > last + 1) {
            const from = last;
            const arrivedAt = entry.event.seq;
            // Everything from the hole onward goes back into the buffer — the healer's contract is
            // that the triggering event is held, and the rest of this buffer is in exactly the same
            // position. They queue behind whatever the bus offered while we flushed; the next pass
            // sorts, so order is restored there. Re-holding can blow the ceiling, in which case the
            // caller ends the stream, which is the same answer an append storm already gets.
            for (const rest of pending.slice(i)) {
              if (overflow) break;
              hold(rest.event, rest.bytes);
            }
            // `replaying` stays true: the emitter is already in the state the healer expects.
            onGap(from, arrivedAt);
            return;
          }
          emit(entry.event);
          if (pace !== undefined && (await pace()) === false) {
            replaying = false;
            return;
          }
        }
        // Out-appended mid-flush. The dropped seqs are still in the durable log, so the caller ends
        // the stream and the client resumes — flushing the rest would put a hole in the middle.
        if (overflow) break;
      }
      replaying = false;
    },
    suspend() {
      replaying = true;
    },
    lastEmitted: () => last,
    hasDelivered: () => delivered,
    overflowed: () => overflow,
  };
}

async function handleEvents(
  req: IncomingMessage,
  res: ServerResponse,
  opts: RunsRequestOptions,
  store: RunsStore,
  rawId: string,
  slot: SseSlot | null,
): Promise<void> {
  const decoded = decodeRunId(rawId);
  if (decoded === null) {
    slot?.release();
    opts.sendError(runNotFound());
    return;
  }
  // An id outside the mint alphabet is a 404, not a 500: it is a typo in a URL, and the whole point
  // of the read-aloud alphabet is that people type these by hand.
  const resolved = resolveRunId(decoded);
  if (resolved === undefined) {
    slot?.release();
    opts.sendError(runNotFound());
    return;
  }
  // Bound as its own const rather than used through the narrowing above: the hoisted helpers further
  // down run after this function has returned to the event loop, where a narrowing does not reach.
  const id: string = resolved;
  // Existence only — `get` would project the run, reading the whole log, which is exactly what the
  // paged replay below exists to avoid doing in one burst. It runs INSIDE the connection cap: on the
  // studio host it is a broker round-trip, and a 404 that was reached without a slot let a caller
  // buy K of those concurrently for the price of K sockets.
  if (!(await store.exists(id))) {
    slot?.release();
    opts.sendError(runNotFound());
    return;
  }

  const resume = resolveSince(req.headers['last-event-id'], opts.url.searchParams.get('since'));
  if (!resume.ok) {
    slot?.release();
    opts.sendError(invalidInput(resume.detail));
    return;
  }
  // Runs inside the connection cap, for the same reason `exists` does: it is a store read reached
  // from an un-authenticated URL, and one a caller could otherwise buy K of for the price of K
  // sockets.
  const resumed = await clampResumePoint(store, id, resume.since);
  if (resumed.clamped) {
    log.warn('run tail asked to resume past the end of the run log; replaying from the start instead', {
      runId: id,
      asked: resume.since,
    });
  }

  // This route deliberately escapes the request-work discipline the tool routes run under: a
  // deadline would 504 a healthy stream, and a concurrency slot held for the life of a tail would
  // starve the pool. The SSE connection cap taken at the top of the route bounds it instead, and it
  // is already held by the time we get here. Auth already ran.
  res.setTimeout(0);
  req.socket?.setTimeout(0);

  let closed = false;
  let lastWrite = Date.now();
  let needsDrain = false;
  /** Set once the byte budget below has been spent on a socket that stopped taking bytes. */
  let stalled = false;
  /** Bytes handed to the socket since it last said it was full. Reset by a real 'drain'. */
  let stalledBytes = 0;
  /** Bytes handed to the socket since the last pace check — the shared bulk-write budget. */
  let sincePace = 0;
  /**
   * True while a durable read and its flush own this stream — the opening replay, a heal, or a
   * reconcile. It starts true because the opening replay is in flight from here on, and it is what
   * keeps the silence reconcile from issuing a second read across one that is already running.
   */
  let busy = true;
  /**
   * A heal that fired while another durable read held `busy`, waiting for its turn.
   *
   * Coalesced rather than queued: every hole reported while one read owns the stream is bounded by
   * the earliest `from` and the furthest `arrivedAt` among them, and one `pumpDurable` from that
   * earliest point covers the lot.
   */
  let pendingHeal: { from: number; arrivedAt: number } | null = null;
  const flushBytes = sseFlushBytes();
  const maxStalledBytes = sseMaxStalledBytes();
  const heartbeatMs = sseHeartbeatMs();
  const drainDeadlineMs = heartbeatMs * SSE_DRAIN_HEARTBEATS;

  // One repeating timer rather than a clear+set per event: a long replay would otherwise churn two
  // timer operations per envelope. The heartbeat only has to notice SILENCE, which a timestamp
  // answers in O(1).
  const heartbeat = setInterval(() => {
    if (closed) return;
    // A socket that has not accepted the last frame does not need a keepalive comment, and on a
    // stalled reader the heartbeat is the LAST writer left: a silent run stops emitting, the replay
    // has finished, and this timer would go on adding one frame per interval to a buffer nobody is
    // draining, forever. The comment exists to stop an intermediary reaping an IDLE stream; a socket
    // with unsent bytes on it is not idle.
    if (needsDrain) {
      log.debug('run tail skipped a heartbeat on a socket that has not drained', { runId: id, stalledBytes });
      return;
    }
    if (Date.now() - lastWrite < heartbeatMs) return;
    needsDrain = !res.write(': ping\n\n');
    lastWrite = Date.now();
    // Reaching here IS the silence: a full interval with nothing written. See `reconcile` — that is
    // the state a lost notify on the run's LAST event hides in, and the heartbeat is the only clock
    // this stream has. Not awaited; the timer must not become a place a store read can block.
    void reconcile();
  }, heartbeatMs);
  heartbeat.unref?.();

  const emitter = createOrderedEmitter(resumed.since, (event) => {
    if (closed || stalled) return;
    // Built once per envelope and shared by every tail on the run — see `serializeRunEvent`, which
    // also carries the wire-safety argument for this interpolation. The bytes come off the same
    // record rather than being re-measured here, so a frame costs one pass however many are open.
    const { frame, frameBytes: bytes } = serializeRunEvent(event);
    const accepted = res.write(frame);
    needsDrain = !accepted;
    sincePace += bytes;
    lastWrite = Date.now();
    // Only bytes written to a socket that ALREADY said it was full count against the stall budget,
    // so a healthy reader — whose writes return true, or whose 'drain' fires below — never spends
    // any of it however fast the run appends.
    if (accepted) {
      stalledBytes = 0;
      return;
    }
    stalledBytes += bytes;
    if (stalledBytes > maxStalledBytes) endStalled('live');
  }, {
    /**
     * A hole on the live stream is healed in place — see `heal`.
     *
     * Deferred a turn on purpose: the door fires inside `publishRunEvent`, which runs on the
     * WRITER's stack, and the heal's first act is a store read. Starting it here would put that read
     * in the middle of somebody's append. Nothing is racing it — the emitter went back to holding
     * before this was called, so the events arriving in the gap queue up behind the missing seqs.
     */
    onGap: (from, arrivedAt) => { setImmediate(() => { void heal(from, arrivedAt); }); },
  });

  // Step 1 — subscribe BEFORE reading the log, so nothing appended during the replay is missed.
  const unsubscribe = subscribeRunEvents(id, (event) => emitter.offer(event));

  const onDrain = (): void => {
    needsDrain = false;
    stalledBytes = 0;
  };
  res.on('drain', onDrain);

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    unsubscribe();
    clearInterval(heartbeat);
    res.off?.('drain', onDrain);
    slot?.release();
  };
  req.on('close', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);

  /**
   * A reader that stopped reading, past its budget. Hoisted because the emitter's write callback is
   * built above `cleanup` and calls this from inside it.
   *
   * Ending is the answer rather than waiting: law 1 makes the durable log the source of truth, so
   * the client resumes from `Last-Event-ID` and misses nothing — where waiting would mean holding
   * the rest of the run in this daemon's heap, per tail, for as long as the run emits.
   */
  function endStalled(where: string): void {
    if (stalled || closed) return;
    stalled = true;
    log.warn('run tail reader stopped reading past its budget; ending the stream so it resumes from Last-Event-ID', {
      runId: id,
      where,
      stalledBytes,
      budget: maxStalledBytes,
      drainDeadlineMs,
      lastEmitted: emitter.lastEmitted(),
    });
    cleanup();
    res.end();
  }

  /**
   * The shared gate every bulk write path checks — the replay pages and the `goLive` flush both.
   *
   * It is called per EVENT and costs a microtask; the drain wait only happens once the budget has
   * actually been handed over, which is what makes "a page" stop being the unit the socket is
   * measured in.
   */
  const pace = async (): Promise<boolean> => {
    if (closed || stalled) return false;
    if (sincePace < flushBytes) return true;
    sincePace = 0;
    if (needsDrain) {
      // An expiry is a reader that stopped reading without leaving, and it is answered exactly the
      // way the byte budget answers the reader that reads too slowly: end, so the slot comes back
      // and the client resumes from `Last-Event-ID`. Waiting it out is the one answer that cannot —
      // no further byte is handed over while this parks, so no other door on this route can fire.
      if (!(await waitForDrain(res, drainDeadlineMs))) {
        endStalled('drain');
        return false;
      }
      needsDrain = false;
      stalledBytes = 0;
    }
    return !closed && !stalled;
  };

  /** End the stream on our own terms. Every "the client must resume from here" door goes through it. */
  function endStream(why: string, fields: Record<string, unknown> = {}): void {
    if (closed) return;
    log.warn(why, { runId: id, lastEmitted: emitter.lastEmitted(), ...fields });
    cleanup();
    res.end();
  }

  /**
   * Read the durable log forward from `from` and put it on the wire, a page at a time.
   *
   * The initial replay and a heal are the same read against the same source of truth — one is at
   * stream open, the other is the moment a lost notify shows up as a hole — so they share this, and
   * with it the byte budget, the between-pages drain check and the yield that keeps a long log from
   * freezing the daemon. Returns false when the caller must stop: the connection is gone, the stream
   * has ended, or the read itself failed.
   *
   * It stops on an EMPTY page, never on a short one. `pageSize` is what this process ASKS for, not
   * what it gets: the broker clamps every read to its own per-frame ceiling (`MAX_EVENTS_PAGE`,
   * `studio-db-broker.ts`) regardless, so a short page is the ordinary shape of a capped read and
   * treating it as end-of-log silently truncates every replay whose requested page is larger — which
   * `WIGOLO_STUDIO_RUN_REPLAY_PAGE` lets any operator do, and which the heal path then turns into an
   * end/reconnect loop at `SSE_RETRY_MS`. The app-side projection already documents and enforces
   * exactly this contract (`run-view-model.ts`); this was the odd one out. The cost is one extra
   * empty read per replay, and correctness across a process boundary is worth an indexed seek.
   */
  async function pumpDurable(from: number, where: string): Promise<boolean> {
    const pageSize = replayPageSize();
    let cursor = from;
    try {
      for (;;) {
        if (closed || stalled) return false;
        const page = await store.eventsSince(id, cursor, pageSize);
        if (page.length === 0) return true;
        // Replay is the only unbounded producer on this stream — the live path is paced by the run
        // itself. A client that opens a tail and stops reading would otherwise pull the whole log
        // into the daemon's heap, so the gate is INSIDE the page: a page is 500 events at up to 64k
        // of payload each, and checking once per page is a count bounding a byte problem.
        for (const event of page) {
          emitter.emit(event);
          if (!(await pace())) return false;
        }
        const tail = page[page.length - 1].seq;
        // A store that ignored `since` would hand back the same page forever. Nothing legitimate
        // produces that; a spin on the event loop every other request shares is what it would cost
        // if anything did. It is also the exit the removed short-page check used to double as.
        if (tail <= cursor) return true;
        cursor = tail;
        // A page that never reached the byte budget still leaves the socket back-pressured, so the
        // between-pages check stays: it is the one that covers a log of small events.
        if (needsDrain) {
          if (!(await waitForDrain(res, drainDeadlineMs))) {
            endStalled('drain');
            return false;
          }
          needsDrain = false;
          stalledBytes = 0;
          sincePace = 0;
        }
        if (closed || stalled) return false;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } catch (err) {
      log.error('run event durable read failed', { runId: id, where, from, error: String(err) });
      if (!closed) {
        cleanup();
        res.end();
      }
      return false;
    }
  }

  /**
   * Release whatever arrived while the durable read was running, then run live.
   *
   * Unless the run out-appended the hold buffer, in which case the events it dropped are still in
   * the durable log and the honest move is to end the stream: the client reconnects with the last
   * seq it actually saw and replays the gap. Going live over a dropped buffer would skip those seqs
   * silently, which is the one thing this route promises never to do.
   */
  async function goLiveOrEnd(where: string): Promise<void> {
    if (emitter.overflowed()) {
      endStream('run tail dropped its hold buffer under an append storm; ending the stream so the client resumes', { where, when: 'before flush' });
      return;
    }
    // The flush takes the same gate as the replay. It is up to a full hold buffer — 2048 events /
    // 8 MB — handed over in one burst at the moment the socket is most likely already full, so an
    // ungated one is the largest single write on this route.
    await emitter.goLive(pace);
    if (closed || stalled) return;
    // Out-appended DURING the flush: same door, for the same reason.
    if (emitter.overflowed()) {
      endStream('run tail dropped its hold buffer under an append storm; ending the stream so the client resumes', { where, when: 'during flush' });
    }
  }

  /**
   * A hole on the live stream: `seq` jumped from `from` to `arrivedAt` because at least one notify
   * for a DURABLE event never arrived (see the gap door in `createOrderedEmitter`).
   *
   * Healing re-reads the log rather than ending the stream (**A-89-1**). Both close the hole — the
   * client could resume from `Last-Event-ID` — but the log is right here and the stream is healthy,
   * so ending it would spend a reconnect and `SSE_RETRY_MS` of blindness on an event this daemon can
   * read in one indexed seek, and would tell a client with no reconnect logic nothing at all. It is
   * also what the app-side projection already does with the same gap (`run-view-model.ts`), so the
   * two surfaces heal the same way. The cost is that a tail can now issue an unasked-for store read;
   * it is bounded by the rate of LOST notifies, which is the rate of writer crashes.
   *
   * Ending is still the fallback, for the one case the re-read cannot answer: if the log does not
   * carry the missing seqs, we do not have them and must not pretend otherwise.
   */
  async function heal(from: number, arrivedAt: number): Promise<void> {
    if (closed || stalled) return;
    // The hole is already on the wire. Only a heal that WAITED can be here — a fresh one is called
    // from the gap door, which fires precisely because `arrivedAt > lastEmitted + 1` — and its
    // `from`/`arrivedAt` are a snapshot of a state another durable read has since moved past.
    if (emitter.lastEmitted() >= arrivedAt - 1) return;
    /**
     * The same gate `reconcile` takes, and the reason it needs one is the deferral above it: the
     * gap door hands the heal to `setImmediate`, and a store read resolves in a MICROTASK, so a
     * heartbeat-driven reconcile parked on its probe can wake, pass both of its own `busy` checks
     * and be inside `pumpDurable` before the check phase this heal is queued in ever runs. Two
     * concurrent pumps then interleave `emit` and `pace` — one shared byte budget spent from two
     * places, and `healInner`'s end-of-stream decision read off a `lastEmitted` the other pump is
     * moving underneath it.
     *
     * Deferred, never dropped: the waiting read may end without filling THIS hole, so the heal is
     * re-dispatched by `releaseBusy` and re-checks the guard above when it gets its turn. That
     * re-dispatch is shadowed today and cannot change what goes out — `releaseBusy` writes down
     * which two properties of this file make that true, and what relaxing either would cost.
     */
    if (busy) {
      pendingHeal = pendingHeal === null
        ? { from, arrivedAt }
        : { from: Math.min(pendingHeal.from, from), arrivedAt: Math.max(pendingHeal.arrivedAt, arrivedAt) };
      return;
    }
    log.warn('run tail saw a seq gap on the live stream; re-reading the durable log to fill it', {
      runId: id,
      from,
      arrivedAt,
      missing: arrivedAt - from - 1,
    });
    busy = true;
    try {
      await healInner(from, arrivedAt);
    } finally {
      releaseBusy();
    }
  }

  /**
   * Hand the durable-read gate back, and straight to a heal that arrived while it was held.
   *
   * Every path that clears `busy` goes through here, so a hole reported during a read cannot be
   * left in the buffer with nobody coming for it. Re-dispatched through `setImmediate` for the
   * reason the gap door defers in the first place — this runs in a `finally`, and a heal's first
   * act is a store read.
   *
   * "Nobody coming for it" is TODAY untrue, and not because of anything here: measured 2026-08-24,
   * this re-dispatch is shadowed and cannot change what reaches the wire. Two properties that live
   * elsewhere in this file are what make it so. Let `S = pendingHeal.arrivedAt`. Every `busy`
   * window ends in a flush, and when that flush reaches the held event at `S`, exactly one of four
   * things happens:
   *
   *   1. the flush door in `createOrderedEmitter` trips — at `S`, or at an earlier held entry,
   *      since the door is unconditional over the whole hold buffer — and fires a FRESH `onGap` for
   *      that same hole. Its `setImmediate` is queued strictly BEFORE ours: everything between the
   *      door and the `finally` that calls us is microtasks. So the fresh heal takes the gate
   *      first and issues exactly the durable read the queued one would have;
   *   2. `emit` writes it, so `last === S`;
   *   3. `emit` drops it as already covered, so `last >= S`;
   *   4. the event is gone from the buffer — which requires `overflow`, and `goLiveOrEnd` turns
   *      `overflow` into `endStream` unconditionally, so there is no live stream left to heal.
   *
   * 2 and 3 satisfy the guard at the top of `heal` (`lastEmitted() >= arrivedAt - 1`), which
   * no-ops the re-dispatch. The `delivered === false` let-through in the flush door is an `emit`,
   * so it lands in 2. Neuter this whole body to `busy = false` and `tests/unit/daemon/` is
   * 479/479 green, both #113 arms and both #121 arms included; an instrumented sweep over 1080
   * forced windows plus a 10-tail churn recorded `deferrals=1239 coalesced=0 pendingDidWork=0`.
   * The `busy` early-return in `heal` is the opposite case — load-bearing, pinned, three arms red
   * without it — so do not read this note as being about that gate.
   *
   * Kept anyway, because the unreachability is borrowed rather than local. Make the flush door
   * conditional, or let an overflow go live instead of ending the stream, and this queue is the
   * ONLY thing carrying that hole to a healer — and no arm would go red to tell you, because no
   * arm can reach it today. Relax either and pin this branch in the same commit.
   */
  function releaseBusy(): void {
    busy = false;
    const queued = pendingHeal;
    if (queued === null) return;
    pendingHeal = null;
    if (closed || stalled) return;
    setImmediate(() => { void heal(queued.from, queued.arrivedAt); });
  }

  async function healInner(from: number, arrivedAt: number): Promise<void> {
    // Back to holding before the read. The gap door already did this for a heal that ran straight
    // away, but one that waited for the gate can be dispatched onto a LIVE emitter — the read it is
    // about to run must not race the bus onto the wire. A no-op on an emitter that is already
    // holding, which is why the immediate path can share it.
    emitter.suspend();
    if (!(await pumpDurable(from, 'heal'))) return;
    if (closed || stalled) return;
    // The read did not reach the seq that exposed the hole, so the log cannot fill it — a notify
    // that overtook its own commit, or a log this daemon no longer has. Ending sends the client
    // back through the reconnect door instead of writing the hole we just refused to write.
    if (emitter.lastEmitted() < arrivedAt - 1) {
      endStream('run tail could not fill a seq gap from the durable log; ending the stream so the client resumes', {
        from,
        arrivedAt,
      });
      return;
    }
    await goLiveOrEnd('heal');
  }

  /**
   * The silence door: the half of a lost notify that no later event can expose.
   *
   * `emit`'s gap door and the flush's both work the same way — a seq arrives, and its distance from
   * the last one delivered says a notify was lost. That only ever fires because something ARRIVED.
   * A run whose LAST event loses its notify — the `run.completed` case — is never followed by
   * another live event, so nothing on this stream ever asks the question. The connection stays open,
   * the heartbeat keeps it alive, and every consumer goes on believing a finished run is running.
   * Law 1 makes the durable log the source of truth, and the log has the answer the whole time.
   *
   * So the check is driven by silence rather than by arrival. The heartbeat already fires only when
   * nothing has been written for a full interval, which is exactly the state the hole hides in, so
   * it asks the store for ONE event past `emitter.lastEmitted()`. Nothing there — the ordinary case,
   * an idle run with a watcher on it — and this returns without writing a frame or touching the
   * emitter. Something there means a notify was lost, and the same durable read that heals an
   * arrival-exposed hole heals this one, on the same connection.
   *
   * COST. One `eventsSince(..., limit 1)` per SILENT tail per heartbeat interval — a tail that is
   * receiving events never reaches here, because the heartbeat returns early on a stream that wrote
   * inside the interval. On the studio host `store` is the broker, so that read is one round-trip
   * over the child-process channel rather than an in-process indexed seek. The fleet is bounded by
   * the SSE connection cap: at the default 32 connections and a 15s interval that is at most 32
   * single-row reads per 15s, and only for connections that are idle anyway.
   *
   * It must not run across a replay, a heal, or another reconcile — `busy` is that gate, checked
   * again after the read because a gap door can fire while it is in flight.
   */
  async function reconcile(): Promise<void> {
    if (closed || stalled || busy) return;
    const from = emitter.lastEmitted();
    let ahead: RunEvent[];
    try {
      ahead = await store.eventsSince(id, from, 1);
    } catch (err) {
      // A probe that could not run is not evidence of a hole. Ending the stream on a transient store
      // error would spend a reconnect on every idle tail the moment the store hiccups.
      log.warn('run tail could not probe the durable log while idle; leaving the stream as it is', {
        runId: id,
        from,
        error: String(err),
      });
      return;
    }
    if (ahead.length === 0) return;
    if (closed || stalled || busy) return;
    log.warn('run tail found durable events past its last delivered seq while silent; a notify was lost', {
      runId: id,
      from,
      found: ahead[0].seq,
    });
    busy = true;
    try {
      // Back to holding BEFORE the read, for the same reason the gap door does it: anything the bus
      // offers from here must queue behind the seqs we are about to put on the wire, not race them.
      emitter.suspend();
      if (!(await pumpDurable(from, 'reconcile'))) return;
      if (closed || stalled) return;
      await goLiveOrEnd('reconcile');
    } finally {
      releaseBusy();
    }
  }

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
  // An SSE comment, so it reaches a raw reader and an operator's transcript without inventing an
  // event type every client would have to learn. A client that de-duplicates on `seq` needs to know
  // that the ids about to arrive are LOWER than the cursor it sent, because its cursor was for a log
  // this run does not have. `resume.since` is a validated integer, so it cannot forge a field line.
  if (resumed.clamped) res.write(`: resume point ${resume.since} is past the end of this run's log; replaying from the start\n\n`);
  lastWrite = Date.now();

  // Step 2 — the durable replay, a page at a time. Nothing is dropped here: the backing log is the
  // DB, not a ring. The yield between pages is what keeps a long log from freezing the daemon, and
  // is also what makes the emitter's overlap window real.
  if (!(await pumpDurable(resumed.since, 'replay'))) return;

  // Step 3 — release whatever arrived mid-replay through the same door, then run live.
  await goLiveOrEnd('replay');
  // The opening read is done, so the silence reconcile may now take its turn. Cleared only on this
  // path: every early return above leaves a stream that is closing, and a reconcile on one of those
  // has nothing to do that its own `closed` check does not already refuse. Its re-dispatch half is
  // dead by construction here, not merely shadowed: `pendingHeal` is written only by `heal`, and
  // every route into `heal` is `onGap`, which defers through `setImmediate`. So even a gap the
  // flush on the line above just reported has not run a `heal` body yet, and `pendingHeal` is
  // still null when we get here.
  releaseBusy();
}
