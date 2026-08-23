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
import { appendFileSync, mkdirSync } from 'node:fs';
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
 * What a projection can be handed instead of reading it. `cost` is the SQL-folded total for the
 * types in `AGGREGATED_EVENT_TYPES`; supplying it and ALSO passing `cost.recorded` rows would double
 * count, which is why the store's filtered read and this seed are mutually exclusive by
 * construction. A caller with a full log (a replay, the app's view model) simply omits it.
 */
export interface ProjectRunOptions {
  cost?: RunCost;
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
 * The only types `foldStatus` can be moved by. The append path recomputes the `studio_runs.status`
 * cache column from these alone — over `idx_studio_run_events_type` — instead of re-reading and
 * re-parsing the whole log inside the write transaction, which cost O(events-so-far) of held
 * write-lock time on the shared database every single append.
 *
 * Adding a status rule to `foldStatus` means adding its type here.
 */
export const STATUS_EVENT_TYPES: readonly string[] = [
  'run.completed',
  'run.failed',
  'run.cancelled',
  'run.paused',
  'run.resumed',
  'decision.requested',
  'decision.resolved',
];

/**
 * Every type `projectRun`'s switch reads AS A ROW. A read projects a whole run from these alone:
 * the `default: break` arm is the proof that no other type can change a projected field, and
 * `lastSeq` / `updatedAt` — which DO move with any type — come from a separate bounded tail read.
 *
 * Adding a `case` to `projectRun` means adding its type here OR to `AGGREGATED_EVENT_TYPES`. A
 * source guard in the run-store tests enforces that, because a case added to neither would silently
 * drop from every projected row.
 */
export const PROJECTION_EVENT_TYPES: readonly string[] = [
  'run.created',
  'tab.attached',
  'tab.detached',
  'presentation.promoted',
  'presentation.demoted',
  ...STATUS_EVENT_TYPES,
];

/**
 * The types a projection folds in SQL instead of reading row by row, and the reason the type filter
 * above is a real bound rather than a shape.
 *
 * Every other projected type is a state transition a run emits a handful of times — tabs, driver,
 * visibility, status. `cost.recorded` is a COUNTER: one per browser action by design, so its
 * cardinality tracks how much work a run did and nothing caps it. Reading it per row put the whole
 * log back inside the type filter (measured on the tip: 200k `mark.placed` → 0.3 ms to project;
 * 200k `cost.recorded` → 244 ms, all of it JSON-parsing rows whose only use is to be added up).
 *
 * A sum is not a fold that needs the rows, so `readCostTotals` asks SQLite for the four totals and
 * the projection receives them pre-aggregated. `projectRun` keeps its `cost.recorded` case for the
 * callers that hand it a full log (a replay, the app's view model) — with the seed and the case
 * mutually exclusive, because a type in this list is never in the filtered read.
 */
export const AGGREGATED_EVENT_TYPES: readonly string[] = ['cost.recorded'];

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

interface RunRow { id: string; task: string; space_id: string; created_at: string }
interface EventRow { seq: number; ts: string; actor: string; type: string; payload: string }
interface StatusRow { seq: number; ts: string; type: string; payload: string }
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
  let dir: string | undefined;
  try {
    dir = runDir(runId, dataDir);
    ensureRunDir(dir);
    try {
      appendFileSync(runEventsFile(runId, dataDir), line, { mode: 0o600 });
    } catch {
      // The memo is an optimisation, never a claim: the tree can be moved, cleaned or unmounted
      // between two appends. Any write failure retires it and re-creates the directory once, so the
      // observable behaviour is the unmemoised one — a deleted run directory is back on the NEXT
      // append, not the one after it.
      ensuredRunDirs.delete(dir);
      ensureRunDir(dir);
      appendFileSync(runEventsFile(runId, dataDir), line, { mode: 0o600 });
    }
  } catch (err) {
    if (dir !== undefined) ensuredRunDirs.delete(dir);
    log.warn('run event disk projection failed', { runId, seq: event.seq, error: err instanceof Error ? err.message : String(err) });
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
    const head = db.prepare('SELECT last_seq FROM studio_runs WHERE id = ?').get(runId) as { last_seq: number } | undefined;
    if (!head) throw new Error(`run not found: ${runId}`);
    const seq = head.last_seq + 1;
    db.prepare('INSERT INTO studio_run_events (run_id, seq, ts, actor, type, payload) VALUES (?, ?, ?, ?, ?, ?)')
      .run(runId, seq, ts, JSON.stringify(actor), type, payload);
    // Status-relevant rows only. The whole log used to be read and parsed here, inside the write
    // lock, to recompute one cached string — O(events-so-far) per append, held against every other
    // writer on the shared database.
    const status = foldStatus(readStatusEvents(db, runId), now);
    db.prepare('UPDATE studio_runs SET status = ?, last_seq = ?, updated_at = ? WHERE id = ?').run(status, seq, ts, runId);
    return { seq, ts, actor, type, payload: JSON.parse(payload) as Record<string, unknown> };
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
 */
function requestedAtOf(event: Pick<RunEvent, 'ts' | 'payload'>): string {
  const claimed = str(event.payload.requestedAt);
  return claimed !== undefined && Number.isFinite(Date.parse(claimed)) ? claimed : event.ts;
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

  // A terminal event outranks a pause; a cap or a decision means "needs you", an agent parking
  // itself does not.
  if (terminal) return terminal;
  if (pausedReason !== undefined) {
    return pausedReason === 'cost_cap' || pausedReason === 'action_cap' || pausedReason === 'decision' ? 'needs_you' : 'paused';
  }
  return pending.size > 0 ? 'needs_you' : 'running';
}

/**
 * One run's status-relevant rows, and nothing else. This runs inside the write lock — keep it thin.
 *
 * The seq order is restored here rather than asked of SQLite: an `ORDER BY seq` makes the planner
 * prefer the (run_id, seq) primary key, which satisfies the sort but scans every row the run has —
 * exactly the O(log-depth) read this exists to avoid. Unordered, it seeks (run_id, type) instead,
 * and a handful of status rows sort for free.
 */
function readStatusEvents(db: Database.Database, runId: string): Pick<RunEvent, 'ts' | 'type' | 'payload'>[] {
  const rows = db
    .prepare(`SELECT seq, ts, type, payload FROM studio_run_events WHERE run_id = ? AND type IN (${placeholders(STATUS_EVENT_TYPES)})`)
    .all(runId, ...STATUS_EVENT_TYPES) as StatusRow[];
  return rows
    .sort((a, b) => a.seq - b.seq)
    .map((r) => ({ ts: r.ts, type: r.type, payload: JSON.parse(r.payload) as Record<string, unknown> }));
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
 * The four cost totals per run, folded by SQLite. Bounded in the only way that matters to a caller:
 * it returns at most one row per cost KIND per run — four — no matter how many counter events a run
 * recorded, and no payload is parsed in this process to get them.
 *
 * The arithmetic is deliberately `projectRun`'s, restated in SQL: a non-numeric `amount` contributes
 * zero rather than coercing (SQLite would read `"3"` and `true` as 3 and 1; `num()` reads both as
 * 0), and an unrecognised `kind` lands in no bucket. The two folds are pinned equal by a test that
 * replays the same log both ways.
 */
function readCostTotals(db: Database.Database, runIds: readonly string[]): Map<string, RunCost> {
  const totals = new Map<string, RunCost>();
  if (runIds.length === 0) return totals;
  const rows = db
    .prepare(
      `SELECT run_id, json_extract(payload, '$.kind') AS kind,
              SUM(CASE WHEN json_type(payload, '$.amount') IN ('integer', 'real') THEN json_extract(payload, '$.amount') ELSE 0 END) AS total
         FROM studio_run_events
        WHERE run_id IN (${placeholders(runIds)}) AND type = 'cost.recorded'
        GROUP BY run_id, kind`,
    )
    .all(...runIds) as { run_id: string; kind: unknown; total: number | null }[];
  for (const r of rows) {
    const cost = totals.get(r.run_id) ?? { browserActions: 0, tokensIn: 0, tokensOut: 0, spendUsd: 0 };
    const amount = num(r.total);
    if (r.kind === 'browser_action') cost.browserActions += amount;
    else if (r.kind === 'tokens_in') cost.tokensIn += amount;
    else if (r.kind === 'tokens_out') cost.tokensOut += amount;
    else if (r.kind === 'spend_usd') cost.spendUsd += amount;
    totals.set(r.run_id, cost);
  }
  return totals;
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
  const newest = db.prepare('SELECT seq, ts FROM studio_run_events WHERE run_id = ? ORDER BY seq DESC LIMIT 1');
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
function projectRows(db: Database.Database, rows: readonly RunRow[], now: Date): Run[] {
  const ids = rows.map((r) => r.id);
  const byRun = readProjectionEvents(db, ids);
  const tails = readEventTails(db, ids);
  const costs = readCostTotals(db, ids);
  return rows.map((r) => {
    const projected = projectRun(toFacts(r), byRun.get(r.id) ?? [], now, { cost: costs.get(r.id) });
    const tail = tails.get(r.id);
    return tail ? { ...projected, lastSeq: tail.seq, updatedAt: tail.ts } : projected;
  });
}

function readEvents(db: Database.Database, runId: string, since = 0, limit?: number): RunEvent[] {
  const rows = (limit === undefined
    ? db.prepare('SELECT seq, ts, actor, type, payload FROM studio_run_events WHERE run_id = ? AND seq > ? ORDER BY seq ASC').all(runId, since)
    : db.prepare('SELECT seq, ts, actor, type, payload FROM studio_run_events WHERE run_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?').all(runId, since, limit)) as EventRow[];
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
    const insertRun = db.prepare('INSERT INTO studio_runs (id, task, space_id, created_at, status, last_seq, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?)');
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
  const row = db.prepare('SELECT id, task, space_id, created_at FROM studio_runs WHERE id = ?').get(id) as RunRow | undefined;
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
  const row = db.prepare('SELECT 1 AS ok FROM studio_runs WHERE id = ?').get(id);
  return row !== undefined;
}

export function eventsSince(db: Database.Database, runId: string, since = 0, limit?: number): RunEvent[] {
  const id = resolveRunId(runId);
  return id === undefined ? [] : readEvents(db, id, since, limit);
}

export function listRuns(db: Database.Database, opts: ListRunsOptions = {}): ListRunsResult {
  const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_LIST_LIMIT), MAX_LIST_LIMIT);
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.status?.length) {
    where.push(`status IN (${opts.status.map(() => '?').join(', ')})`);
    params.push(...opts.status);
  }
  if (opts.spaceId) {
    where.push('space_id = ?');
    params.push(opts.spaceId);
  }
  const cursor = opts.cursor ? decodeCursor(opts.cursor) : undefined;
  // A cursor is opaque, not unchecked. `Buffer.from(x, 'base64url')` never throws — it drops the
  // characters it cannot read — so a corrupted or truncated cursor used to decode to nothing and be
  // treated as "no cursor", silently restarting pagination. A client that pages in a loop then
  // never terminates, or double-processes the first page and calls it the last.
  if (opts.cursor && !cursor) throw new Error('invalid cursor');
  if (cursor) {
    // Keyset, not offset: a run inserted mid-page cannot shift the rows a client has not seen yet.
    where.push('(created_at < ? OR (created_at = ? AND id < ?))');
    params.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  const sql = `SELECT id, task, space_id, created_at FROM studio_runs${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT ?`;
  const rows = db.prepare(sql).all(...params, limit + 1) as RunRow[];
  const page = rows.slice(0, limit);
  // Bounded queries for the page, not one unbounded full-log read per row.
  const runs = projectRows(db, page, opts.now?.() ?? new Date());
  const last = page[page.length - 1];
  return rows.length > limit && last
    ? { runs, nextCursor: encodeCursor(last.created_at, last.id) }
    : { runs };
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
  let visibility: 'hidden' | 'visible' = 'hidden';
  const tabIds: string[] = [];
  const pending = new Map<string, PendingDecision>();
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
        if (tabId && !tabIds.includes(tabId)) tabIds.push(tabId);
        break;
      }
      case 'tab.detached': {
        const tabId = str(p.tabId);
        const at = tabId ? tabIds.indexOf(tabId) : -1;
        if (at >= 0) tabIds.splice(at, 1);
        break;
      }
      case 'presentation.promoted': visibility = 'visible'; break;
      case 'presentation.demoted': visibility = 'hidden'; break;
      case 'decision.requested': {
        const decisionId = str(p.decisionId);
        if (!decisionId) break;
        const requestedAt = requestedAtOf(event);
        // Same rule as `foldStatus`: an expired card is gone, so it can neither be listed nor hold
        // the run at needs_you. Skipping it here rather than filtering afterwards keeps a LATER
        // re-request of the same decisionId able to overwrite it.
        if (hasAutoDenied(requestedAt, now)) break;
        const anchor = anchorOf(p.anchor);
        pending.set(decisionId, {
          decisionId,
          kind: str(p.kind) ?? 'approval',
          prompt: str(p.prompt) ?? '',
          ...(anchor ? { anchor } : {}),
          requestedAt,
          autoDenyAt: autoDenyAtOf(requestedAt),
        });
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
  const projected = foldStatus(events, now);

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
