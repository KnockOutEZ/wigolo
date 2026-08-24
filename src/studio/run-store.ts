/**
 * The durable run store (SD1 spine 1).
 *
 * A run is the unit of everything: task + append-only event log + tab group + pending decisions +
 * cost counters + driver state. The EVENT LOG IS THE SINGLE SOURCE OF TRUTH — every other field on
 * `Run` is a projection of it, and the `status`/`last_seq`/`updated_at` columns on `studio_runs`
 * are a cache that `projectRun` can rebuild from the log plus the clock — a pending decision expires
 * on a deadline nothing writes down (pin 3), which is the only input a replay needs beyond the log.
 *
 * These are pure functions over a `Database` handle so the same code binds in-process (the daemon)
 * and behind the broker handlers (the desktop app topology) without a second implementation.
 *
 * Shapes are pinned by the SD1 run-spine mini-spec; the sections cited below are its.
 */
import type Database from 'better-sqlite3';
import { randomInt } from 'node:crypto';
import { appendFileSync, closeSync, mkdirSync, openSync, readSync, statSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { createLogger } from '../logger.js';
import { studioStateDir } from './paths.js';

const log = createLogger('studio');

export type RunStatus = 'running' | 'needs_you' | 'paused' | 'done' | 'failed' | 'cancelled';
export type ActorKind = 'agent' | 'human' | 'daemon' | 'system';
/** Law 3's driver vocabulary, verbatim. */
export type DriverKind = 'cli' | 'sdk' | 'api' | 'studio' | 'human';

export interface ClientInfo { name: string; version: string }
export interface Driver { kind: DriverKind; client?: ClientInfo }
export interface Actor { kind: ActorKind; driver?: DriverKind; client?: ClientInfo }

/** One event, one shape, every surface (§3.1). `seq` and `ts` are the store's to assign. */
export interface RunEvent {
  seq: number;
  ts: string;
  actor: Actor;
  type: string;
  payload: Record<string, unknown>;
}

/**
 * The slice of an envelope a projection actually reads. A type-filtered read skips `actor` — no
 * projection rule looks at it, and JSON-parsing it per row is a large part of what F1 was paying.
 */
export type ProjectableEvent = Pick<RunEvent, 'seq' | 'ts' | 'type' | 'payload'>;

/** What a caller supplies. There is deliberately no `seq` and no `ts`. */
export interface RunEventInput {
  actor: Actor;
  type: string;
  payload?: Record<string, unknown>;
}

export interface PendingDecision {
  decisionId: string;
  kind: string;
  prompt: string;
  anchor?: { tabId: string; mark?: number };
  requestedAt: string;
  /** Pin 3's deadline. Past it the decision is not projected at all — see `hasAutoDenied`. */
  autoDenyAt: string;
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

/** The three facts fixed at creation, plus the id. Everything else is replayed. */
export interface StoredRunFacts {
  id: string;
  task: string;
  spaceId: string;
  createdAt: string;
}

export interface CreateRunInput {
  task: string;
  spaceId?: string;
  driver?: Driver;
  /** Links the daemon studio session that spawned this run, when one did (§7.3). */
  sessionId?: string;
}

export interface RunStoreOptions {
  now?: () => Date;
  /** Root of the shared data dir; defaults to the configured one. */
  dataDir?: string;
  /** Injectable id source — the collision rule is what tests need to drive, not the randomness. */
  mintId?: (length: number) => string;
  /** Called after the append commits, for the live tail. Never inside the transaction. */
  onEvent?: (runId: string, event: RunEvent) => void;
}

/**
 * A projection is a pure function of the log AND the clock — `autoDenyAt` is the one field that
 * moves without an event. Injectable so a test can drive the two-minute deadline.
 */
export interface ReadRunOptions {
  now?: () => Date;
}

/**
 * What a projection can be handed instead of reading it — one field per type in
 * `AGGREGATED_EVENT_TYPES`, each already folded by SQLite. Supplying a seed and ALSO passing that
 * type's rows would double count, which is why the store's filtered read and these seeds are
 * mutually exclusive by construction. A caller with a full log (a replay, the app's view model)
 * simply omits them and gets the identical answer from the `case` arms.
 */
export interface ProjectRunOptions {
  cost?: RunCost;
  /** The newest `presentation.*` row's verdict — `hidden` when the run has never been promoted. */
  visibility?: 'hidden' | 'visible';
  /** The unanswered, unexpired cards — `PENDING_DECISION_SQL`, replayed newest-wins. */
  pendingDecisions?: readonly PendingDecision[];
  /** §1's answer from the seek path, which `readStatusHead` and `foldStatus` are pinned to share. */
  status?: RunStatus;
}

export interface ListRunsOptions extends ReadRunOptions {
  status?: RunStatus[];
  spaceId?: string;
  limit?: number;
  cursor?: string;
}

export interface ListRunsResult {
  runs: Run[];
  nextCursor?: string;
}

/**
 * Crockford-style: no `0 1 i l o u`, so an id survives being read aloud, typed out of a result
 * footer, and pasted into a watch link.
 */
export const RUN_ID_ALPHABET = '23456789abcdefghjkmnpqrstvwxyz';
export const RUN_ID_MIN_LENGTH = 4;
export const MAX_TASK_CHARS = 4000;
/**
 * The bound on one event's serialized payload. Generous — a decision prompt, a page title and a
 * handful of URLs fit many times over — but finite, because the log is append-only and written to
 * two places, so "no bound" means "a disk-fill primitive".
 */
export const MAX_EVENT_PAYLOAD_CHARS = 64_000;
export const DEFAULT_SPACE_ID = 'default';
/** Pin 3 — a pending decision auto-denies after two minutes. */
export const AUTO_DENY_MS = 120_000;
export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 200;

/** §2 — three mints at one length, then grow. Bounded so a saturated space fails loudly, never hangs. */
const MINT_ATTEMPTS_PER_LENGTH = 3;
const MAX_ID_LENGTH = RUN_ID_MIN_LENGTH + 4;

/**
 * The three ways a run ends, and the status each one means. Newest wins, and it outranks a pause and
 * a pending decision both — `statusFrom` owns that precedence for the replay fold and the seek fold
 * alike, so there is still exactly one copy of §1's rules.
 */
const TERMINAL_STATUS_BY_TYPE: Readonly<Record<string, RunStatus>> = {
  'run.completed': 'done',
  'run.failed': 'failed',
  'run.cancelled': 'cancelled',
};
const TERMINAL_EVENT_TYPES: readonly string[] = Object.keys(TERMINAL_STATUS_BY_TYPE);
/** The pause pair — newest wins, and `run.resumed` clears rather than sets. */
const PAUSE_EVENT_TYPES: readonly string[] = ['run.paused', 'run.resumed'];
/** The pair with no natural bound: a run can raise and answer decisions all day (A-43-6). */
const DECISION_EVENT_TYPES: readonly string[] = ['decision.requested', 'decision.resolved'];
/** The other pair with no natural bound: a run can take and give back tabs for as long as it lives. */
const TAB_EVENT_TYPES: readonly string[] = ['tab.attached', 'tab.detached'];
/** Single-valued, and writer-driven: promote/demote can be flipped all day (law 2). Newest wins. */
const PRESENTATION_EVENT_TYPES: readonly string[] = ['presentation.promoted', 'presentation.demoted'];

/**
 * The only types `foldStatus` can be moved by. The append path recomputes the `studio_runs.status`
 * cache column WITHOUT reading this class: two of the seven are writer-controlled pairs that
 * accumulate for the life of a run, so a type-filtered read of them was still O(events-so-far) of
 * held write-lock time on the shared database every single append. `readStatusHead` asks SQLite for
 * the newest row of each single-valued type and for whether one unanswered decision survives.
 *
 * Adding a status rule to `foldStatus` means adding its type here — and to the seek path, which the
 * old-vs-new fold-equality test is what catches.
 */
export const STATUS_EVENT_TYPES: readonly string[] = [
  ...TERMINAL_EVENT_TYPES,
  ...PAUSE_EVENT_TYPES,
  ...DECISION_EVENT_TYPES,
];

/**
 * Every type `projectRun`'s switch reads AS A ROW. A type filter bounds a read to a SET OF TYPES,
 * never to a number of ROWS, so what earns a place here is a type whose ROWS are bounded — or one
 * whose SQL answer measured worse than reading them.
 *
 * `run.created` happens once per run by construction. The tab pair does not: a run can take and
 * give tabs back for as long as it lives. It is read anyway, because the anti-join that would answer
 * it — the shape `PENDING_DECISION_SQL` uses — has no `ts` bound available to it (a tab attached at
 * the start of a run can still be held at the end), and without one it degrades to a walk of the
 * detach slice PER attach row. Measured at 10 runs × 2000 tab events: 7.8 ms when each detach
 * immediately follows its attach, 1052 ms when a run attaches a batch and gives it back later,
 * against a flat 18–21 ms for reading the rows. Both classes are folded in JS by
 * `AGGREGATED_EVENT_TYPES`' standard, and only one of them is cheaper for it. See `known-issues.md`:
 * making the tab fold bounded needs a maintained column, which is an append-path change.
 *
 * `lastSeq` / `updatedAt` — which DO move with any type — come from a separate bounded tail read.
 *
 * Adding a `case` to `projectRun` means adding its type here OR to `AGGREGATED_EVENT_TYPES`. A
 * source guard in the run-store tests enforces that, because a case added to neither would silently
 * drop from every projected row.
 */
export const PROJECTION_EVENT_TYPES: readonly string[] = ['run.created', ...TAB_EVENT_TYPES];

/**
 * The types a projection folds in SQL instead of reading row by row, and the reason the filter above
 * is a real bound rather than a shape.
 *
 * None of these has a natural bound. `cost.recorded` is a COUNTER: one per browser action by
 * design, so its cardinality tracks how much work a run did. The decision pair and the pause pair
 * are writer-driven — the store polices envelope mechanics only (A-43-6), so nothing caps how many a
 * run accumulates — and `presentation.*` flips as often as anyone promotes and demotes the run
 * (law 2). Reading any of them per row put the whole log back inside the type filter. Measured on
 * the tip at 50 runs × 5001 events, as blocked daemon event loop per `GET /v1/runs`: 3004 ms of
 * decision pairs, 458 ms of pause pairs, 382 ms of `presentation.*` — against 0.4 ms for a class the
 * filter excludes. In the decision case the projected set came out EMPTY: a quarter of a million
 * rows parsed to produce nothing.
 *
 * None of these answers needs the history that produced it:
 *   - the counters are columns on `studio_runs`, moved in the same transaction as the event;
 *   - the pause pair, the terminals and `presentation.*` are single-valued, so the NEWEST row of
 *     each is the whole answer — five plus two seeks in one statement, O(log depth) each;
 *   - a pending decision is the anti-join in `PENDING_DECISION_SQL`, bounded twice over.
 *
 * `projectRun` keeps a `case` for each of them, for the callers that hand it a full log (a replay,
 * the app's view model) — with the seed and the case mutually exclusive, because a type in this list
 * is never in the filtered read.
 */
export const AGGREGATED_EVENT_TYPES: readonly string[] = [
  'cost.recorded',
  ...PRESENTATION_EVENT_TYPES,
  ...STATUS_EVENT_TYPES,
];

const EVENT_TYPE_GRAMMAR = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const ACTOR_KINDS = new Set<string>(['agent', 'human', 'daemon', 'system']);
const DRIVER_KINDS = new Set<string>(['cli', 'sdk', 'api', 'studio', 'human']);

export function mintRunId(length: number = RUN_ID_MIN_LENGTH): string {
  let out = '';
  for (let i = 0; i < length; i++) out += RUN_ID_ALPHABET[randomInt(RUN_ID_ALPHABET.length)];
  return out;
}

const RUN_ID_CHARS = new Set(RUN_ID_ALPHABET);

/**
 * Could this string have been minted? Nothing else is a run id.
 *
 * The guard is structural rather than a live exploit fix: a run id is `join()`ed into a filesystem
 * path by `runDir`, so `..` or a separator in one would escape the state directory. Every current
 * `projectToDisk` caller passes a minted id or an id that already matched a row, so traversal is
 * not reachable today — which is exactly the kind of precondition a later caller deletes without
 * noticing. Checking the alphabet costs nothing and does not depend on who calls.
 */
export function isValidRunId(id: string): boolean {
  if (id.length < RUN_ID_MIN_LENGTH || id.length > MAX_ID_LENGTH) return false;
  for (const ch of id) if (!RUN_ID_CHARS.has(ch)) return false;
  return true;
}

/**
 * Ids are case-normalized on input everywhere — a footer read back in caps still resolves — and
 * refused outright when they are not ids at all.
 *
 * Throwing is right on the WRITE and filesystem paths, where an unmintable id means a caller bug.
 * Lookups use `resolveRunId` instead: an id that could never have been minted is a MISS, so a typo
 * in a URL stays a 404 rather than becoming a 500.
 */
export function normalizeRunId(id: string): string {
  const normalized = String(id).trim().toLowerCase();
  // Quoted and clipped, not interpolated raw: the string that reaches here is by definition NOT an
  // id, so it is arbitrary caller input on its way into a log line.
  if (!isValidRunId(normalized)) throw new Error(`invalid run id: ${JSON.stringify(normalized.slice(0, 32))}`);
  return normalized;
}

/** The lookup-side normalizer. `undefined` means "no such run", never an error. */
export function resolveRunId(id: string): string | undefined {
  const normalized = String(id).trim().toLowerCase();
  return isValidRunId(normalized) ? normalized : undefined;
}

/** Where a run's human-readable projection lives (law 11 — local and inspectable). */
export function runDir(id: string, dataDir?: string): string {
  return studioStateDir(dataDir, 'runs', normalizeRunId(id));
}

export function runEventsFile(id: string, dataDir?: string): string {
  return studioStateDir(dataDir, 'runs', normalizeRunId(id), 'events.jsonl');
}

interface RunRow {
  id: string;
  task: string;
  space_id: string;
  created_at: string;
  cost_browser_actions: number;
  cost_tokens_in: number;
  cost_tokens_out: number;
  cost_spend_usd: number;
}
/** Every column a projected row needs, named once so an item read and a list page cannot drift. */
const RUN_ROW_COLUMNS =
  'id, task, space_id, created_at, cost_browser_actions, cost_tokens_in, cost_tokens_out, cost_spend_usd';

/**
 * Which counter column a `cost.recorded` payload moves, if any. An unrecognised kind lands in no
 * bucket, exactly as `projectRun`'s fold refuses it — the column names are from this table and never
 * from a payload, which is what keeps the interpolation in the append's UPDATE a constant.
 */
const COST_COLUMN_BY_KIND: Readonly<Record<string, string>> = {
  browser_action: 'cost_browser_actions',
  tokens_in: 'cost_tokens_in',
  tokens_out: 'cost_tokens_out',
  spend_usd: 'cost_spend_usd',
};

function costDeltaOf(type: string, payload: Record<string, unknown>): { column: string; amount: number } | undefined {
  if (type !== 'cost.recorded') return undefined;
  const column = typeof payload.kind === 'string' ? COST_COLUMN_BY_KIND[payload.kind] : undefined;
  if (column === undefined) return undefined;
  // `num` and not SQLite's coercion: a string `"3"` and a boolean `true` are not amounts, and the
  // fold this caches reads both as zero.
  const amount = num(payload.amount);
  return amount === 0 ? undefined : { column, amount };
}

function costOf(row: RunRow): RunCost {
  return {
    browserActions: num(row.cost_browser_actions),
    tokensIn: num(row.cost_tokens_in),
    tokensOut: num(row.cost_tokens_out),
    spendUsd: num(row.cost_spend_usd),
  };
}

interface EventRow { seq: number; ts: string; actor: string; type: string; payload: string }
interface StatusRow { seq: number; ts: string; type: string; payload: string }
interface PendingRow { seq: number; ts: string; payload: string }
interface ProjectionRow { run_id: string; seq: number; ts: string; type: string; payload: string }
interface TailRow { seq: number; ts: string }

function placeholders(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ');
}

function assertTask(task: unknown): string {
  if (typeof task !== 'string' || task.trim().length === 0) throw new Error('task is required');
  if (task.length > MAX_TASK_CHARS) throw new Error(`task exceeds ${MAX_TASK_CHARS} characters`);
  return task;
}

/**
 * A client badge is two strings and nothing else. Rebuilt rather than passed through because it is
 * written into an append-only log and served back over REST: whatever else the caller hung on the
 * object would be durable, and would be durable in a field a reader takes for a known shape.
 */
function clientOf(value: unknown): ClientInfo | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const c = value as { name?: unknown; version?: unknown };
  const name = str(c.name);
  const version = str(c.version);
  return name && version ? { name, version } : undefined;
}

function assertDriver(driver: Driver | undefined): Driver {
  if (driver === undefined) return { kind: 'api' };
  if (!DRIVER_KINDS.has(driver.kind)) throw new Error(`unknown driver: ${String(driver.kind)}`);
  const client = clientOf(driver.client);
  return client ? { kind: driver.kind, client } : { kind: driver.kind };
}

/**
 * Validated AND rebuilt, the way `assertDriver` is. Returning the caller's object let unknown keys
 * ride into `actor` on every event — permanently, since the log is append-only, and visibly, since
 * the envelope is what the SSE tail and the on-disk projection serialize.
 */
function assertActor(actor: Actor): Actor {
  if (!actor || !ACTOR_KINDS.has(actor.kind)) throw new Error(`unknown actor: ${String(actor?.kind)}`);
  if (actor.driver !== undefined && !DRIVER_KINDS.has(actor.driver)) throw new Error(`unknown actor driver: ${String(actor.driver)}`);
  const client = clientOf(actor.client);
  return {
    kind: actor.kind,
    ...(actor.driver !== undefined ? { driver: actor.driver } : {}),
    ...(client ? { client } : {}),
  };
}

/**
 * Law 8's address, checked before it is served. `anchor` was the one projected field cast wholesale
 * out of a payload: every neighbouring field goes through `str()`, so a decision card could carry an
 * arbitrary object — or an array, or a string — into a REST response typed `{ tabId; mark? }`.
 *
 * A junk `mark` costs the mark, not the anchor: the card still points at a tab, which is the part a
 * human needs to answer it.
 */
function anchorOf(value: unknown): PendingDecision['anchor'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const a = value as { tabId?: unknown; mark?: unknown };
  const tabId = str(a.tabId);
  if (!tabId) return undefined;
  const mark = typeof a.mark === 'number' && Number.isInteger(a.mark) && a.mark >= 0 ? a.mark : undefined;
  return mark === undefined ? { tabId } : { tabId, mark };
}

/**
 * The store polices envelope MECHANICS only — never whether an event is legal at this point in a
 * run's life (A-43-6). That is why an unknown future type appends without a store change.
 */
function assertType(type: string): string {
  if (typeof type !== 'string' || !EVENT_TYPE_GRAMMAR.test(type)) throw new Error(`invalid event type: ${String(type)}`);
  return type;
}

function serializePayload(payload: Record<string, unknown> | undefined): string {
  if (payload === undefined) return '{}';
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('payload must be a JSON object');
  let serialized: string;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    throw new Error('payload must be JSON-serializable');
  }
  // Every event is persisted TWICE — the row and the on-disk projection — and the log is
  // append-only, so an unbounded payload is a disk-fill primitive with no compacting path out of
  // it. REST already caps `task`, `spaceId` and the client fields on exactly this reasoning; the
  // append path is the same surface reached by a different door.
  if (serialized.length > MAX_EVENT_PAYLOAD_CHARS) {
    throw new Error(`payload exceeds ${MAX_EVENT_PAYLOAD_CHARS} characters`);
  }
  return serialized;
}

function rowToEvent(r: EventRow): RunEvent {
  return {
    seq: r.seq,
    ts: r.ts,
    actor: JSON.parse(r.actor) as Actor,
    type: r.type,
    payload: JSON.parse(r.payload) as Record<string, unknown>,
  };
}

/**
 * The disk projection (A-43-3). Written after the commit, NEVER read back — the DB is the source of
 * truth, so a failed write costs a `cat`-able copy and never an event.
 *
 * Owner-only, not merely owner-only-by-parent: the file carries decision prompts, task text and
 * attached URLs that can hold a query-string token, and it outlives the 0700 directory the moment
 * the tree is copied, archived or synced. The mode applies on create and is ignored on append.
 */
function projectToDisk(runId: string, event: RunEvent, dataDir?: string): void {
  const line = JSON.stringify(event) + '\n';
  // Inside the try with everything else: `runDir` throws on an id that could not have been minted,
  // and a disk projection is never allowed to unwind an event that has already committed.
  try {
    const file = runEventsFile(runId, dataDir);
    let projection = runProjections.get(file);
    if (projection === undefined) {
      projection = { dir: runDir(runId, dataDir), file, pending: [], inFlight: undefined, draining: undefined };
      runProjections.set(file, projection);
      armProjectionExitDrain();
    }
    projection.pending.push(line);
    if (projection.draining === undefined) projection.draining = drainProjection(projection);
  } catch (err) {
    log.warn('run event disk projection failed', { runId, seq: event.seq, error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * One run's un-landed tail. The append path only ever pushes a string onto `pending`; every syscall
 * happens in `drainProjection`, off the caller's stack.
 *
 * `inFlight` is the batch currently handed to the kernel, held separately from `pending` because the
 * exit drain has to distinguish "queued and definitely not written" from "may or may not have landed".
 */
interface RunProjection {
  dir: string;
  file: string;
  pending: string[];
  inFlight: string | undefined;
  draining: Promise<void> | undefined;
}

/**
 * Keyed by the events file, so a `dataDir` swap (tests, a second store) never shares a queue with the
 * default tree. Entries are created on the first un-landed line and DELETED once the queue empties,
 * which is what bounds the map: it holds one entry per run with writes still in the air, not one per
 * run this process has ever touched.
 */
const runProjections = new Map<string, RunProjection>();

/**
 * The append was three synchronous syscalls per event — open, write, close — on whichever loop the
 * append is on: the daemon's REST loop, or the broker child's, where it serialises every other DB
 * call the app makes. Measured over 5,000 appends of a 246-char payload, `appendFileSync` alone was
 * 34.1 µs of an 80.6 µs append, ~4× the held-lock DB work it sits behind, and `cost.recorded` is one
 * event per browser action by design.
 *
 * The file is a projection that is never read back, so line ORDER is its only correctness
 * constraint. A single-flight drain per run gives exactly that — one batch in the kernel at a time,
 * appended in the order the lines were pushed — and coalesces a burst of events raised in one tick
 * into ONE open/write/close instead of one each.
 */
async function drainProjection(projection: RunProjection): Promise<void> {
  try {
    while (projection.pending.length > 0) {
      projection.inFlight = projection.pending.join('');
      projection.pending = [];
      try {
        await appendProjectionBatch(projection);
      } catch (err) {
        // Same contract as before: the DB is the source of truth, so a failed write costs a
        // `cat`-able copy and never an event. The memo is retired so the next batch re-creates the
        // directory rather than believing a tree that has moved.
        ensuredRunDirs.delete(projection.dir);
        log.warn('run event disk projection failed', { file: projection.file, error: err instanceof Error ? err.message : String(err) });
      }
      projection.inFlight = undefined;
    }
  } finally {
    projection.draining = undefined;
    // Nothing can have been pushed since the loop's last check — the two are separated by no await.
    runProjections.delete(projection.file);
  }
}

async function appendProjectionBatch(projection: RunProjection): Promise<void> {
  const batch = projection.inFlight!;
  try {
    ensureRunDir(projection.dir);
    await appendFile(projection.file, batch, { mode: 0o600 });
  } catch {
    // The memo is an optimisation, never a claim: the tree can be moved, cleaned or unmounted
    // between two batches. Any write failure retires it and re-creates the directory once, so the
    // observable behaviour is the unmemoised one — a deleted run directory is back on the NEXT
    // batch, not the one after it.
    ensuredRunDirs.delete(projection.dir);
    ensureRunDir(projection.dir);
    await appendFile(projection.file, batch, { mode: 0o600 });
  }
}

/**
 * Await every line raised so far reaching disk. Callers that read `events.jsonl` back — tests, and a
 * shutdown that wants the tail before the process goes — need this, because the append itself no
 * longer touches the filesystem at all.
 */
export async function flushRunEventProjections(): Promise<void> {
  // Bounded: a caller appending faster than the disk drains would otherwise spin here forever, and a
  // flush that gives up is a far better failure than a hung shutdown.
  for (let round = 0; round < 1000 && runProjections.size > 0; round++) {
    await Promise.all([...runProjections.values()].map((p) => p.draining));
  }
}

let projectionExitDrainArmed = false;

function armProjectionExitDrain(): void {
  if (projectionExitDrainArmed) return;
  projectionExitDrainArmed = true;
  // The broker child hard-exits on SIGTERM and on the parent closing its stdin pipe (no-orphan,
  // spec §11), so the graceful-quit tail — the `run.cancelled` every run gets on the way out — would
  // die in the queue without this. `exit` is the one hook that fires on `process.exit()` as well as
  // on a drained loop, and it is the one place a synchronous write is the right tool.
  //
  // `on`, not `once`: anything else in the process emitting `exit` would otherwise consume the
  // listener and silently disarm the real one. The drain clears its queue, so firing twice is a no-op.
  process.on('exit', drainRunProjectionsOnExit);
}

function drainRunProjectionsOnExit(): void {
  for (const projection of runProjections.values()) {
    const parts: string[] = [];
    // `pending` was never handed to the kernel, so it definitely has not landed. `inFlight` may have
    // been written by a call whose completion callback the exit beat; asking the file settles it, and
    // a duplicated event line is worse than the cost of one read at exit.
    if (projection.inFlight !== undefined && !endsWithBatch(projection.file, projection.inFlight)) parts.push(projection.inFlight);
    parts.push(...projection.pending);
    if (parts.length === 0) continue;
    try {
      ensuredRunDirs.delete(projection.dir);
      ensureRunDir(projection.dir);
      appendFileSync(projection.file, parts.join(''), { mode: 0o600 });
    } catch {
      // Exiting: there is no next append to retry on and no listener left to tell.
    }
  }
  runProjections.clear();
}

/** Did this batch already land? Event lines carry a unique `seq`, so a tail match is an identity. */
function endsWithBatch(file: string, batch: string): boolean {
  const expected = Buffer.from(batch);
  let fd: number | undefined;
  try {
    const size = statSync(file).size;
    if (size < expected.length) return false;
    fd = openSync(file, 'r');
    const got = Buffer.allocUnsafe(expected.length);
    readSync(fd, got, 0, expected.length, size - expected.length);
    return got.equals(expected);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * One `mkdirSync` per run directory per process instead of one per append. `recursive: true` makes
 * the repeat call a no-op semantically, but not for free — it is a synchronous stat-and-mkdir walk
 * of every path segment on the hot append path, paid on an event whose directory this process
 * created microseconds ago.
 */
const ensuredRunDirs = new Set<string>();
/** A process that touches this many runs has nothing to gain from remembering the earlier ones. */
const MAX_ENSURED_RUN_DIRS = 1024;

function ensureRunDir(dir: string): void {
  if (ensuredRunDirs.has(dir)) return;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (ensuredRunDirs.size >= MAX_ENSURED_RUN_DIRS) ensuredRunDirs.clear();
  ensuredRunDirs.add(dir);
}

/**
 * Prepared statements, per `Database` handle.
 *
 * better-sqlite3 does not cache them: `db.prepare(sql)` runs the SQL compiler every time, and on the
 * append path that compilation happens INSIDE `BEGIN IMMEDIATE` — the write lock on a database that
 * search caching, embeddings and artifacts queue behind too. Measured over 20k appends, compiling
 * per call costs 59.6 µs/append against 7.9 µs when the statements are reused: ~87% of the held-lock
 * time was the compiler, on a path `cost.recorded` walks once per browser action by design, so a
 * long run pays it continuously.
 *
 * Keyed by handle, because a `Statement` belongs to the connection that compiled it — the broker
 * child, the daemon and every test database must never be handed each other's. A `WeakMap` so a
 * closed connection's statements go away with it; a value that references its own key does not pin
 * it here (ephemeron semantics), which is what makes that safe.
 *
 * Only CONSTANT sql goes through this. The two reads whose text varies with their arguments — the
 * `IN (...)` placeholder lists — keep their own `prepare`, because caching them would key the map on
 * the shape of each call rather than on a fixed set of statements. Nothing here may call
 * `pluck`/`expand`/`safeIntegers` on a returned statement: those are sticky modes on a shared object.
 */
const preparedByDb = new WeakMap<Database.Database, Map<string, Database.Statement>>();

function stmt(db: Database.Database, sql: string): Database.Statement {
  let statements = preparedByDb.get(db);
  if (statements === undefined) {
    statements = new Map<string, Database.Statement>();
    preparedByDb.set(db, statements);
  }
  const hit = statements.get(sql);
  if (hit !== undefined) return hit;
  const prepared = db.prepare(sql);
  statements.set(sql, prepared);
  return prepared;
}

/**
 * Drop one handle's statements. A test that instruments `db.prepare` to count what the store reads
 * only sees the calls it does not already hold a statement for, so the instrumentation has to reset
 * this on the way in AND on the way out — otherwise the spy either counts nothing or outlives itself.
 */
export function _resetPreparedStatements(db: Database.Database): void {
  preparedByDb.delete(db);
}

/** The single append transaction: read last_seq, insert at last_seq + 1, refresh the cache columns. */
function appendWithinTransaction(
  db: Database.Database,
  runId: string,
  input: RunEventInput,
  now: Date,
): RunEvent {
  const actor = assertActor(input.actor);
  const type = assertType(input.type);
  const payload = serializePayload(input.payload);
  const ts = now.toISOString();

  const insert = db.transaction((): RunEvent => {
    const head = stmt(db, 'SELECT last_seq FROM studio_runs WHERE id = ?').get(runId) as { last_seq: number } | undefined;
    if (!head) throw new Error(`run not found: ${runId}`);
    const seq = head.last_seq + 1;
    stmt(db, 'INSERT INTO studio_run_events (run_id, seq, ts, actor, type, payload) VALUES (?, ?, ?, ?, ?, ?)')
      .run(runId, seq, ts, JSON.stringify(actor), type, payload);
    // Seeks, not a class read. The whole log used to be read and parsed here, inside the write lock,
    // to recompute one cached string; filtering it to the status types then left two writer-driven
    // pairs with no bound in it, so the cost still tracked how long the run had been going.
    const status = readStatusHead(db, runId, now);
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    // A counter is added where it is written. `cost.recorded` is one event per browser action by
    // design, so folding it at READ time made every list page pay for how much work its runs had
    // done; the columns are a cache of that fold, maintained in the same transaction as the event
    // that moves them, so the log stays the only source of truth (law 1).
    const delta = costDeltaOf(type, parsed);
    // Five possible texts, one per cost column plus the no-delta one, and every one of them is
    // constant — the column names come from `COST_COLUMN_BY_KIND` and never from a payload — so the
    // statement cache holds at most five entries however many kinds a run records.
    stmt(
      db,
      `UPDATE studio_runs SET status = ?, last_seq = ?, updated_at = ?${delta ? `, ${delta.column} = ${delta.column} + ?` : ''} WHERE id = ?`,
    ).run(...(delta ? [status, seq, ts, delta.amount, runId] : [status, seq, ts, runId]));
    return { seq, ts, actor, type, payload: parsed };
  });

  // IMMEDIATE takes the write lock up front, so the read of last_seq and the insert that depends on
  // it cannot be interleaved by a second writer — that is what makes seq gap-free under WAL.
  return insert.immediate();
}

function toFacts(r: RunRow): StoredRunFacts {
  return { id: r.id, task: r.task, spaceId: r.space_id, createdAt: r.created_at };
}

/**
 * When the human's clock on a card started. The payload wins when it carries one, because the card
 * can be raised before the mirror gets round to logging it — but only if it parses: a
 * `new Date('later today').toISOString()` throws, and it used to throw INSIDE the projection, so
 * one bad payload made the whole run unreadable on every surface.
 *
 * ...and only if it is not LATER than the envelope. A card cannot have been raised after the event
 * that records it, so a payload claiming a future `requestedAt` is describing something that did not
 * happen — and what it would buy is a deadline of its own choosing on a run it does not own. Pinning
 * the effective time at `ts` is also what lets the append path bound its pending-decision read by a
 * time window: no row outside the window can be live, whatever its payload says.
 */
function requestedAtOf(event: Pick<RunEvent, 'ts' | 'payload'>): string {
  const claimed = str(event.payload.requestedAt);
  if (claimed === undefined) return event.ts;
  const at = Date.parse(claimed);
  return Number.isFinite(at) && at <= Date.parse(event.ts) ? claimed : event.ts;
}

/** Pin 3's deadline, derived rather than stored — `autoDenyAt` is a rendering of this, not a fact. */
function autoDenyAtOf(requestedAt: string): string {
  return new Date(Date.parse(requestedAt) + AUTO_DENY_MS).toISOString();
}

function hasAutoDenied(requestedAt: string, now: Date): boolean {
  return now.getTime() >= Date.parse(requestedAt) + AUTO_DENY_MS;
}

/**
 * §1's ordered status rules, in exactly one place. `projectRun` and the append path's cache refresh
 * both go through here, so the projection and the cached column cannot drift apart.
 *
 * Every type it does not name is inert, which is what lets the append path feed it a read filtered
 * to `STATUS_EVENT_TYPES` and get the same answer as a full replay.
 */
function foldStatus(events: readonly Pick<RunEvent, 'ts' | 'type' | 'payload'>[], now: Date): RunStatus {
  let terminal: RunStatus | undefined;
  let pausedReason: string | undefined;
  const pending = new Set<string>();

  for (const event of events) {
    const p = event.payload;
    switch (event.type) {
      case 'run.completed': terminal = 'done'; break;
      case 'run.failed': terminal = 'failed'; break;
      case 'run.cancelled': terminal = 'cancelled'; break;
      case 'run.paused': pausedReason = str(p.reason) ?? 'agent'; break;
      case 'run.resumed': pausedReason = undefined; break;
      case 'decision.requested': {
        const decisionId = str(p.decisionId);
        // An expired card is not pending. Nothing writes the resolving event when the process that
        // owned the timer died, and a badge nobody can clear is worse than a missed one.
        if (decisionId && !hasAutoDenied(requestedAtOf(event), now)) pending.add(decisionId);
        break;
      }
      case 'decision.resolved': {
        const decisionId = str(p.decisionId);
        if (decisionId) pending.delete(decisionId);
        break;
      }
      default: break;
    }
  }

  return statusFrom(terminal, pausedReason, pending.size > 0);
}

/**
 * §1's precedence, in exactly one place, over the three facts either fold produces. A terminal event
 * outranks a pause; a cap or a decision means "needs you", an agent parking itself does not.
 */
function statusFrom(terminal: RunStatus | undefined, pausedReason: string | undefined, pending: boolean): RunStatus {
  if (terminal) return terminal;
  if (pausedReason !== undefined) {
    return pausedReason === 'cost_cap' || pausedReason === 'action_cap' || pausedReason === 'decision' ? 'needs_you' : 'paused';
  }
  return pending ? 'needs_you' : 'running';
}

/** The types whose newest row is the whole answer: three terminals and the pause pair. */
const SEEKABLE_STATUS_TYPES: readonly string[] = [...TERMINAL_EVENT_TYPES, ...PAUSE_EVENT_TYPES];
/** ...and the same for a projection, which also wants the newest verdict on visibility. */
const SEEKABLE_PROJECTION_TYPES: readonly string[] = [...SEEKABLE_STATUS_TYPES, ...PRESENTATION_EVENT_TYPES];

/**
 * One newest-row seek per type, in ONE statement. Each arm stops at the first entry of its own
 * (run_id, type, seq) slice, so the read is O(log depth) per type and returns at most one row per
 * type no matter how many times a run paused, resumed, or was promoted and demoted again.
 *
 * The arms are wrapped subselects because a compound SELECT cannot carry a per-arm ORDER BY/LIMIT.
 */
function newestRowsSql(types: readonly string[]): string {
  return types
    .map(() => 'SELECT * FROM (SELECT seq, ts, type, payload FROM studio_run_events WHERE run_id = ? AND type = ? ORDER BY seq DESC LIMIT 1)')
    .join(' UNION ALL ');
}
const NEWEST_STATUS_ROWS_SQL = newestRowsSql(SEEKABLE_STATUS_TYPES);
const NEWEST_PROJECTION_ROWS_SQL = newestRowsSql(SEEKABLE_PROJECTION_TYPES);

/**
 * The requests that could still be pending, and no others.
 *
 * Two bounds, and it takes both. The anti-join drops every request some LATER `decision.resolved`
 * answered — that is the fold's rule, restated in SQL. The `ts` bound is what makes it constant
 * work: a decision is only pending while it can still be answered, and `requestedAtOf` never reads
 * an effective request time LATER than the envelope's own `ts`, so a row older than the auto-deny
 * window cannot be pending whatever its payload claims. The window is a superset, never a filter —
 * expiry itself is decided in JS by the same `hasAutoDenied` a replay uses.
 *
 * `seq` rides along so the rows can be replayed in log order: one decision id can be re-requested
 * with no answer in between, and a fold keeps the NEWEST card at the FIRST card's position. Sorting
 * in JS rather than in SQL for the same reason the other reads do — an `ORDER BY seq` here would
 * cost the `ts` index that makes the read constant.
 */
const PENDING_DECISION_SQL = `
  SELECT req.seq AS seq, req.ts AS ts, req.payload AS payload
    FROM studio_run_events req
   WHERE req.run_id = ? AND req.type = 'decision.requested' AND req.ts >= ?
     AND NOT EXISTS (
       SELECT 1 FROM studio_run_events res
        WHERE res.run_id = req.run_id AND res.type = 'decision.resolved' AND res.seq > req.seq
          AND json_extract(res.payload, '$.decisionId') = json_extract(req.payload, '$.decisionId'))`;

/**
 * The cached `studio_runs.status`, recomputed without reading the status class. This runs inside the
 * write lock — every read it makes is a seek, and the number of rows it can return is fixed by the
 * schema (five heads) plus the decisions raised in the last two minutes.
 *
 * `foldStatus` remains the definition; this is the same rules asked of SQLite, and the two are
 * pinned equal by replaying one log both ways.
 */
function readStatusHead(db: Database.Database, runId: string, now: Date): RunStatus {
  const { terminal, pausedReason } = foldHeads(readHeads(db, NEWEST_STATUS_ROWS_SQL, SEEKABLE_STATUS_TYPES, runId));
  // Neither of the cheap answers settled it, so the expensive question gets asked — and only then.
  if (terminal || pausedReason !== undefined) return statusFrom(terminal, pausedReason, false);
  return statusFrom(undefined, undefined, hasPendingDecision(db, runId, now));
}

function readHeads(db: Database.Database, sql: string, types: readonly string[], runId: string): StatusRow[] {
  const params: unknown[] = [];
  for (const type of types) params.push(runId, type);
  return stmt(db, sql).all(...params) as StatusRow[];
}

/**
 * The newest row of each single-valued class, reduced to the three facts a projection wants. One
 * copy for both callers: the append path's status recompute reads the five status arms, a projection
 * reads those plus the presentation pair, and neither owns the precedence.
 */
function foldHeads(heads: readonly StatusRow[]): { terminal?: RunStatus; pausedReason?: string; visibility?: 'hidden' | 'visible' } {
  let terminalAt = -1;
  let terminal: RunStatus | undefined;
  let pauseAt = -1;
  let pause: StatusRow | undefined;
  let presentedAt = -1;
  let visibility: 'hidden' | 'visible' | undefined;
  for (const row of heads) {
    const asTerminal = TERMINAL_STATUS_BY_TYPE[row.type];
    if (asTerminal !== undefined) {
      if (row.seq > terminalAt) { terminalAt = row.seq; terminal = asTerminal; }
    } else if (PRESENTATION_EVENT_TYPES.includes(row.type)) {
      if (row.seq > presentedAt) { presentedAt = row.seq; visibility = row.type === 'presentation.promoted' ? 'visible' : 'hidden'; }
    } else if (row.seq > pauseAt) { pauseAt = row.seq; pause = row; }
  }

  let pausedReason: string | undefined;
  if (pause && pause.type === 'run.paused') {
    pausedReason = str((JSON.parse(pause.payload) as Record<string, unknown>).reason) ?? 'agent';
  }
  return { terminal, pausedReason, visibility };
}

/**
 * Does one unanswered, unexpired decision survive? The count never matters, only the existence.
 *
 * This runs inside the append's write lock, so every row it touches is time the shared database is
 * closed to everyone else. Listing the cards to ask `.length > 0` made that time track the number of
 * questions a run had raised — the `ts` bound is a bound on AGE, not on COUNT, and nothing caps how
 * many cards a run may raise — so it stops at the first row that survives instead.
 *
 * The stop cannot be a SQL `LIMIT 1`: the window is a superset of what is pending, and `pendingCardOf`
 * still refuses a request with no `decisionId` (nothing can ever answer it) and one whose effective
 * `requestedAt` has already expired. A row-shaped early-out would call either of those pending and
 * strand the run at `needs_you` with no card to answer.
 */
function hasPendingDecision(db: Database.Database, runId: string, now: Date): boolean {
  const since = new Date(now.getTime() - AUTO_DENY_MS).toISOString();
  const rows = stmt(db, PENDING_DECISION_SQL).iterate(runId, since) as IterableIterator<PendingRow>;
  // Leaving the loop early closes the statement, which the UPDATE that follows this read inside the
  // same transaction depends on — a live iterator would make the handle busy.
  for (const row of rows) {
    if (pendingCardOf({ ts: row.ts, payload: JSON.parse(row.payload) as Record<string, unknown> }, now)) return true;
  }
  return false;
}

/**
 * The cards a projection lists, from the bounded read rather than from the log. Replayed in `seq`
 * order through the same map `projectRun` folds into, so a re-requested decision id lands with the
 * newest card's content at the first card's position — the fold's rule, not an approximation of it.
 */
function readPendingDecisions(db: Database.Database, runId: string, now: Date): PendingDecision[] {
  const since = new Date(now.getTime() - AUTO_DENY_MS).toISOString();
  const rows = stmt(db, PENDING_DECISION_SQL).all(runId, since) as PendingRow[];
  rows.sort((a, b) => a.seq - b.seq);
  const pending = new Map<string, PendingDecision>();
  for (const row of rows) {
    const card = pendingCardOf({ ts: row.ts, payload: JSON.parse(row.payload) as Record<string, unknown> }, now);
    if (card) pending.set(card.decisionId, card);
  }
  return [...pending.values()];
}

/**
 * One decision.requested row, as the card a projection serves — or nothing, when it is not one.
 *
 * A request with no `decisionId` can never be answered, and an expired one is gone (pin 3): both are
 * "no card" rather than "a card to filter out later", which is what keeps a LATER re-request of the
 * same id able to overwrite an earlier one without an expired one deleting it.
 */
function pendingCardOf(event: Pick<RunEvent, 'ts' | 'payload'>, now: Date): PendingDecision | undefined {
  const p = event.payload;
  const decisionId = str(p.decisionId);
  if (!decisionId) return undefined;
  const requestedAt = requestedAtOf(event);
  if (hasAutoDenied(requestedAt, now)) return undefined;
  const anchor = anchorOf(p.anchor);
  return {
    decisionId,
    kind: str(p.kind) ?? 'approval',
    prompt: str(p.prompt) ?? '',
    ...(anchor ? { anchor } : {}),
    requestedAt,
    autoDenyAt: autoDenyAtOf(requestedAt),
  };
}


/**
 * A whole page's projectable rows in ONE query. The old list path issued an unbounded full-log read
 * per row — up to `MAX_LIST_LIMIT` of them, synchronously, so the router's deadline could not fire
 * during it.
 */
function readProjectionEvents(db: Database.Database, runIds: readonly string[]): Map<string, ProjectableEvent[]> {
  const byRun = new Map<string, ProjectableEvent[]>();
  for (const id of runIds) byRun.set(id, []);
  if (runIds.length === 0) return byRun;
  // Not through the statement cache: the placeholder list makes the text a function of how many runs
  // this page holds, so caching it would key the map on the shape of each call.
  const rows = db
    .prepare(`SELECT run_id, seq, ts, type, payload FROM studio_run_events WHERE run_id IN (${placeholders(runIds)}) AND type IN (${placeholders(PROJECTION_EVENT_TYPES)})`)
    .all(...runIds, ...PROJECTION_EVENT_TYPES) as ProjectionRow[];
  for (const r of rows) {
    byRun.get(r.run_id)?.push({ seq: r.seq, ts: r.ts, type: r.type, payload: JSON.parse(r.payload) as Record<string, unknown> });
  }
  // Ordered here for the same reason as the status read: an ORDER BY would cost the type index.
  for (const events of byRun.values()) events.sort((a, b) => a.seq - b.seq);
  return byRun;
}

/**
 * A row's seeds, with its status made non-optional. The status a filter is decided on and the status
 * the row carries are then the same value in the same object, not two calls that could drift — the
 * whole of what K7 bought, restated as a type.
 */
type RunSeed = ProjectRunOptions & { status: RunStatus };

/**
 * Everything a projection would otherwise have folded from unbounded rows, asked of SQLite instead —
 * two bounded reads per run, neither of which can grow with how long the run has been going.
 *
 * Per run and not per page, for the reason `readEventTails` is: every batched form of a per-run
 * newest-row question makes SQLite walk each run's whole log, and the seeks measured 250x better at
 * depth. Two statements rather than one compound because each has its own plan to keep green, and a
 * plan nobody can read is a plan nobody notices regressing.
 */
function readSeeds(db: Database.Database, runId: string, now: Date): RunSeed {
  const { terminal, pausedReason, visibility } = foldHeads(readHeads(db, NEWEST_PROJECTION_ROWS_SQL, SEEKABLE_PROJECTION_TYPES, runId));
  // The cards are read whatever the status says, because a finished or paused run still LISTS the
  // ones nobody answered — only the status question gets to stop early, and it does not here: the
  // count is already in hand.
  const pendingDecisions = readPendingDecisions(db, runId, now);
  return {
    visibility: visibility ?? 'hidden',
    pendingDecisions,
    status: statusFrom(terminal, pausedReason, pendingDecisions.length > 0),
  };
}

/**
 * `lastSeq`/`updatedAt` move with EVERY type, including the ones a projection ignores, so they
 * cannot come from the type-filtered read. They come from the log rather than the cached columns,
 * because a list row is a projection of the log and nothing else (law 1).
 *
 * One newest-row seek per run, not one page-wide query: every batched form — a correlated max, a
 * GROUP BY, a row-value IN — makes SQLite walk each run's whole log. Measured at 50 runs × 5000
 * events, those cost 68 / 22 / 14 ms against 0.05 ms for the seeks, because reversing the primary
 * key and stopping at the first row is O(log depth) and the rest are not.
 */
function readEventTails(db: Database.Database, runIds: readonly string[]): Map<string, { seq: number; ts: string }> {
  const tails = new Map<string, { seq: number; ts: string }>();
  if (runIds.length === 0) return tails;
  const newest = stmt(db, 'SELECT seq, ts FROM studio_run_events WHERE run_id = ? ORDER BY seq DESC LIMIT 1');
  for (const id of runIds) {
    const row = newest.get(id) as TailRow | undefined;
    if (row) tails.set(id, { seq: row.seq, ts: row.ts });
  }
  return tails;
}

/**
 * The ONE read path every projection goes through — a page of them or a single run. `getRun` used to
 * have its own, and its own was the unbounded one: `SELECT * FROM studio_run_events WHERE run_id = ?`
 * with no type filter and no limit, every row JSON-parsed, on the event loop. Measured at
 * 36 ms / 157 ms / 682 ms of blocked loop per `GET /v1/runs/{id}` at 25k / 100k / 400k events, on a
 * route whose response is four fields and a handful of tabs.
 *
 * Sharing the path is also what keeps the two agreeing: a list row and an item read cannot drift
 * when neither owns a query.
 */
function projectRows(db: Database.Database, rows: readonly RunRow[], now: Date, seeds?: readonly RunSeed[]): Run[] {
  const ids = rows.map((r) => r.id);
  const byRun = readProjectionEvents(db, ids);
  const tails = readEventTails(db, ids);
  return rows.map((r, i) => {
    const seed = seeds ? seeds[i] : readSeeds(db, r.id, now);
    const projected = projectRun(toFacts(r), byRun.get(r.id) ?? [], now, { cost: costOf(r), ...seed });
    const tail = tails.get(r.id);
    return tail ? { ...projected, lastSeq: tail.seq, updatedAt: tail.ts } : projected;
  });
}

function readEvents(db: Database.Database, runId: string, since = 0, limit?: number): RunEvent[] {
  const rows = (limit === undefined
    ? stmt(db, 'SELECT seq, ts, actor, type, payload FROM studio_run_events WHERE run_id = ? AND seq > ? ORDER BY seq ASC').all(runId, since)
    : stmt(db, 'SELECT seq, ts, actor, type, payload FROM studio_run_events WHERE run_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?').all(runId, since, limit)) as EventRow[];
  return rows.map(rowToEvent);
}

/**
 * Mint an id, try the INSERT, and let the primary key adjudicate. Racing writers are settled by the
 * same rule as a random collision — there is no read-then-write window to lose.
 *
 * The mint and the birth event share ONE transaction. Two of them would leave a window in which a
 * crash, a full disk or a kill produces a `studio_runs` row with `last_seq = 0` and no events — a
 * run the log does not contain, which law 1 forbids and `listRuns` (which reads the row directly)
 * would show. The caller's retry would then mint a second run for the same task. Nested here means
 * a SAVEPOINT when a caller already holds a transaction, which is what makes this composable.
 */
export function createRun(db: Database.Database, input: CreateRunInput, opts: RunStoreOptions = {}): Run {
  const task = assertTask(input.task);
  const driver = assertDriver(input.driver);
  const spaceId = input.spaceId ?? DEFAULT_SPACE_ID;
  const now = opts.now?.() ?? new Date();
  const createdAt = now.toISOString();
  const mint = opts.mintId ?? mintRunId;

  const mintAndBirth = db.transaction((): { id: string; created: RunEvent } => {
    const insertRun = stmt(db, 'INSERT INTO studio_runs (id, task, space_id, created_at, status, last_seq, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?)');
    let id: string | undefined;
    for (let length = RUN_ID_MIN_LENGTH; length <= MAX_ID_LENGTH && id === undefined; length++) {
      for (let attempt = 0; attempt < MINT_ATTEMPTS_PER_LENGTH; attempt++) {
        const candidate = normalizeRunId(mint(length));
        try {
          // A statement-level constraint failure aborts the statement, not the transaction, so the
          // collision retry survives being wrapped.
          insertRun.run(candidate, task, spaceId, createdAt, 'running', createdAt);
          id = candidate;
          break;
        } catch (err) {
          if (!isUniqueViolation(err)) throw err;
        }
      }
    }
    if (id === undefined) throw new Error('could not mint a unique run id');

    const created = appendWithinTransaction(db, id, {
      actor: { kind: 'daemon' },
      type: 'run.created',
      payload: { task, spaceId, driver, ...(input.sessionId ? { sessionId: input.sessionId } : {}) },
    }, now);
    return { id, created };
  });

  const { id, created } = mintAndBirth.immediate();
  // Both side effects are post-commit by contract — a disk projection or a live-tail listener must
  // never be able to unwind, or observe, a write that is still in flight.
  projectToDisk(id, created, opts.dataDir);
  opts.onEvent?.(id, created);

  return getRun(db, id)!;
}

function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string }).code;
  if (code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || code === 'SQLITE_CONSTRAINT_UNIQUE') return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed/i.test(msg);
}

export function appendEvent(db: Database.Database, runId: string, input: RunEventInput, opts: RunStoreOptions = {}): RunEvent {
  const id = normalizeRunId(runId);
  const event = appendWithinTransaction(db, id, input, opts.now?.() ?? new Date());
  projectToDisk(id, event, opts.dataDir);
  opts.onEvent?.(id, event);
  return event;
}

export function getRun(db: Database.Database, runId: string, opts: ReadRunOptions = {}): Run | undefined {
  const id = resolveRunId(runId);
  if (id === undefined) return undefined;
  const row = stmt(db, `SELECT ${RUN_ROW_COLUMNS} FROM studio_runs WHERE id = ?`).get(id) as RunRow | undefined;
  if (!row) return undefined;
  return projectRows(db, [row], opts.now?.() ?? new Date())[0];
}

/**
 * Does this run exist? Deliberately NOT `getRun(...) !== undefined`: that projects the run, which
 * reads its entire event log. A caller that only needs existence — the SSE route's 404 check, ahead
 * of a replay that is careful to page — must not pay an unbounded synchronous read to ask.
 */
export function runExists(db: Database.Database, runId: string): boolean {
  const id = resolveRunId(runId);
  if (id === undefined) return false;
  const row = stmt(db, 'SELECT 1 AS ok FROM studio_runs WHERE id = ?').get(id);
  return row !== undefined;
}

export function eventsSince(db: Database.Database, runId: string, since = 0, limit?: number): RunEvent[] {
  const id = resolveRunId(runId);
  return id === undefined ? [] : readEvents(db, id, since, limit);
}

/**
 * One keyset read of the run table — everything a row can be selected by WITHOUT projecting it.
 * Status is deliberately not here; see `listRuns`.
 */
function readRunPage(
  db: Database.Database,
  spaceId: string | undefined,
  after: { createdAt: string; id: string } | undefined,
  n: number,
): RunRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (spaceId) {
    where.push('space_id = ?');
    params.push(spaceId);
  }
  if (after) {
    // Keyset, not offset: a run inserted mid-page cannot shift the rows a client has not seen yet.
    //
    // A row value and not the `created_at < ? OR (created_at = ? AND id < ?)` it is equivalent to.
    // The two select the same rows, but only this form is an index RANGE: against the OR SQLite
    // declined the constraint and planned `SCAN ... USING INDEX`, walking the index from the newest
    // row on every page, where the row value plans `SEARCH ... ((created_at,id)<(?,?))` and seeks
    // straight to the cursor.
    where.push('(created_at, id) < (?, ?)');
    params.push(after.createdAt, after.id);
  }
  // Four texts rather than one, built from which filters the caller passed — outside the statement
  // cache for the same reason as the projection read, and off the append path either way.
  const sql = `SELECT ${RUN_ROW_COLUMNS} FROM studio_runs${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT ?`;
  return db.prepare(sql).all(...params, n) as RunRow[];
}

/**
 * How many reads one call will do before it hands the rest back as a cursor. A status filter cannot
 * be pushed into SQL (below), so a filter matching nothing would otherwise walk the whole table
 * synchronously. A short page plus a cursor is the honest answer; a short page and no cursor would
 * read as "that was all".
 */
export const MAX_LIST_SCAN_PAGES = 8;

/**
 * ...and the rows those reads share, which is the bound that actually holds.
 *
 * A page count alone is not a bound on work, because the page is the caller's: at `MAX_LIST_LIMIT`
 * the same eight reads looked at 1608 rows rather than 408, and nothing in `listRuns` awaits, so all
 * of it is one uninterruptible block of event loop. Measured at `?limit=200&status=cancelled` with
 * no matches: 123-288 ms. Sharing one row ceiling makes the pages get SHORTER as the caller's page
 * gets longer, so the ceiling belongs to the store and not to the request — while the first read is
 * still always the full `limit + 1`, so an unfiltered call is exactly the one read it always was.
 */
export const MAX_LIST_SCAN_ROWS = MAX_LIST_SCAN_PAGES * (DEFAULT_LIST_LIMIT + 1);

/**
 * K7: the status filter is decided on the PROJECTION, never on the cached `status` column.
 *
 * The column is refreshed by an append and by nothing else — there is no auto-deny writer and pin 3
 * deliberately keeps expiry event-free — so one instant past a decision's deadline the column still
 * says `needs_you` while every projection says `running`. Filtering on the column while returning
 * projected rows made `?status=running` EXCLUDE a running run and `?status=needs_you` return a row
 * whose own body said `"status": "running"`: a page contradicting its own filter, which no client
 * can reconcile.
 *
 * The fix is to delete the second answer rather than to synchronise it. `run.status` from
 * `projectRows` is the only status any surface is allowed to be selected by, so filter and row are
 * the same value by construction and there is no second predicate left to drift. The cost is that
 * the filter can no longer bound the SQL read, so the page is filled by scanning forward — one read
 * when nothing is filtered out, more when matches are sparse, never more than `MAX_LIST_SCAN_PAGES`
 * reads, or `MAX_LIST_SCAN_ROWS` rows, before yielding a cursor.
 *
 * What a scanned row COSTS is the other half, and the half that first shipped wrong: every row the
 * scan looked at was fully projected, so a sparse filter paid up to eight pages of projections to
 * return one page. It is two-phase now. A row's status comes from its seeds — bounded newest-row
 * seeks plus the auto-deny-windowed decision read — and only the survivors are projected, which is
 * what costs the unbounded per-run reads: `readProjectionEvents` over every tab and cost event a run
 * ever wrote, plus a tail seek each. Rows fully projected per call is therefore `limit + 1`,
 * filtered or not, rather than `MAX_LIST_SCAN_PAGES` times that.
 *
 * The seeds are computed once and handed to the projection rather than re-read inside it. Re-reading
 * would put a second status answer back in front of the row it admitted, which is the exact defect
 * K7 deleted — so the filter and the row it lets through are one `RunSeed`, not two calls that
 * happen to agree today.
 *
 * The look-ahead row is a candidate rather than a lookahead under a filter, so it is decided like
 * every other row, and projected only if it survives.
 */
export function listRuns(db: Database.Database, opts: ListRunsOptions = {}): ListRunsResult {
  const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_LIST_LIMIT), MAX_LIST_LIMIT);
  const cursor = opts.cursor ? decodeCursor(opts.cursor) : undefined;
  // A cursor is opaque, not unchecked. `Buffer.from(x, 'base64url')` never throws — it drops the
  // characters it cannot read — so a corrupted or truncated cursor used to decode to nothing and be
  // treated as "no cursor", silently restarting pagination. A client that pages in a loop then
  // never terminates, or double-processes the first page and calls it the last.
  if (opts.cursor && !cursor) throw new Error('invalid cursor');
  const now = opts.now?.() ?? new Date();
  const wanted = opts.status?.length ? new Set<RunStatus>(opts.status) : undefined;

  const matched: { row: RunRow; run: Run }[] = [];
  let after = cursor;
  let lastScanned: RunRow | undefined;
  let reads = 0;
  let scanned = 0;
  let exhausted = false;

  // One row past the page, so "is there more" costs no second query. With no status filter every
  // scanned row matches and this loop runs exactly once, as the unfiltered path always did.
  while (matched.length <= limit && !exhausted && reads < MAX_LIST_SCAN_PAGES && scanned < MAX_LIST_SCAN_ROWS) {
    // Never more than the caller's page, never more than the budget has left. The first read always
    // gets the full `limit + 1` because nothing has been spent yet.
    const want = Math.min(limit + 1, MAX_LIST_SCAN_ROWS - scanned);
    const rows = readRunPage(db, opts.spaceId, after, want);
    // Short of what was ASKED for, not short of a page: a read trimmed by the budget is not the end
    // of the table, and calling it one would drop the cursor and end pagination early.
    if (rows.length < want) exhausted = true;
    if (rows.length === 0) break;
    reads++;
    scanned += rows.length;
    // Phase one: the cheap answer for every scanned row. Bounded seeks per row and nothing per event.
    const seeds = rows.map((row) => readSeeds(db, row.id, now));
    const survivors: RunRow[] = [];
    const survivorSeeds: RunSeed[] = [];
    rows.forEach((row, i) => {
      if (!wanted || wanted.has(seeds[i].status)) { survivors.push(row); survivorSeeds.push(seeds[i]); }
    });
    // Phase two: the expensive one, over survivors only. Bounded queries for the chunk, not one
    // unbounded full-log read per row.
    const runs = projectRows(db, survivors, now, survivorSeeds);
    survivors.forEach((row, i) => matched.push({ row, run: runs[i] }));
    lastScanned = rows[rows.length - 1];
    after = { createdAt: lastScanned.created_at, id: lastScanned.id };
  }

  const page = matched.slice(0, limit);
  const runs = page.map((m) => m.run);
  const last = page[page.length - 1];
  if (matched.length > limit && last) return { runs, nextCursor: encodeCursor(last.row.created_at, last.row.id) };
  // Stopped on the scan bound rather than on the end of the table: the answer is not finished, so it
  // carries a cursor from the last row LOOKED AT — the rows in between are already decided.
  if (!exhausted && lastScanned) return { runs, nextCursor: encodeCursor(lastScanned.created_at, lastScanned.id) };
  return { runs };
}

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}\n${id}`, 'utf8').toString('base64url');
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/**
 * Strict, because base64url decoding is not. The round-trip is the load-bearing check: a cursor
 * with a dropped or flipped character still decodes to *something*, and only re-encoding proves the
 * bytes we read are the bytes the encoder wrote.
 */
function decodeCursor(cursor: string): { createdAt: string; id: string } | undefined {
  if (!BASE64URL.test(cursor)) return undefined;
  const bytes = Buffer.from(cursor, 'base64url');
  if (bytes.toString('base64url') !== cursor) return undefined;
  const parts = bytes.toString('utf8').split('\n');
  if (parts.length !== 2) return undefined;
  const [createdAt, id] = parts;
  // Both halves are checked against the shape the ENCODER produces, not merely "non-empty": a
  // cursor truncated on a byte boundary still splits into two plausible halves, and the only thing
  // that catches it is that the timestamp is no longer a canonical instant or the id is no longer
  // a mintable id.
  if (!createdAt || !id || !isValidRunId(id)) return undefined;
  const at = Date.parse(createdAt);
  if (!Number.isFinite(at) || new Date(at).toISOString() !== createdAt) return undefined;
  return { createdAt, id };
}

/** The REST seam's pre-check, so a bad cursor is a 400 from the router rather than a thrown 500. */
export function isValidListCursor(cursor: string): boolean {
  return decodeCursor(cursor) !== undefined;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Rebuild every derived field from the log. This is the whole of law 1 in one function: if a field
 * cannot be produced here, it must not exist on `Run`.
 *
 * Unknown types are ignored and preserved — a consumer that does not know `mark.placed` must not
 * drop it or refuse the run.
 */
export function projectRun(
  facts: StoredRunFacts,
  events: readonly ProjectableEvent[],
  now: Date = new Date(),
  opts: ProjectRunOptions = {},
): Run {
  let driver: Driver = { kind: 'api' };
  let visibility: 'hidden' | 'visible' = opts.visibility ?? 'hidden';
  // The array is the answer — law 4's tabs in the order the run took them. The Set is only the
  // membership question the array cannot answer cheaply: `includes` is O(held) per attach, so a run
  // holding many tabs at once paid O(held squared) to project (measured 112 ms at 16k attach-only).
  // A detach that names a tab the run does not hold now costs nothing rather than a full walk.
  const tabIds: string[] = [];
  const held = new Set<string>();
  const pending = new Map<string, PendingDecision>((opts.pendingDecisions ?? []).map((d) => [d.decisionId, d]));
  const cost: RunCost = { ...(opts.cost ?? { browserActions: 0, tokensIn: 0, tokensOut: 0, spendUsd: 0 }) };

  for (const event of events) {
    const p = event.payload;
    switch (event.type) {
      case 'run.created': {
        const d = p.driver as Driver | undefined;
        if (d && DRIVER_KINDS.has(d.kind)) {
          // Rebuilt from the payload rather than cast out of it, for the reason `anchorOf` exists:
          // this is a projected field on its way to a REST response.
          const client = clientOf(d.client);
          driver = client ? { kind: d.kind, client } : { kind: d.kind };
        }
        break;
      }
      // run.completed / run.failed / run.cancelled / run.paused / run.resumed move only the status,
      // which `foldStatus` owns below. They stay listed in PROJECTION_EVENT_TYPES all the same.
      case 'tab.attached': {
        const tabId = str(p.tabId);
        if (tabId && !held.has(tabId)) { held.add(tabId); tabIds.push(tabId); }
        break;
      }
      case 'tab.detached': {
        const tabId = str(p.tabId);
        if (tabId && held.delete(tabId)) tabIds.splice(tabIds.indexOf(tabId), 1);
        break;
      }
      case 'presentation.promoted': visibility = 'visible'; break;
      case 'presentation.demoted': visibility = 'hidden'; break;
      case 'decision.requested': {
        // `pendingCardOf` is the rule, shared with the bounded read: an expired card is gone, so it
        // can neither be listed nor hold the run at needs_you, and producing no card rather than
        // filtering afterwards is what keeps a LATER re-request of the same id able to overwrite it.
        const card = pendingCardOf(event, now);
        if (card) pending.set(card.decisionId, card);
        break;
      }
      case 'decision.resolved': {
        const decisionId = str(p.decisionId);
        if (decisionId) pending.delete(decisionId);
        break;
      }
      case 'cost.recorded': {
        const amount = num(p.amount);
        if (p.kind === 'browser_action') cost.browserActions += amount;
        else if (p.kind === 'tokens_in') cost.tokensIn += amount;
        else if (p.kind === 'tokens_out') cost.tokensOut += amount;
        else if (p.kind === 'spend_usd') cost.spendUsd += amount;
        break;
      }
      default: break; // unknown type — ignored here, preserved in the log
    }
  }

  const newest = events[events.length - 1];
  const pendingDecisions = [...pending.values()];
  // The seed comes from `readStatusHead`'s rules, which a test replays one log both ways to pin
  // equal to this fold. A caller with a full log omits it and gets the fold.
  const projected = opts.status ?? foldStatus(events, now);

  return {
    id: facts.id,
    task: facts.task,
    spaceId: facts.spaceId,
    createdAt: facts.createdAt,
    status: projected,
    driver,
    tabIds,
    pendingDecisions,
    cost,
    visibility,
    lastSeq: newest?.seq ?? 0,
    updatedAt: newest?.ts ?? facts.createdAt,
  };
}
