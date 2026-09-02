/**
 * The driver baton (SD2 mini-spec §1) — law 3's "one driver at a time" as a projection of
 * `driver.*` events over the run log.
 *
 * WHAT THIS IS. A run-scoped, durable, five-kind answer to *who has authority over this run*
 * (`cli · sdk · api · studio · human`). Every transition is an explicit gesture that appends one
 * event; nothing here holds mutable state, and the run store's single-writer append is the
 * serializer, so two "simultaneous" wheel requests have a total order by `seq` and the queue is
 * FIFO on that order (A-51-1, mini-spec §1.3).
 *
 * WHAT THIS IS NOT. It is NOT an authorization boundary and must never be described as one.
 * It sits ABOVE `src/studio/control-token.ts` (ruling A-51-1), which is the session-scoped,
 * epoch-fenced answer to *whose input reaches this browser right now* — that one is the fence, and
 * it is untouched here. And the identity this module compares is the MCP handshake badge, which a
 * client SELF-REPORTS (A-51-9): it coordinates cooperating clients, it does not defend against a
 * lying one. `notDriving` therefore refuses only when it can POSITIVELY establish that a
 * differently-identified client holds the wheel — never on an absence of information, which would
 * be a coordination gate pretending to be a fence.
 *
 * Takeover receipts, the §1.4 interrupted-once shape and the token bridge are `wigolo-studio-run#217`.
 */
import type Database from 'better-sqlite3';
import { appendRunEventWithTail } from '../studio/run-bus.js';
import {
  getRun,
  sameDriver,
  type Actor,
  type ClientInfo,
  type Driver,
  type Run,
  type RunEvent,
  type WheelRequest,
} from '../studio/run-store.js';
import { createLogger } from '../logger.js';
import { currentClientProfile } from './capability-handshake.js';
import type { BatonGate, StudioToolError } from './studio-dispatch.js';

const log = createLogger('studio');

export const DRIVER_CHANGED = 'driver.changed';
export const WHEEL_REQUESTED = 'driver.wheel_requested';
export const WHEEL_DENIED = 'driver.wheel_denied';

/** The three ways the wheel can move (mini-spec §1.3). There is no fourth. */
export type DriverChangeCause = 'takeover' | 'grant' | 'release';

/**
 * THE formatter. Law 3 says the driver is "shown identically everywhere", so the string rendered in
 * REST (`GET /v1/runs/:id`), minted into `driver.*` payloads for the event stream, and named in a
 * tool refusal all come from here — one function, asserted equal across all three by
 * `tests/integration/driver-baton-surfaces.test.ts`.
 *
 * Capability language: the kinds are the product's own vocabulary, and a client badge is whatever
 * the client called itself. No engine, library or model name can reach this string.
 */
export function formatDriver(driver: Driver): string {
  const name = driver.client?.name.trim();
  return name ? `${driver.kind} (${name})` : driver.kind;
}

/**
 * The badge as it goes onto the wire: the driver whole, plus the rendered name beside it. Minted
 * here so an SSE consumer in any language reads the same string the REST body carries without
 * reimplementing the formatter — the one place `driverName` is produced for the log.
 */
function driverPayload(driver: Driver): { kind: Driver['kind']; client?: ClientInfo; name: string } {
  return { ...driver, name: formatDriver(driver) };
}

/**
 * A run event's actor, derived from the driver making the gesture. `human` is the one kind that maps
 * to the human actor; every machine driver is an `agent` wearing its driver kind, which is exactly
 * what `Actor` was shaped for in SD1.
 */
export function actorFor(driver: Driver): Actor {
  return {
    kind: driver.kind === 'human' ? 'human' : 'agent',
    driver: driver.kind,
    ...(driver.client ? { client: driver.client } : {}),
  };
}

/** Refusals are machine codes, never sentences — same contract as `StudioToolError.error_reason`. */
export type BatonRefusalReason = 'run_not_found' | 'not_the_driver' | 'unknown_request' | 'no_successor';

export interface BatonRefused {
  ok: false;
  error_reason: BatonRefusalReason;
  error: string;
  hint: string;
  /** Present whenever the run exists — who actually drives, so a refused caller can resync in one hop. */
  driver?: Driver;
  driverName?: string;
}

export interface BatonAccepted {
  ok: true;
  /** The run as of this gesture. */
  run: Run;
  /** The events this gesture appended — empty when the gesture was a no-op (law 3: never bump spuriously). */
  events: RunEvent[];
  /** Set by `requestWheel`: the id a grant answers. An idempotent repeat returns the ORIGINAL id. */
  requestId?: string;
}

export type BatonResult = BatonAccepted | BatonRefused;

const NOT_THE_DRIVER_HINT =
  'Another client is driving this run. Request the wheel to drive; you can observe results and events meanwhile.';

function refuse(reason: BatonRefusalReason, error: string, hint: string, run?: Run): BatonRefused {
  return {
    ok: false,
    error_reason: reason,
    error,
    hint,
    ...(run ? { driver: run.driver, driverName: formatDriver(run.driver) } : {}),
  };
}

/**
 * Who may hand the wheel on: the current driver, or a human — who "outranks the driver at all
 * times" (§1.3.2). Anything else is refused; there is no path by which an observer moves the baton
 * other than asking for it.
 */
function mayHandOver(run: Run, by: Driver): boolean {
  return by.kind === 'human' || sameDriver(run.driver, by);
}

function readRun(db: Database.Database, runId: string): Run | BatonRefused {
  const run = getRun(db, runId);
  if (!run) {
    return refuse('run_not_found', `No run ${runId}.`, 'List runs with GET /v1/runs. Run ids are case-insensitive.');
  }
  return run;
}

function isRefusal(x: Run | BatonRefused): x is BatonRefused {
  return (x as BatonRefused).ok === false;
}

/**
 * Append the one transition event, plus the A-51-10 pause when a release found no successor.
 *
 * A transition TO THE CURRENT DRIVER emits nothing at all (§1.3.4) — the SD1 "never bump
 * spuriously" discipline, which is what keeps a projected `driver.changed` count honest as a count
 * of real handovers.
 */
function changeDriver(
  db: Database.Database,
  run: Run,
  to: Driver,
  cause: DriverChangeCause,
  by: Driver,
  extra: { requestId?: string; reason?: string },
): BatonAccepted {
  if (sameDriver(run.driver, to)) return { ok: true, run, events: [] };
  const actor = actorFor(by);
  const events: RunEvent[] = [
    appendRunEventWithTail(db, run.id, {
      actor,
      type: DRIVER_CHANGED,
      payload: {
        from: driverPayload(run.driver),
        to: driverPayload(to),
        cause,
        ...(extra.requestId ? { requestId: extra.requestId } : {}),
        ...(extra.reason ? { reason: extra.reason } : {}),
      },
    }),
  ];
  // A-51-10: a release into an empty queue lands on `human` AND pauses the run, so it shows in the
  // tray as needing someone rather than sitting silently idle with nobody driving it.
  if (cause === 'release' && !extra.requestId && to.kind === 'human') {
    events.push(appendRunEventWithTail(db, run.id, {
      actor,
      type: 'run.paused',
      payload: { reason: 'agent', detail: 'driver released' },
    }));
  }
  log.debug('driver changed', { runId: run.id, cause, to: formatDriver(to) });
  return { ok: true, run: getRun(db, run.id) ?? run, events };
}

export interface WheelRequestInput {
  by: Driver;
  reason?: string;
  /** Injectable so a test can force the race deterministically; production mints one. */
  requestId?: string;
}

/**
 * Ask to drive. A gesture, never a race (law 3) — and never implicit: an observer's refused act does
 * NOT enqueue this, which is the whole of §1.5's "request-the-wheel is explicit".
 *
 * Idempotent per client: a second request while one is pending returns the ORIGINAL `requestId` and
 * appends nothing, so a client that retries cannot flood the queue or lose its place in it.
 */
export function requestWheel(db: Database.Database, runId: string, input: WheelRequestInput): BatonResult {
  const run = readRun(db, runId);
  if (isRefusal(run)) return run;
  const pending = run.wheelRequests.find((r) => sameDriver(r.by, input.by));
  if (pending) return { ok: true, run, events: [], requestId: pending.requestId };
  const requestId = input.requestId ?? mintRequestId();
  const event = appendRunEventWithTail(db, run.id, {
    actor: actorFor(input.by),
    type: WHEEL_REQUESTED,
    payload: {
      requestId,
      by: driverPayload(input.by),
      ...(input.reason ? { reason: input.reason } : {}),
    },
  });
  return { ok: true, run: getRun(db, run.id) ?? run, events: [event], requestId };
}

export interface WheelDenyInput {
  by: Driver;
  requestId: string;
  reason?: string;
}

/**
 * Decline a request, or withdraw your own. The driver and any human may deny; a requester may
 * always withdraw its own request, which is why the third arm exists.
 */
export function denyWheel(db: Database.Database, runId: string, input: WheelDenyInput): BatonResult {
  const run = readRun(db, runId);
  if (isRefusal(run)) return run;
  const target = run.wheelRequests.find((r) => r.requestId === input.requestId);
  if (!target) {
    return refuse('unknown_request', `No pending wheel request ${input.requestId} on run ${run.id}.`,
      'Read the live queue from GET /v1/runs/<id> ("wheelRequests") — a request already answered is gone.', run);
  }
  if (!mayHandOver(run, input.by) && !sameDriver(target.by, input.by)) {
    return refuse('not_the_driver', `${formatDriver(run.driver)} is driving run ${run.id}.`, NOT_THE_DRIVER_HINT, run);
  }
  const event = appendRunEventWithTail(db, run.id, {
    actor: actorFor(input.by),
    type: WHEEL_DENIED,
    payload: {
      requestId: input.requestId,
      by: input.by.kind,
      ...(input.reason ? { reason: input.reason } : {}),
    },
  });
  return { ok: true, run: getRun(db, run.id) ?? run, events: [event] };
}

export interface WheelGrantInput {
  by: Driver;
  /** Answer THIS queued request. Preferred: naming the request, not "whoever is first right now", is what makes a UI race unable to misdeliver the wheel (§1.3.2). */
  requestId?: string;
  /** Or name a successor outright. Ignored when `requestId` resolves. */
  to?: Driver;
  reason?: string;
}

export function grantWheel(db: Database.Database, runId: string, input: WheelGrantInput): BatonResult {
  const run = readRun(db, runId);
  if (isRefusal(run)) return run;
  if (!mayHandOver(run, input.by)) {
    return refuse('not_the_driver', `${formatDriver(run.driver)} is driving run ${run.id}.`, NOT_THE_DRIVER_HINT, run);
  }
  let to = input.to;
  let requestId: string | undefined;
  if (input.requestId !== undefined) {
    const target = run.wheelRequests.find((r) => r.requestId === input.requestId);
    if (!target) {
      return refuse('unknown_request', `No pending wheel request ${input.requestId} on run ${run.id}.`,
        'Read the live queue from GET /v1/runs/<id> ("wheelRequests") — a request already answered is gone.', run);
    }
    to = target.by;
    requestId = target.requestId;
  }
  if (!to) {
    return refuse('no_successor', 'A grant must name either a queued "requestId" or an explicit "to" driver.',
      'Grant by requestId whenever the queue holds one — naming the request is what stops a race misdelivering the wheel.', run);
  }
  return changeDriver(db, run, to, 'grant', input.by, { ...(requestId ? { requestId } : {}), ...(input.reason ? { reason: input.reason } : {}) });
}

export interface WheelReleaseInput {
  by: Driver;
  reason?: string;
}

/**
 * Give the wheel up without naming a successor: the head of the queue takes it (lowest `seq`,
 * FIFO), or — with nobody waiting — it lands on `human` and the run pauses (A-51-10).
 */
export function releaseWheel(db: Database.Database, runId: string, input: WheelReleaseInput): BatonResult {
  const run = readRun(db, runId);
  if (isRefusal(run)) return run;
  if (!mayHandOver(run, input.by)) {
    return refuse('not_the_driver', `${formatDriver(run.driver)} is driving run ${run.id}.`, NOT_THE_DRIVER_HINT, run);
  }
  const head = run.wheelRequests[0];
  if (head) {
    return changeDriver(db, run, head.by, 'release', input.by, { requestId: head.requestId, ...(input.reason ? { reason: input.reason } : {}) });
  }
  return changeDriver(db, run, { kind: 'human' }, 'release', input.by, { ...(input.reason ? { reason: input.reason } : {}) });
}

export interface WheelTakeoverInput {
  /** Human surfaces only — a machine driver cannot seize (`control-token.ts:9-10`, lifted verbatim). */
  by: Driver;
  reason?: string;
}

/**
 * Human takeover: absolute, instant, never queued, never refusable. Bypasses `wheelRequests`
 * entirely — a human does not join a queue for their own browser.
 */
export function takeWheel(db: Database.Database, runId: string, input: WheelTakeoverInput): BatonResult {
  const run = readRun(db, runId);
  if (isRefusal(run)) return run;
  if (input.by.kind !== 'human') {
    return refuse('not_the_driver', 'Takeover is a human gesture; an agent driver asks for the wheel instead.',
      'Machine drivers use the request/grant gestures. Only a human surface takes the wheel outright.', run);
  }
  return changeDriver(db, run, input.by, 'takeover', input.by, { ...(input.reason ? { reason: input.reason } : {}) });
}

/**
 * Request ids are opaque and unique within a run. Time-ordered prefix so a raw log reads in order to
 * a human, random suffix so two requests minted in the same millisecond cannot collide.
 */
export function mintRequestId(): string {
  const now = Date.now().toString(36).padStart(9, '0');
  const rand = Math.floor(Math.random() * 0xffffff).toString(36).padStart(5, '0');
  return `wr_${now}${rand}`;
}

/**
 * §7 row 12, the read half: is this caller an OBSERVER of a run someone else drives?
 *
 * Returns the refusal when — and only when — a differently-identified client positively holds the
 * wheel. Both "the run has no client badge to compare against" and "the caller carries none" are an
 * ABSENCE OF INFORMATION, and refusing on absence would make this look like the fence it is not
 * (see the file header). A human driver is the one badge-free case that DOES refuse: no MCP client
 * is ever the human, so the answer is knowable without comparing anything.
 */
export function notDriving(run: Run, caller: ClientInfo | undefined): BatonRefused | undefined {
  const driver = run.driver;
  if (driver.kind !== 'human') {
    if (!driver.client || !caller) return undefined;
    if (driver.client.name === caller.name && driver.client.version === caller.version) return undefined;
  }
  return refuse('not_the_driver', `${formatDriver(driver)} is driving run ${run.id}.`, NOT_THE_DRIVER_HINT, run);
}

/**
 * The act-class tool set. An observer may still observe, list, read marks and capture — those are
 * §1.5's "results addressed to them". What it may NOT do is change the world: drive the page, or
 * open and close the sessions the run's tabs live in.
 *
 * `studio_say` is deliberately read-class: it posts a message to the attended human, and an observer
 * telling the human what it sees is exactly the collaboration law 3 wants. `studio_extract_set` is
 * likewise a read of a page someone else is driving. (A-52-2; reversal: if either is ever shown to
 * mutate page or session state, it moves here.)
 */
export const ACT_CLASS_TOOLS: readonly string[] = Object.freeze([
  'studio_act',
  'studio_open',
  'studio_spawn',
  'studio_close',
]);

/** The tool-boundary refusal, in `StudioToolError` clothing so dispatch serializes it verbatim. */
export function toToolError(refused: BatonRefused): StudioToolError {
  return {
    error_reason: refused.error_reason,
    error: refused.error,
    hint: refused.hint,
    ...(refused.driver ? { driver: refused.driver, driver_name: refused.driverName } : {}),
  };
}

export interface BatonGateOptions {
  /**
   * The run log. Resolved per call and allowed to fail: a process that cannot open the store simply
   * has no baton to enforce, and saying so by refusing every act would be a worse answer than the
   * one this surface had before the baton existed.
   */
  openDb?: () => Promise<Database.Database | undefined>;
  /**
   * Which run this call is about. Today the only run handle available AT THE TOOL BOUNDARY is an
   * optional `run_id` argument — deliberately not advertised in any tool schema, so it costs no
   * description budget and no instruction-file seam. When #217 lands the session→run link on the
   * host path, THIS is the one line that changes: the run comes from the connection's attachment
   * and every caller gets the baton without naming it.
   */
  runIdFor?: (name: string, args: Record<string, unknown>) => string | undefined;
  /** Who is calling. Defaults to the MCP handshake badge, scoped over the dispatch by `withClientProfile`. */
  caller?: () => ClientInfo | undefined;
}

function runIdFromArgs(_name: string, args: Record<string, unknown>): string | undefined {
  const raw = args.run_id ?? args.runId;
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined;
}

async function defaultDb(): Promise<Database.Database | undefined> {
  try {
    const { getDatabase } = await import('../cache/db.js');
    return getDatabase();
  } catch {
    return undefined;
  }
}

/**
 * Build the §7 row 12 gate: refuse an ACT-CLASS call from a client that is not this run's driver,
 * naming who is.
 *
 * Allows on every absence — no run named, no store, no badge to compare, an unreadable run — and
 * never throws: this is coordination between cooperating clients (see the file header), and a
 * coordination gate that hard-failed a call it could not classify would be strictly worse than the
 * surface it replaced. The refusal is only ever minted from a POSITIVE answer.
 */
export function createBatonGate(options: BatonGateOptions = {}): BatonGate {
  const openDb = options.openDb ?? defaultDb;
  const runIdFor = options.runIdFor ?? runIdFromArgs;
  const caller = options.caller ?? (() => currentClientProfile().client);
  return async (name, args) => {
    if (!ACT_CLASS_TOOLS.includes(name)) return undefined;
    const runId = runIdFor(name, args);
    if (!runId) return undefined;
    try {
      const db = await openDb();
      if (!db) return undefined;
      const run = getRun(db, runId);
      if (!run) return undefined;
      const refused = notDriving(run, caller());
      return refused ? toToolError(refused) : undefined;
    } catch (err) {
      log.warn('baton gate could not resolve the run; allowing the call', { runId, error: String(err) });
      return undefined;
    }
  };
}
