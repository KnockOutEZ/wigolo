/**
 * The release receipt (SD2 mini-spec §1.4, §7 row 3) — what the OLD driver is told once the wheel
 * has moved on without it.
 *
 * WHY THIS EXISTS AT ALL. A pull transport cannot be told anything; it can only be answered. So the
 * moment the wheel moves, the client that used to hold it is in the worst possible state: it is
 * still connected, still willing to work, and nothing it does will ever produce a result again. Law
 * 7 says we say so rather than let it poll into silence. The receipt is that sentence, and it rides
 * the client's very next tool call — ANY call, including one the baton refuses, because a refusal
 * is exactly the call a stranded driver is most likely to make.
 *
 * IT IS A PROJECTION, NOT A MESSAGE. Nothing is enqueued when the wheel moves. The receipt is folded
 * out of the `driver.changed` row itself, which is what makes the §7-row-3 acceptance "an old driver
 * that never calls again still has the receipt as a run event" true by construction rather than by a
 * cleanup job: the transition IS the receipt, and delivery is a separate, later, optional fact.
 *
 * `driver.receipt_delivered` is that separate fact, and it is AUDIT ONLY — it moves no projected
 * field, so it stays out of `DRIVER_EVENT_TYPES` and `PROJECTION_EVENT_TYPES` exactly as
 * `run-store.ts:271` already decided it would. It doubles as the once-ness key: the anti-join
 * against its `at_seq` is what makes a receipt undeliverable twice, durably, across a restart.
 *
 * A TAKEOVER IS NOT A RELEASE. §1.3's receipts table gives the taken-from driver the §1.4
 * `interrupted` shape (`message-queue.ts`, the delivery queue's interrupt mechanism) and gives the
 * released-from driver this. The two are disjoint by `cause`, which is why nothing here matches
 * `cause: 'takeover'`.
 */
import type Database from 'better-sqlite3';
import { appendRunEventWithTail } from '../studio/run-bus.js';
import {
  eventsOfTypes,
  getRun,
  MAX_TYPED_EVENT_ROWS,
  type Actor,
  type ClientInfo,
  type Driver,
  type DriverKind,
  type ProjectableEvent,
  type Run,
} from '../studio/run-store.js';
import { createLogger } from '../logger.js';
import { currentClientProfile } from './capability-handshake.js';
import { DRIVER_CHANGED, actorFor, formatDriver, type DriverChangeCause } from './driver-baton.js';
import { watchLink } from './studio-footer.js';
import type { McpToolResult, ReceiptDelivery } from './studio-dispatch.js';

const log = createLogger('studio');

/** Audit-only: the receipt reached a client. Deliberately not a projected type — see the header. */
export const RECEIPT_DELIVERED = 'driver.receipt_delivered';

/**
 * §7 row 3's "nothing to poll", verbatim. Exported so the test that pins the phrase and the code
 * that writes it cannot drift apart into two nearly-identical sentences.
 */
export const NOTHING_TO_POLL = 'nothing to poll';

/**
 * How far back a receipt is looked for. A receipt is only ever owed for the LAST transition that
 * stranded this client, so the scan is newest-first and shallow; the bound is here so a run with a
 * pathological handover history costs a page, not the log.
 */
export const MAX_RECEIPT_SCAN = 50;

/** The two causes that strand the old driver. A takeover is answered by the interrupt shape instead. */
const RECEIPTED_CAUSES: readonly DriverChangeCause[] = ['release', 'grant'];

/** The §1.4 wire shape. `to` is the NEW driver — who the wheel went to, kind plus client name. */
export interface ReleaseReceipt {
  to: { kind: DriverKind; client: ClientInfo | null };
  text: string;
}

export interface PendingReceipt {
  /** The `driver.changed` row this receipt projects; the once-ness key. */
  triggerSeq: number;
  /** The OLD driver — the client this receipt is owed to. Recorded as `to` on the audit event. */
  target: Driver;
  receipt: ReleaseReceipt;
}

function clientOf(raw: unknown): ClientInfo | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (typeof value.name !== 'string' || typeof value.version !== 'string') return undefined;
  return { name: value.name, version: value.version };
}

const DRIVER_KINDS = new Set<string>(['cli', 'sdk', 'api', 'studio', 'human']);

/** A `driver.changed` payload's `from`/`to` back as a `Driver`; the minted `name` is dropped, never trusted. */
function driverFrom(raw: unknown): Driver | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (typeof value.kind !== 'string' || !DRIVER_KINDS.has(value.kind)) return undefined;
  const client = clientOf(value.client);
  return { kind: value.kind as DriverKind, ...(client ? { client } : {}) };
}

/**
 * Was the wheel taken FROM this caller? Same leniency as the interrupt mechanism's: a badge-less run
 * or a badge-less caller is an ABSENCE of information, and the receipt is a courtesy to a
 * cooperating client rather than a fence, so an absence resolves in favour of telling somebody
 * rather than nobody. A human never matches — no MCP client is the human.
 */
function strandedCaller(driver: Driver, caller: ClientInfo | undefined): boolean {
  if (driver.kind === 'human') return false;
  if (!driver.client || !caller) return true;
  return driver.client.name === caller.name && driver.client.version === caller.version;
}

/**
 * Did the wheel go TO this caller? The mirror question, and it does NOT get the same leniency: this
 * arm SUPPRESSES a receipt, so answering it on an absence would silently strand the client the
 * receipt exists for. `{ kind: 'studio' }` carries no MCP badge and is therefore never the MCP
 * client asking — reading it as "might be you" is what made a human's grant to the panel look, to
 * the agent it was taken from, like nothing had happened at all.
 */
function reinstatedCaller(driver: Driver, caller: ClientInfo | undefined): boolean {
  if (driver.kind === 'human' || !driver.client || !caller) return false;
  return driver.client.name === caller.name && driver.client.version === caller.version;
}

/**
 * The sentence, per cause. Both arms carry the same three §7-row-3 facts — to whom, nothing to poll,
 * the watch link — and differ only in who is described as having moved the wheel, because "you
 * released the wheel" is simply false when a human took it off this client and handed it to another
 * (A-217-2). One `formatDriver` call, so the name here is the name in REST, the footer and the log.
 */
export function releaseReceiptText(runId: string, cause: DriverChangeCause, to: Driver): string {
  const opening = cause === 'release'
    ? `You released the wheel to ${formatDriver(to)}.`
    : `The wheel was granted to ${formatDriver(to)}.`;
  return `${opening} No further results will arrive on this connection — ${NOTHING_TO_POLL}. Watch: ${watchLink(runId)}`;
}

function receiptFor(runId: string, event: ProjectableEvent): ReleaseReceipt | undefined {
  const cause = event.payload.cause;
  if (typeof cause !== 'string' || !RECEIPTED_CAUSES.includes(cause as DriverChangeCause)) return undefined;
  const to = driverFrom(event.payload.to);
  if (!to) return undefined;
  return {
    to: { kind: to.kind, client: to.client ?? null },
    text: releaseReceiptText(runId, cause as DriverChangeCause, to),
  };
}

/**
 * The once-ness key: one transition, one recipient. Keyed on the RECIPIENT as well as the seq
 * because two clients can be stranded by the same handover, and a run-wide key would let whichever
 * of them called first swallow the other's receipt.
 */
function receiptKey(seq: number, caller: ClientInfo | undefined): string {
  return `${seq}|${caller ? `${caller.name}@${caller.version}` : '-'}`;
}

function deliveredKeys(db: Database.Database, runId: string): Set<string> {
  const keys = new Set<string>();
  for (const row of eventsOfTypes(db, runId, { types: [RECEIPT_DELIVERED], limit: MAX_TYPED_EVENT_ROWS, newestFirst: true })) {
    const at = row.payload.at_seq;
    if (typeof at !== 'number') continue;
    keys.add(receiptKey(at, driverFrom(row.payload.to)?.client));
  }
  return keys;
}

/**
 * The receipt this caller is owed on this call, or nothing.
 *
 * The log alone answers it, newest transition first, and the FIRST row that mentions this caller
 * decides — there is no separate "are you still the driver" pre-check. That is deliberate: the run's
 * `driver` field cannot distinguish a badge-less driver kind from the badge-less caller that the
 * baton gate must not refuse, and borrowing the gate's absence-tolerant answer here suppressed the
 * receipt for exactly the handover it was written for. The transition history has no such ambiguity:
 * a wheel that came BACK to you says so in a row of its own.
 */
export function pendingReleaseReceipt(
  db: Database.Database,
  run: Run,
  caller: ClientInfo | undefined,
): PendingReceipt | undefined {
  const history = eventsOfTypes(db, run.id, { types: [DRIVER_CHANGED], limit: MAX_RECEIPT_SCAN, newestFirst: true });
  const latest = history[0];
  if (!latest) return undefined; // the wheel has never moved

  const to = driverFrom(latest.payload.to);
  if (!to) return undefined;
  // You drive again: "no further results will arrive" would be the opposite of true.
  if (reinstatedCaller(to, caller)) return undefined;

  // Who this caller is, in the run's own driver vocabulary — read off the handover it appears in
  // rather than assumed from its badge, and simultaneously the proof that it ever held the wheel
  // here at all. A client that never drove this run is owed nothing about it.
  const mine = history.find((event) => {
    const from = driverFrom(event.payload.from);
    return from !== undefined && strandedCaller(from, caller);
  });
  const target = mine ? driverFrom(mine.payload.from) : undefined;
  if (!target) return undefined;

  // Disjointness from §7 row 2 is enforced in ONE place — `RECEIPTED_CAUSES`, read by `receiptFor`
  // below — and deliberately not also guarded here. A second check keyed on the same predicate
  // would be unfalsifiable, and an unfalsifiable guard reads as protection that nothing is testing.
  if (deliveredKeys(db, run.id).has(receiptKey(latest.seq, caller))) return undefined;
  const receipt = receiptFor(run.id, latest);
  return receipt ? { triggerSeq: latest.seq, target, receipt } : undefined;
}

/** The audit actor: the old driver as it was, wearing the badge that just called. */
function recipientActor(target: Driver, caller: ClientInfo | undefined): Actor {
  const base = actorFor(target);
  return caller ? { ...base, client: caller } : base;
}

/**
 * Record that the receipt landed. `to` is the RECIPIENT (the old driver) — not the successor named
 * inside `receipt.to`, which is a different question the same word answers in the two shapes.
 * `at_seq` is the seq of the transition being receipted, which is what identifies WHICH handover
 * this answered and what the once-ness anti-join reads (A-217-1).
 */
export function consumeReleaseReceipt(
  db: Database.Database,
  run: Run,
  caller: ClientInfo | undefined,
  pending: PendingReceipt,
): void {
  appendRunEventWithTail(db, run.id, {
    actor: recipientActor(pending.target, caller),
    type: RECEIPT_DELIVERED,
    payload: { to: pending.target, at_seq: pending.triggerSeq },
  });
}

/**
 * Merge the receipt into the result the call was going to return anyway. Returns `undefined` rather
 * than inventing a carrier when the result is not a JSON object — the queue's
 * no-delivery-into-nowhere invariant, applied to a receipt: better still owed than silently dropped.
 */
export function withReleaseReceipt(result: McpToolResult, receipt: ReleaseReceipt): McpToolResult | undefined {
  const block = result.content[0];
  if (!block || block.type !== 'text') return undefined;
  let data: unknown;
  try {
    data = JSON.parse(block.text);
  } catch {
    return undefined;
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const merged = { ...(data as Record<string, unknown>), released: receipt };
  return { ...result, content: [{ type: 'text', text: JSON.stringify(merged, null, 2) }, ...result.content.slice(1)] };
}

export interface ReceiptDeliveryOptions {
  openDb?: () => Promise<Database.Database | undefined>;
  runIdFor?: (name: string, args: Record<string, unknown>) => string | undefined;
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
 * Build the delivery hook dispatch calls on its way out.
 *
 * Never throws and never replaces the result: a receipt is a decoration on an answer that was
 * already correct, so every failure mode degrades to "not this call, then" — which is exactly what
 * leaving the trigger un-audited means, since the anti-join will offer it again next time.
 */
export function createReceiptDelivery(options: ReceiptDeliveryOptions = {}): ReceiptDelivery {
  const openDb = options.openDb ?? defaultDb;
  const runIdFor = options.runIdFor ?? runIdFromArgs;
  const caller = options.caller ?? (() => currentClientProfile().client);
  return async (name, args, result) => {
    try {
      const runId = runIdFor(name, args);
      if (!runId) return result;
      const db = await openDb();
      if (!db) return result;
      const run = getRun(db, runId);
      if (!run) return result;
      const who = caller();
      const pending = pendingReleaseReceipt(db, run, who);
      if (!pending) return result;
      const merged = withReleaseReceipt(result, pending.receipt);
      if (!merged) return result; // still owed; a later result will carry it
      consumeReleaseReceipt(db, run, who, pending);
      return merged;
    } catch (err) {
      log.warn('release receipt not delivered on this call; it stays owed', { tool: name, error: String(err) });
      return result;
    }
  };
}
