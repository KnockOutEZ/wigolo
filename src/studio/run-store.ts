/**
 * The durable run store (SD1 spine 1).
 *
 * A run is the unit of everything: task + append-only event log + tab group + pending decisions +
 * cost counters + driver state. The EVENT LOG IS THE SINGLE SOURCE OF TRUTH — every other field on
 * `Run` is a projection of it, and the `status`/`last_seq`/`updated_at` columns on `studio_runs`
 * are a cache that `projectRun` can rebuild from the log alone.
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

export interface ListRunsOptions {
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
 * Every type `projectRun`'s switch reads. `listRuns` projects a whole page from these alone: the
 * `default: break` arm is the proof that no other type can change a projected field, and `lastSeq` /
 * `updatedAt` — which DO move with any type — come from a separate bounded tail read.
 *
 * Adding a `case` to `projectRun` means adding its type here. A source guard in the run-store tests
 * enforces that, because a case added without its type would silently drop from every list row.
 */
export const PROJECTION_EVENT_TYPES: readonly string[] = [
  'run.created',
  'tab.attached',
  'tab.detached',
  'presentation.promoted',
  'presentation.demoted',
  'cost.recorded',
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

/** Ids are case-normalized on input everywhere — a footer read back in caps still resolves. */
export function normalizeRunId(id: string): string {
  return String(id).trim().toLowerCase();
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
interface StatusRow { type: string; payload: string }
interface ProjectionRow { run_id: string; seq: number; ts: string; type: string; payload: string }
interface TailRow { run_id: string; seq: number; ts: string }

function placeholders(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ');
}

function assertTask(task: unknown): string {
  if (typeof task !== 'string' || task.trim().length === 0) throw new Error('task is required');
  if (task.length > MAX_TASK_CHARS) throw new Error(`task exceeds ${MAX_TASK_CHARS} characters`);
  return task;
}

function assertDriver(driver: Driver | undefined): Driver {
  if (driver === undefined) return { kind: 'api' };
  if (!DRIVER_KINDS.has(driver.kind)) throw new Error(`unknown driver: ${String(driver.kind)}`);
  return driver.client ? { kind: driver.kind, client: driver.client } : { kind: driver.kind };
}

function assertActor(actor: Actor): Actor {
  if (!actor || !ACTOR_KINDS.has(actor.kind)) throw new Error(`unknown actor: ${String(actor?.kind)}`);
  if (actor.driver !== undefined && !DRIVER_KINDS.has(actor.driver)) throw new Error(`unknown actor driver: ${String(actor.driver)}`);
  return actor;
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
  try {
    return JSON.stringify(payload);
  } catch {
    throw new Error('payload must be JSON-serializable');
  }
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
  try {
    mkdirSync(runDir(runId, dataDir), { recursive: true, mode: 0o700 });
    appendFileSync(runEventsFile(runId, dataDir), JSON.stringify(event) + '\n', { mode: 0o600 });
  } catch (err) {
    log.warn('run event disk projection failed', { runId, seq: event.seq, error: err instanceof Error ? err.message : String(err) });
  }
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
    const status = foldStatus(readStatusEvents(db, runId));
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
 * §1's ordered status rules, in exactly one place. `projectRun` and the append path's cache refresh
 * both go through here, so the projection and the cached column cannot drift apart.
 *
 * Every type it does not name is inert, which is what lets the append path feed it a read filtered
 * to `STATUS_EVENT_TYPES` and get the same answer as a full replay.
 */
function foldStatus(events: readonly Pick<RunEvent, 'type' | 'payload'>[]): RunStatus {
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
        if (decisionId) pending.add(decisionId);
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

/** One run's status-relevant rows, and nothing else. This runs inside the write lock — keep it thin. */
function readStatusEvents(db: Database.Database, runId: string): Pick<RunEvent, 'type' | 'payload'>[] {
  const rows = db
    .prepare(`SELECT type, payload FROM studio_run_events WHERE run_id = ? AND type IN (${placeholders(STATUS_EVENT_TYPES)}) ORDER BY seq ASC`)
    .all(runId, ...STATUS_EVENT_TYPES) as StatusRow[];
  return rows.map((r) => ({ type: r.type, payload: JSON.parse(r.payload) as Record<string, unknown> }));
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
    .prepare(`SELECT run_id, seq, ts, type, payload FROM studio_run_events WHERE run_id IN (${placeholders(runIds)}) AND type IN (${placeholders(PROJECTION_EVENT_TYPES)}) ORDER BY run_id ASC, seq ASC`)
    .all(...runIds, ...PROJECTION_EVENT_TYPES) as ProjectionRow[];
  for (const r of rows) {
    byRun.get(r.run_id)?.push({ seq: r.seq, ts: r.ts, type: r.type, payload: JSON.parse(r.payload) as Record<string, unknown> });
  }
  return byRun;
}

/**
 * `lastSeq`/`updatedAt` move with EVERY type, including the ones a projection ignores, so they
 * cannot come from the type-filtered read. They come from the log rather than the cached columns so
 * a list row stays a projection of the log alone (law 1) — one groupwise max over the primary key,
 * for the whole page, not a read per row.
 */
function readEventTails(db: Database.Database, runIds: readonly string[]): Map<string, { seq: number; ts: string }> {
  const tails = new Map<string, { seq: number; ts: string }>();
  if (runIds.length === 0) return tails;
  const rows = db
    .prepare(`SELECT run_id, seq, ts FROM studio_run_events AS e WHERE run_id IN (${placeholders(runIds)}) AND seq = (SELECT MAX(seq) FROM studio_run_events WHERE run_id = e.run_id)`)
    .all(...runIds) as TailRow[];
  for (const r of rows) tails.set(r.run_id, { seq: r.seq, ts: r.ts });
  return tails;
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
 */
export function createRun(db: Database.Database, input: CreateRunInput, opts: RunStoreOptions = {}): Run {
  const task = assertTask(input.task);
  const driver = assertDriver(input.driver);
  const spaceId = input.spaceId ?? DEFAULT_SPACE_ID;
  const now = opts.now?.() ?? new Date();
  const createdAt = now.toISOString();
  const mint = opts.mintId ?? mintRunId;

  const insertRun = db.prepare('INSERT INTO studio_runs (id, task, space_id, created_at, status, last_seq, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?)');
  let id: string | undefined;
  for (let length = RUN_ID_MIN_LENGTH; length <= MAX_ID_LENGTH && id === undefined; length++) {
    for (let attempt = 0; attempt < MINT_ATTEMPTS_PER_LENGTH; attempt++) {
      const candidate = normalizeRunId(mint(length));
      try {
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

export function getRun(db: Database.Database, runId: string): Run | undefined {
  const id = normalizeRunId(runId);
  const row = db.prepare('SELECT id, task, space_id, created_at FROM studio_runs WHERE id = ?').get(id) as RunRow | undefined;
  if (!row) return undefined;
  return projectRun(toFacts(row), readEvents(db, id));
}

/**
 * Does this run exist? Deliberately NOT `getRun(...) !== undefined`: that projects the run, which
 * reads its entire event log. A caller that only needs existence — the SSE route's 404 check, ahead
 * of a replay that is careful to page — must not pay an unbounded synchronous read to ask.
 */
export function runExists(db: Database.Database, runId: string): boolean {
  const row = db.prepare('SELECT 1 AS ok FROM studio_runs WHERE id = ?').get(normalizeRunId(runId));
  return row !== undefined;
}

export function eventsSince(db: Database.Database, runId: string, since = 0, limit?: number): RunEvent[] {
  return readEvents(db, normalizeRunId(runId), since, limit);
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
  if (cursor) {
    // Keyset, not offset: a run inserted mid-page cannot shift the rows a client has not seen yet.
    where.push('(created_at < ? OR (created_at = ? AND id < ?))');
    params.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  const sql = `SELECT id, task, space_id, created_at FROM studio_runs${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT ?`;
  const rows = db.prepare(sql).all(...params, limit + 1) as RunRow[];
  const page = rows.slice(0, limit);
  const ids = page.map((r) => r.id);
  // Three bounded queries for the page, not one unbounded full-log read per row.
  const byRun = readProjectionEvents(db, ids);
  const tails = readEventTails(db, ids);
  const runs = page.map((r) => {
    const projected = projectRun(toFacts(r), byRun.get(r.id) ?? []);
    const tail = tails.get(r.id);
    return tail ? { ...projected, lastSeq: tail.seq, updatedAt: tail.ts } : projected;
  });
  const last = page[page.length - 1];
  return rows.length > limit && last
    ? { runs, nextCursor: encodeCursor(last.created_at, last.id) }
    : { runs };
}

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}\n${id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: string; id: string } | undefined {
  const [createdAt, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('\n');
  return createdAt && id ? { createdAt, id } : undefined;
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
export function projectRun(facts: StoredRunFacts, events: readonly ProjectableEvent[]): Run {
  let driver: Driver = { kind: 'api' };
  let visibility: 'hidden' | 'visible' = 'hidden';
  const tabIds: string[] = [];
  const pending = new Map<string, PendingDecision>();
  const cost: RunCost = { browserActions: 0, tokensIn: 0, tokensOut: 0, spendUsd: 0 };

  for (const event of events) {
    const p = event.payload;
    switch (event.type) {
      case 'run.created': {
        const d = p.driver as Driver | undefined;
        if (d && DRIVER_KINDS.has(d.kind)) driver = d.client ? { kind: d.kind, client: d.client } : { kind: d.kind };
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
        const requestedAt = str(p.requestedAt) ?? event.ts;
        pending.set(decisionId, {
          decisionId,
          kind: str(p.kind) ?? 'approval',
          prompt: str(p.prompt) ?? '',
          ...(p.anchor ? { anchor: p.anchor as PendingDecision['anchor'] } : {}),
          requestedAt,
          autoDenyAt: new Date(new Date(requestedAt).getTime() + AUTO_DENY_MS).toISOString(),
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
  const projected = foldStatus(events);

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
