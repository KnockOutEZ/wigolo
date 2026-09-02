/**
 * The delivery queue (SD2 mini-spec §3) — law 7's "pull transports queue, and we say so" as three
 * run events and one formatter.
 *
 * WHAT THIS IS. A message a human sends to a run is not a network send; it is an entry in the run
 * log that a later tool result carries to the agent. Its whole life is three appends —
 * `message.queued` → `message.delivered` → `message.acknowledged` — and every state anyone reads is
 * folded back out of those rows. Nothing here holds mutable state: a restarted daemon rebuilds the
 * queue by reading the log, which is what makes §3.3's durability a property of the design rather
 * than a feature that could be forgotten.
 *
 * THE CLOCK IS THE LOG (A-51-3). "Delivered at step N" means the `seq` at which `message.delivered`
 * was appended — there is no parallel tool-call counter to drift out of step with the log.
 *
 * ACKNOWLEDGEMENT IS IMPLICIT (A-51-4). A pull client has no way to acknowledge except by calling
 * again, so the agent's next tool call after the delivering result IS the acknowledgement: this
 * module appends `message.acknowledged` for everything the previous result carried at the start of
 * the next call. There is no ack verb, and adding one would be this rule with extra steps.
 *
 * WHAT THIS IS NOT. It is not a transport and it is not a guarantee of attention. Mechanisms 1-3
 * of §3.2 — return-channel piggyback, blocking wait and the next-call interrupt flag — land here.
 * The out-of-band relay remains a capability-gated no-op until SD8. `via` records which mechanism
 * carried a message so all four remain distinguishable in one log.
 */
import type Database from 'better-sqlite3';
import { appendRunEventWithTail } from '../studio/run-bus.js';
import {
  eventsOfTypes,
  getRun,
  runExists,
  unansweredEvents,
  MAX_TYPED_EVENT_ROWS,
  type Actor,
  type ClientInfo,
  type Driver,
  type ProjectableEvent,
  type Run,
  type RunEvent,
  type RunEventInput,
  type RunStoreOptions,
  type TypedEventQuery,
  type UnansweredEventQuery,
} from '../studio/run-store.js';
import { createLogger } from '../logger.js';
import { currentClientProfile, hasCapability, type ClientProfile } from './capability-handshake.js';
import { notDriving } from './driver-baton.js';
import { resolveDispatchStore, type DispatchStoreOptions } from './dispatch-store.js';
import type { RunsStore } from './rest/runs-store.js';
import type { DeliveryHooks, McpToolResult } from './studio-dispatch.js';

const log = createLogger('studio');

export const MESSAGE_QUEUED = 'message.queued';
export const MESSAGE_DELIVERED = 'message.delivered';
export const MESSAGE_ACKNOWLEDGED = 'message.acknowledged';
export const DELIVERY_WAIT_REQUESTED = 'delivery.wait_requested';
export const DELIVERY_WAIT_RESOLVED = 'delivery.wait_resolved';
export const DELIVERY_INTERRUPT_CONSUMED = 'delivery.interrupt_consumed';

/** The three rows one message's life is made of, oldest state first. */
export const MESSAGE_EVENT_TYPES: readonly string[] = [MESSAGE_QUEUED, MESSAGE_DELIVERED, MESSAGE_ACKNOWLEDGED];

/** The payload field that pairs a delivery and an acknowledgement back to their queued row. */
const CORRELATION_KEY = 'messageId';

/**
 * §3.2's four mechanisms. The first three are produced here; `out_of_band` is reserved for SD8's
 * relay, whose capability-gated seam currently logs and falls through without claiming delivery.
 */
export const DELIVERY_MECHANISM_VALUES = ['piggyback', 'wait', 'interrupt', 'out_of_band'] as const;
export type DeliveryMechanism = (typeof DELIVERY_MECHANISM_VALUES)[number];

/**
 * The honesty rule's value domain (§3.1). There is no `sent`, and there is no `seen` — not as a
 * matter of wording but because neither is a thing a pull transport can observe.
 *
 * Ordered oldest state first, and exported as the values rather than only as a type: the served
 * OpenAPI document and the runtime validator both read THIS array, so a fourth state cannot appear
 * in one and be missing from the other.
 */
export const MESSAGE_STATE_VALUES = ['queued', 'delivered', 'acknowledged'] as const;
export type MessageState = (typeof MESSAGE_STATE_VALUES)[number];

/**
 * Persisted into the log AND onto disk, so it needs a bound that the REST body cap does not give.
 * The same number as a run's task, for the same reason: it is a sentence a human typed.
 */
export const MAX_MESSAGE_TEXT_CHARS = 4000;

/** What one `POST` may ask for, and the ceiling on it. Mirrors the run list's limit discipline. */
export const DEFAULT_MESSAGE_LIST_LIMIT = 50;
export const MAX_MESSAGE_LIST_LIMIT = 200;

/**
 * How many undelivered messages one result may carry. A result is a context budget, not a mailbox:
 * a human who typed two hundred lines while the agent was thinking gets the oldest of them on this
 * call and the rest on the next, which is FIFO and is what `unansweredEvents` orders for.
 */
export const MAX_MESSAGES_PER_RESULT = 20;

export interface RunMessage {
  messageId: string;
  text: string;
  /** Who sent it. The queued event's envelope actor, restated in the payload the spec pins. */
  from: Actor;
  urgent: boolean;
  queuedAt: string;
  /** The `seq` of `message.queued` — where this message entered the log. */
  queuedAtStep: number;
  state: MessageState;
  /** The `seq` of `message.delivered`. This is "step N" (A-51-3). */
  deliveredAtStep?: number;
  deliveredVia?: DeliveryMechanism;
  /** The `seq` of `message.acknowledged`. */
  acknowledgedAtStep?: number;
}

/**
 * THE formatter, and the whole of the honesty rule on the wire (§3.1). Law 7 says a pull transport
 * queues and we say so, so the string a panel renders, the string REST returns and the string that
 * rides a tool result all come from here — one function, so no surface can invent a cheerier word
 * for the same state.
 *
 * A queued message names WHEN it will reach the agent, because "queued" alone reads as a detail of
 * our plumbing rather than as the fact that nothing has happened yet.
 */
export function renderMessageState(message: Pick<RunMessage, 'state' | 'deliveredAtStep' | 'acknowledgedAtStep'>): string {
  switch (message.state) {
    case 'queued':
      return 'queued — reaches the agent at its next tool call';
    case 'delivered':
      return `delivered at step ${message.deliveredAtStep ?? 0} — not yet acknowledged`;
    case 'acknowledged':
      return `acknowledged at step ${message.acknowledgedAtStep ?? 0}`;
  }
}

/**
 * The wire shape, shared by REST and by the `human_messages` block a result carries, so an agent and
 * a panel are reading the same fields with the same names. `state` and `delivered_at_step` are named
 * by §3.1; the rest follow their spelling rather than mixing two conventions in one object.
 */
export function messageView(message: RunMessage): Record<string, unknown> {
  return {
    message_id: message.messageId,
    text: message.text,
    from: message.from,
    ...(message.urgent ? { urgent: true } : {}),
    queued_at: message.queuedAt,
    queued_at_step: message.queuedAtStep,
    state: message.state,
    ...(message.deliveredAtStep !== undefined ? { delivered_at_step: message.deliveredAtStep } : {}),
    ...(message.deliveredVia !== undefined ? { delivered_via: message.deliveredVia } : {}),
    ...(message.acknowledgedAtStep !== undefined ? { acknowledged_at_step: message.acknowledgedAtStep } : {}),
    state_line: renderMessageState(message),
  };
}

export type MessageRefusalReason = 'run_not_found' | 'invalid_message';

export interface MessageRefused {
  ok: false;
  error_reason: MessageRefusalReason;
  error: string;
  hint: string;
}

export interface MessageQueued {
  ok: true;
  message: RunMessage;
  /** The `message.queued` row this call appended. Absent on a replay — see `replayed`. */
  event?: RunEvent;
  /**
   * Set when the `messageId` was already in the log and NOTHING was appended: the caller is a retry
   * and this is the message it queued the first time, at whatever state it has since reached. The
   * flag exists so a surface can say "already queued" rather than reporting a second send.
   */
  replayed?: true;
}

export type QueueMessageResult = MessageQueued | MessageRefused;

export interface QueueMessageInput {
  text: string;
  /** Defaults to the human actor: REST's `POST /v1/runs/:id/messages` is a person typing. */
  from?: Actor;
  urgent?: boolean;
  /**
   * An idempotency key. Given one that a `message.queued` row already carries, `queueMessage`
   * appends nothing and returns that message with `replayed: true` — which is what makes a retried
   * POST safe. Omitted, one is minted, and every call is a new message.
   */
  messageId?: string;
}

/** `hm_` for human message — the same shape as the baton's request ids, and as sortable. */
export function mintMessageId(): string {
  return `hm_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

const HUMAN: Actor = { kind: 'human' };

function refuse(reason: MessageRefusalReason, error: string, hint: string): MessageRefused {
  return { ok: false, error_reason: reason, error, hint };
}

/**
 * Accept a message into the run log. This is the ONLY way a message enters the queue, and it does
 * not deliver anything: what a sender gets back is a `queued` message whose state line says so.
 *
 * `opts` is threaded to the append for the reason the baton's gestures thread theirs: the studio DB
 * broker writes this row in a plain-Node child whose in-process bus has no subscribers, so without
 * `onEvent` the committed `message.queued` envelope never reaches the host's live tail and a panel
 * shows nothing until it re-reads. Omitted, the local bus is fed exactly as before.
 */
export function queueMessage(
  db: Database.Database,
  runId: string,
  input: QueueMessageInput,
  opts: RunStoreOptions = {},
): QueueMessageResult {
  const text = typeof input.text === 'string' ? input.text : '';
  if (text.trim() === '') return refuse('invalid_message', 'message text is required', 'Send a non-empty "text".');
  if (text.length > MAX_MESSAGE_TEXT_CHARS) {
    return refuse(
      'invalid_message',
      `message text exceeds ${MAX_MESSAGE_TEXT_CHARS} characters`,
      `Send at most ${MAX_MESSAGE_TEXT_CHARS} characters, or split the message.`,
    );
  }
  if (!runExists(db, runId)) {
    return refuse('run_not_found', `no run ${runId}`, 'List runs with GET /v1/runs. Run ids are case-insensitive.');
  }

  const from = input.from ?? HUMAN;
  const requestedId = input.messageId?.trim();
  // Idempotency BEFORE the append, and it is not a nicety: a POST that times out on the wire and is
  // retried would otherwise put a second copy of one human sentence in front of the agent, and the
  // sentences a human sends mid-run are the ones where twice is worse than never ("cancel that").
  // The key is the caller's, so this is the caller's own retry it collapses and nobody else's.
  if (requestedId) {
    const already = getMessage(db, runId, requestedId);
    if (already) return { ok: true, replayed: true, message: already };
  }
  const messageId = requestedId || mintMessageId();
  const urgent = input.urgent === true;
  const event = appendRunEventWithTail(db, runId, {
    actor: from,
    type: MESSAGE_QUEUED,
    // `from` restates the envelope actor rather than replacing it: the envelope is where an actor
    // lives for every event type, and §3.1 pins the payload. Both are written from one value here,
    // so there is no second source that could disagree with the first.
    payload: { messageId, text, from, ...(urgent ? { urgent: true } : {}) },
  }, opts);
  return {
    ok: true,
    event,
    message: {
      messageId,
      text,
      from,
      urgent,
      queuedAt: event.ts,
      queuedAtStep: event.seq,
      state: 'queued',
    },
  };
}

/**
 * The undelivered set, oldest first — `message.queued` rows no `message.delivered` has answered.
 * Bounded by `limit`, and FIFO within it.
 */
export function undeliveredMessages(db: Database.Database, runId: string, limit = MAX_MESSAGES_PER_RESULT): RunMessage[] {
  return messagesOf(unansweredEvents(db, runId, undeliveredQuery(limit)));
}

/**
 * THE anti-join, named once (#331). Both the handle path above and the port path below ask this
 * exact question; two spellings of it would be two definitions of "not yet delivered".
 */
function undeliveredQuery(limit: number): UnansweredEventQuery {
  return { askType: MESSAGE_QUEUED, answerType: MESSAGE_DELIVERED, correlationKey: CORRELATION_KEY, limit };
}

function unacknowledgedQuery(limit: number): UnansweredEventQuery {
  return { askType: MESSAGE_DELIVERED, answerType: MESSAGE_ACKNOWLEDGED, correlationKey: CORRELATION_KEY, limit };
}

/** Queued rows read back as messages, dropping any row that is not one. */
function messagesOf(rows: readonly ProjectableEvent[]): RunMessage[] {
  return rows.map(queuedMessageOf).filter((m): m is RunMessage => m !== undefined);
}

/**
 * The undelivered set over the store PORT. A binding with no anti-join delivers nothing on every
 * call, which is the same degradation an unreadable store already had: messages stay queued.
 */
async function undeliveredOn(store: RunsStore, runId: string, limit = MAX_MESSAGES_PER_RESULT): Promise<RunMessage[]> {
  return messagesOf((await store.unansweredEvents?.(runId, undeliveredQuery(limit))) ?? []);
}

async function unacknowledgedOn(store: RunsStore, runId: string, limit = MAX_MESSAGES_PER_RESULT): Promise<ProjectableEvent[]> {
  return (await store.unansweredEvents?.(runId, unacknowledgedQuery(limit))) ?? [];
}

/**
 * The delivered-but-unacknowledged set, oldest first — what the PREVIOUS result carried, which is
 * exactly what this call's existence acknowledges (A-51-4).
 */
export function unacknowledgedDeliveries(db: Database.Database, runId: string, limit = MAX_MESSAGES_PER_RESULT): ProjectableEvent[] {
  return unansweredEvents(db, runId, unacknowledgedQuery(limit));
}

export interface DeliverOptions {
  via?: DeliveryMechanism;
  /** The agent the result is being minted for. Defaults to the daemon, which is what moves it. */
  actor?: Actor;
  limit?: number;
  /** A mechanism-selected subset; urgent interrupt uses this to carry the urgent row itself. */
  messages?: readonly RunMessage[];
}

/**
 * Hand the oldest undelivered messages to whoever is about to receive a result, and record that in
 * the log. Returns them in the order they were queued, each already carrying the step it was
 * delivered at — which is the `seq` of its own `message.delivered` row, not a number this function
 * chose.
 */
export function deliverMessages(db: Database.Database, runId: string, opts: DeliverOptions = {}): RunMessage[] {
  const via = opts.via ?? 'piggyback';
  const actor = opts.actor ?? DAEMON;
  const pending = opts.messages
    ? [...opts.messages].slice(0, opts.limit ?? MAX_MESSAGES_PER_RESULT)
    : undeliveredMessages(db, runId, opts.limit ?? MAX_MESSAGES_PER_RESULT);
  const delivered: RunMessage[] = [];
  for (const message of pending) {
    const event = appendRunEventWithTail(db, runId, deliveryEvent(message, via, actor));
    delivered.push(deliveredMessage(message, event, via));
  }
  return delivered;
}

/**
 * WHAT ONE DELIVERY IS — the row it appends and the message it yields, defined once (#331).
 *
 * The handle path and the port path differ only in how they get the row written; what a delivery
 * MEANS is here, so the two cannot drift into disagreeing about it.
 *
 * No `step` in the payload: the row's own `seq` IS step N (A-51-3, A-54-1), and a copy of it in the
 * payload would be a second source of truth for one number — one that can only ever be written by
 * predicting a `seq` the append has not assigned yet.
 */
function deliveryEvent(message: RunMessage, via: DeliveryMechanism, actor: Actor): RunEventInput {
  return { actor, type: MESSAGE_DELIVERED, payload: { messageId: message.messageId, via } };
}

function deliveredMessage(message: RunMessage, event: RunEvent, via: DeliveryMechanism): RunMessage {
  return { ...message, state: 'delivered', deliveredAtStep: event.seq, deliveredVia: via };
}

/**
 * Deliver over the store PORT. A binding with no append delivers nothing and marks nothing, which
 * keeps the queue's one invariant: a message is never recorded as delivered onto a result it did
 * not ride.
 */
async function deliverOn(store: RunsStore, runId: string, opts: DeliverOptions = {}): Promise<RunMessage[]> {
  if (!store.appendEvent) return [];
  const via = opts.via ?? 'piggyback';
  const actor = opts.actor ?? DAEMON;
  const pending = opts.messages
    ? [...opts.messages].slice(0, opts.limit ?? MAX_MESSAGES_PER_RESULT)
    : await undeliveredOn(store, runId, opts.limit ?? MAX_MESSAGES_PER_RESULT);
  const delivered: RunMessage[] = [];
  for (const message of pending) {
    const event = await store.appendEvent(runId, deliveryEvent(message, via, actor));
    delivered.push(deliveredMessage(message, event, via));
  }
  return delivered;
}

/**
 * Append the implicit acknowledgement for everything the previous result carried (A-51-4). Called
 * at the START of a tool call, because the call itself is the evidence: the harness consumed the
 * result that carried them and kept going.
 */
export function acknowledgeDelivered(db: Database.Database, runId: string, opts: { actor?: Actor; limit?: number } = {}): string[] {
  const actor = opts.actor ?? DAEMON;
  const acknowledged: string[] = [];
  for (const delivery of unacknowledgedDeliveries(db, runId, opts.limit ?? MAX_TYPED_EVENT_ROWS)) {
    const ack = acknowledgementEvent(delivery, actor);
    if (!ack) continue;
    appendRunEventWithTail(db, runId, ack.input);
    acknowledged.push(ack.messageId);
  }
  return acknowledged;
}

/**
 * WHAT ONE ACKNOWLEDGEMENT IS, defined once for both paths (#331).
 *
 * `step` here names the DELIVERY this acknowledges, which is information the row does not otherwise
 * carry — unlike the delivered row's own step, which is its `seq`.
 */
function acknowledgementEvent(delivery: ProjectableEvent, actor: Actor): { input: RunEventInput; messageId: string } | undefined {
  const messageId = str(delivery.payload.messageId);
  if (!messageId) return undefined;
  return { messageId, input: { actor, type: MESSAGE_ACKNOWLEDGED, payload: { messageId, step: delivery.seq } } };
}

/** Acknowledge over the store PORT. No append means nothing is acknowledged and nothing is lost. */
async function acknowledgeOn(store: RunsStore, runId: string, opts: { actor?: Actor; limit?: number } = {}): Promise<string[]> {
  if (!store.appendEvent) return [];
  const actor = opts.actor ?? DAEMON;
  const acknowledged: string[] = [];
  for (const delivery of await unacknowledgedOn(store, runId, opts.limit ?? MAX_TYPED_EVENT_ROWS)) {
    const ack = acknowledgementEvent(delivery, actor);
    if (!ack) continue;
    await store.appendEvent(runId, ack.input);
    acknowledged.push(ack.messageId);
  }
  return acknowledged;
}

const DAEMON: Actor = { kind: 'daemon' };

/**
 * The run's messages, newest first, each folded to its current state.
 *
 * The window is taken over the three types NEWEST first and the states are folded inside it, which
 * is correct rather than approximate: a delivery and an acknowledgement are always appended AFTER
 * the queued row they answer, so a message whose queued row is in the window has its answers in the
 * window too. A message whose queued row fell outside it is simply older than the page asked for.
 */
export function listMessages(db: Database.Database, runId: string, limit = DEFAULT_MESSAGE_LIST_LIMIT): RunMessage[] {
  const n = Math.max(1, Math.min(limit, MAX_MESSAGE_LIST_LIMIT));
  return [...foldMessages(db, runId).values()].sort((a, b) => b.queuedAtStep - a.queuedAtStep).slice(0, n);
}

/**
 * One message read back at its current state, or nothing.
 *
 * Bounded by the same window `listMessages` reads, which is what makes this a lookup rather than a
 * scan — and is also its one limit, stated rather than hidden: an id whose queued row has fallen
 * out of the newest `MAX_TYPED_EVENT_ROWS` message rows reads as absent. The caller is a POST
 * carrying an idempotency key, and a retry arrives in seconds; an id older than that window
 * re-queues, which is exactly the outcome the caller would have had with no key at all.
 */
export function getMessage(db: Database.Database, runId: string, messageId: string): RunMessage | undefined {
  return foldMessages(db, runId).get(messageId);
}

/**
 * The fold itself — every message row in the window, replayed in the order it happened, keyed by
 * message id. Shared by the listing and the single read so there is ONE definition of "the state a
 * message is in", which is the whole of law 1 at this scale: two folds would be two answers.
 */
function foldMessages(db: Database.Database, runId: string): Map<string, RunMessage> {
  return foldRows(eventsOfTypes(db, runId, MESSAGE_WINDOW));
}

/** The window both paths fold, named once so neither can read a different one. */
const MESSAGE_WINDOW: TypedEventQuery = { types: MESSAGE_EVENT_TYPES, limit: MAX_TYPED_EVENT_ROWS, newestFirst: true };

/** The fold over the store PORT. No typed read means no message is known, so none is folded. */
async function foldMessagesOn(store: RunsStore, runId: string): Promise<Map<string, RunMessage>> {
  return foldRows((await store.typedEvents?.(runId, MESSAGE_WINDOW)) ?? []);
}

async function getMessageOn(store: RunsStore, runId: string, messageId: string): Promise<RunMessage | undefined> {
  return (await foldMessagesOn(store, runId)).get(messageId);
}

function foldRows(rows: readonly ProjectableEvent[]): Map<string, RunMessage> {
  const byId = new Map<string, RunMessage>();
  // Oldest first inside the window, so a fold reads the states in the order they happened.
  for (const row of [...rows].sort((a, b) => a.seq - b.seq)) {
    const messageId = str(row.payload.messageId);
    if (!messageId) continue;
    if (row.type === MESSAGE_QUEUED) {
      const message = queuedMessageOf(row);
      if (message) byId.set(messageId, message);
      continue;
    }
    const held = byId.get(messageId);
    if (!held) continue;
    if (row.type === MESSAGE_DELIVERED) {
      byId.set(messageId, { ...held, state: 'delivered', deliveredAtStep: row.seq, deliveredVia: mechanismOf(row.payload.via) });
    } else {
      byId.set(messageId, { ...held, state: 'acknowledged', acknowledgedAtStep: row.seq });
    }
  }
  return byId;
}

const MECHANISMS = new Set<string>(DELIVERY_MECHANISM_VALUES);

function mechanismOf(raw: unknown): DeliveryMechanism | undefined {
  return typeof raw === 'string' && MECHANISMS.has(raw) ? (raw as DeliveryMechanism) : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * A queued row read back as a message. Returns nothing for a row missing an id or a text, because a
 * hand-written row the store's envelope mechanics happily accepted is not a message — and a message
 * with no text would render an empty line to the agent as if a human had sent one.
 */
function queuedMessageOf(row: ProjectableEvent): RunMessage | undefined {
  const messageId = str(row.payload.messageId);
  const text = str(row.payload.text);
  if (!messageId || !text) return undefined;
  return {
    messageId,
    text,
    from: actorOf(row.payload.from),
    urgent: row.payload.urgent === true,
    queuedAt: row.ts,
    queuedAtStep: row.seq,
    state: 'queued',
  };
}

const ACTOR_KINDS = new Set<string>(['agent', 'human', 'daemon', 'system']);
const DRIVER_KINDS = new Set<string>(['cli', 'sdk', 'api', 'studio', 'human']);

function actorOf(raw: unknown): Actor {
  if (raw === null || typeof raw !== 'object') return HUMAN;
  const value = raw as Record<string, unknown>;
  const kind = typeof value.kind === 'string' && ACTOR_KINDS.has(value.kind) ? (value.kind as Actor['kind']) : 'human';
  const driver = typeof value.driver === 'string' && DRIVER_KINDS.has(value.driver) ? (value.driver as Actor['driver']) : undefined;
  const client = clientOf(value.client);
  return { kind, ...(driver ? { driver } : {}), ...(client ? { client } : {}) };
}

function clientOf(raw: unknown): ClientInfo | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  const name = str(value.name);
  const version = str(value.version);
  return name && version ? { name, version } : undefined;
}

// ---------------------------------------------------------------------------
// Mechanism 1 — return-channel piggyback (§3.2), at the dispatch seam.
// ---------------------------------------------------------------------------

export interface DeliveryHooksOptions extends DispatchStoreOptions {
  /** Which run this call is about. The same seam `#217` moves onto the connection's attachment. */
  runIdFor?: (name: string, args: Record<string, unknown>) => string | undefined;
  /** Who is calling. Defaults to the MCP handshake badge, scoped over the dispatch. */
  caller?: () => ClientInfo | undefined;
  /** The connection capability profile. Names never select delivery behaviour; capabilities do. */
  profile?: () => ClientProfile;
  /**
   * SD8 seam. Invoked only for a push-capable connection with queued messages. It deliberately
   * returns no delivery verdict today: after the debug-logged no-op, mechanisms 1-3 still run.
   */
  outOfBandProbe?: (runId: string, messages: readonly RunMessage[]) => void | Promise<void>;
}

function runIdFromArgs(_name: string, args: Record<string, unknown>): string | undefined {
  const raw = args.run_id ?? args.runId;
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined;
}

/**
 * Resolve the run this call is about, and refuse to touch its queue unless the caller is the one
 * driving it. Absence allows, exactly as the baton does: an unnamed run, an unreadable store or a
 * badgeless client is not evidence that someone ELSE holds the wheel, and delivering to the only
 * client there is is the whole of the single-client case.
 */
async function drivingRun(store: RunsStore, runId: string, caller: ClientInfo | undefined): Promise<Run | undefined> {
  const run = await store.get(runId);
  if (!run) return undefined;
  return notDriving(run, caller) ? undefined : run;
}

/**
 * Fold the delivered messages into the result's JSON block.
 *
 * `content[0]` is the pretty-printed JSON every studio consumer parses, so the messages go INTO that
 * object rather than beside it — #56's footer is the second block, and this is deliberately not it.
 * Returns `undefined` when the block is not a JSON object, which is the signal to append nothing:
 * marking a message delivered onto a result it could not ride would lose it silently.
 */
export function withHumanMessages(result: McpToolResult, messages: readonly RunMessage[]): McpToolResult | undefined {
  const block = result.content[0];
  if (!block || block.type !== 'text') return undefined;
  let data: unknown;
  try {
    data = JSON.parse(block.text);
  } catch {
    return undefined;
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const merged = { ...(data as Record<string, unknown>), human_messages: messages.map(messageView) };
  return { ...result, content: [{ type: 'text', text: JSON.stringify(merged, null, 2) }, ...result.content.slice(1)] };
}

/**
 * Build the §3.2 mechanism-1 hooks: acknowledge what the last result carried, then hand this
 * result whatever a human has queued since.
 *
 * Never throws. A queue that cannot be read is a queue that delivers nothing on this call and
 * everything on the next one, which is the honest degradation for a mechanism whose entire contract
 * is "at the agent's next tool call".
 */
export function createDeliveryHooks(options: DeliveryHooksOptions = {}): DeliveryHooks {
  const openStore = resolveDispatchStore(options);
  const runIdFor = options.runIdFor ?? runIdFromArgs;
  const profile = options.profile ?? currentClientProfile;
  const caller = options.caller ?? (() => profile().client);
  const activeWaits = new Map<string, () => void>();
  const outOfBandProbe = options.outOfBandProbe ?? ((runId: string, messages: readonly RunMessage[]) => {
    log.debug('out-of-band delivery is eligible but not implemented; falling through', {
      run: runId,
      messages: messages.length,
    });
  });

  async function resolve(name: string, args: Record<string, unknown>): Promise<{ store: RunsStore; run: Run } | undefined> {
    const runId = runIdFor(name, args);
    if (!runId) return undefined;
    const store = await openStore();
    if (!store) return undefined;
    const run = await drivingRun(store, runId, caller());
    return run ? { store, run } : undefined;
  }

  return {
    dispose() {
      for (const abort of [...activeWaits.values()]) abort();
    },
    async interrupt(name, args) {
      try {
        const runId = runIdFor(name, args);
        if (!runId) return undefined;
        const store = await openStore();
        if (!store) return undefined;
        let run = await store.get(runId);
        if (!run) return undefined;
        const who = caller();

        const queued = await undeliveredOn(store, run.id);
        if (queued.length > 0 && !notDriving(run, who) && hasCapability(profile(), 'push')) {
          await outOfBandProbe(run.id, queued);
          // Stub only until SD8: never append a delivery row here. Falling through is the contract.
        }

        let pending = await pendingInterrupt(store, run, who);
        const mayAcknowledge = !notDriving(run, who)
          || (pending !== undefined && driverMatchesCaller(pending.target, who))
          || await priorInterruptWasFor(store, run, who);
        if (mayAcknowledge) {
          await acknowledgeOn(store, run.id, { actor: callerActor(who, run) });
          // The acknowledgement append advanced the head used to bound the durable interrupt scan.
          run = (await store.get(run.id)) ?? run;
          pending = await pendingInterrupt(store, run, who);
        }
        if (!pending) return undefined;
        return await consumeInterrupt(store, run, who, pending);
      } catch (err) {
        log.warn('delivery interrupt check failed; continuing normal dispatch', { error: String(err) });
        return undefined;
      }
    },
    async acknowledge(name, args) {
      try {
        const resolved = await resolve(name, args);
        if (!resolved) return;
        await acknowledgeOn(resolved.store, resolved.run.id, { actor: actorForRun(resolved.run) });
      } catch (err) {
        log.warn('delivery queue could not acknowledge; leaving the messages delivered', { error: String(err) });
      }
    },
    async deliver(name, args, result, signal) {
      try {
        if (isWaitForHumanResult(name, args, result)) {
          return await resolveHumanWait(openStore, runIdFor, caller, activeWaits, name, args, result, signal);
        }
        const resolved = await resolve(name, args);
        if (!resolved) return result;
        // The merge is attempted BEFORE anything is appended: a result whose block cannot carry the
        // messages leaves them queued for the next one rather than marking them delivered into
        // nowhere. So the pending set is read, the merge is rehearsed, and only then are the
        // `message.delivered` rows written for exactly the messages that rode.
        const pending = await undeliveredOn(resolved.store, resolved.run.id);
        if (pending.length === 0) return result;
        if (!withHumanMessages(result, pending)) {
          log.debug('delivery queue: result block is not a JSON object; messages stay queued', { run: resolved.run.id });
          return result;
        }
        const delivered = await deliverOn(resolved.store, resolved.run.id, {
          via: 'piggyback',
          actor: actorForRun(resolved.run),
        });
        return withHumanMessages(result, delivered) ?? result;
      } catch (err) {
        if (isWaitForHumanResult(name, args, result)) {
          log.warn('human wait failed; returning a typed refusal', { error: String(err) });
          return waitError('wait_failed', 'The human wait could not continue; call wait_for_human again.');
        }
        log.warn('delivery queue could not deliver; messages stay queued', { error: String(err) });
        return result;
      }
    },
  };
}

interface PendingInterrupt {
  event: RunEvent;
  target: Driver;
  reason: string;
  detail?: string;
  messageId?: string;
}

function driverFrom(raw: unknown): Driver | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (typeof value.kind !== 'string' || !DRIVER_KINDS.has(value.kind)) return undefined;
  const client = clientOf(value.client);
  return { kind: value.kind as Driver['kind'], ...(client ? { client } : {}) };
}

function driverMatchesCaller(driver: Driver, caller: ClientInfo | undefined): boolean {
  if (driver.kind === 'human') return false;
  if (!driver.client || !caller) return true;
  return driver.client.name === caller.name && driver.client.version === caller.version;
}

function callerActor(caller: ClientInfo | undefined, run: Run): Actor {
  return {
    kind: run.driver.kind === 'human' ? 'agent' : actorForRun(run).kind,
    ...(run.driver.kind !== 'human' ? { driver: run.driver.kind } : {}),
    ...(caller ? { client: caller } : {}),
  };
}

async function pendingInterrupt(store: RunsStore, run: Run, caller: ClientInfo | undefined): Promise<PendingInterrupt | undefined> {
  // A binding with no trigger read is owed no interrupt it can prove, so mechanism 3 is simply off
  // there: the call dispatches normally rather than being handed a receipt nobody recorded.
  const event = await store.interruptTrigger?.(run.id, caller);
  if (!event) return undefined;
  const pending = classifyTrigger(event, run, caller);
  if (!pending?.messageId) return pending;
  // A wait or an earlier result may already have carried this urgent message. In that case the
  // interrupt mechanism lost the race, exactly as the selection rule says it should.
  const message = await getMessageOn(store, run.id, pending.messageId);
  return message?.state === 'queued' ? pending : undefined;
}

/** Which interruption a trigger row IS — pure, so the state check above is the only read left. */
function classifyTrigger(event: RunEvent, run: Run, caller: ClientInfo | undefined): PendingInterrupt | undefined {
  if (event.type === 'driver.changed') {
    if (event.payload.cause !== 'takeover') return undefined;
    const target = driverFrom(event.payload.from);
    if (!target || !driverMatchesCaller(target, caller)) return undefined;
    const detail = str(event.payload.reason);
    return { event, target, reason: 'human took control', ...(detail ? { detail } : {}) };
  }
  if (event.type === MESSAGE_QUEUED) {
    if (event.actor.kind !== 'human' || event.payload.urgent !== true || notDriving(run, caller)) return undefined;
    const messageId = str(event.payload.messageId);
    if (!messageId) return undefined;
    return { event, target: run.driver, reason: 'urgent human message', detail: str(event.payload.text), messageId };
  }
  if (event.actor.kind !== 'human' || notDriving(run, caller)) return undefined;
  if (event.type === 'run.paused') {
    return { event, target: run.driver, reason: 'human paused the run', detail: str(event.payload.detail) ?? str(event.payload.reason) };
  }
  return { event, target: run.driver, reason: 'human cancelled the run', detail: str(event.payload.reason) };
}

interface InterruptEventRow { seq: number; ts: string; actor: string; type: string; payload: string }

/**
 * Read ONLY eligible, still-unconsumed trigger rows. The anti-join is what makes an interrupt a
 * durable flag rather than "something among the last N events": unrelated run traffic can never
 * push a pending human interruption out of the next-call window.
 *
 * Exported so `sqliteRunsStore` can bind it as the store port's `interruptTrigger` (#331). It stays
 * here rather than moving to the binding because the eligibility rules ARE the queue's grammar:
 * which rows count as an interruption is a fact about mechanism 3, not about SQLite.
 */
export function unconsumedInterruptEvents(db: Database.Database, runId: string, caller?: ClientInfo): RunEvent[] {
  const rows = db.prepare(`
    SELECT candidate.seq, candidate.ts, candidate.actor, candidate.type, candidate.payload
      FROM studio_run_events candidate
     WHERE candidate.run_id = ?
       AND (
         (candidate.type = 'driver.changed' AND json_extract(candidate.payload, '$.cause') = 'takeover'
           AND (? IS NULL
             OR json_extract(candidate.payload, '$.from.client.name') IS NULL
             OR (json_extract(candidate.payload, '$.from.client.name') = ?
               AND json_extract(candidate.payload, '$.from.client.version') = ?)))
         OR (candidate.type = 'message.queued' AND json_extract(candidate.payload, '$.urgent') = 1
             AND json_extract(candidate.actor, '$.kind') = 'human')
         OR (candidate.type IN ('run.paused', 'run.cancelled')
             AND json_extract(candidate.actor, '$.kind') = 'human')
       )
       AND NOT EXISTS (
         SELECT 1 FROM studio_run_events consumed
          WHERE consumed.run_id = candidate.run_id
            AND consumed.type = ?
            AND json_extract(consumed.payload, '$.triggerSeq') = candidate.seq
       )
     ORDER BY candidate.seq ASC
     LIMIT 1
  `).all(
    runId,
    caller?.name ?? null,
    caller?.name ?? null,
    caller?.version ?? null,
    DELIVERY_INTERRUPT_CONSUMED,
  ) as InterruptEventRow[];
  return rows.map((row) => ({
    seq: row.seq,
    ts: row.ts,
    actor: actorOf(JSON.parse(row.actor) as unknown),
    type: row.type,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
  }));
}

async function priorInterruptWasFor(store: RunsStore, run: Run, caller: ClientInfo | undefined): Promise<boolean> {
  if (!(await unacknowledgedOn(store, run.id)).some((row) => row.payload.via === 'interrupt')) return false;
  const rows = (await store.typedEvents?.(run.id, {
    types: [DELIVERY_INTERRUPT_CONSUMED],
    limit: MAX_TYPED_EVENT_ROWS,
    newestFirst: true,
  })) ?? [];
  const target = driverFrom(rows[0]?.payload.target);
  return target !== undefined && driverMatchesCaller(target, caller);
}

function interruptResult(pending: PendingInterrupt): McpToolResult {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        interrupted: true,
        reason: pending.reason,
        ...(pending.detail ? { detail: pending.detail } : {}),
      }, null, 2),
    }],
    isError: false,
  };
}

async function consumeInterrupt(
  store: RunsStore,
  run: Run,
  caller: ClientInfo | undefined,
  pending: PendingInterrupt,
): Promise<McpToolResult | undefined> {
  const base = interruptResult(pending);
  const waiting = pending.messageId
    ? [await getMessageOn(store, run.id, pending.messageId)].filter((message): message is RunMessage => message?.state === 'queued')
    : await undeliveredOn(store, run.id);
  // Rehearse the merge before recording delivery. A fixed JSON object is expected here, but
  // preserving the queue's no-delivery-into-nowhere invariant costs almost nothing.
  if (waiting.length > 0 && !withHumanMessages(base, waiting)) return undefined;
  const delivered = waiting.length > 0
    ? await deliverOn(store, run.id, { via: 'interrupt', actor: callerActor(caller, run), messages: waiting })
    : [];
  await store.appendEvent?.(run.id, {
    actor: callerActor(caller, run),
    type: DELIVERY_INTERRUPT_CONSUMED,
    payload: { triggerSeq: pending.event.seq, target: pending.target },
  });
  return delivered.length > 0 ? (withHumanMessages(base, delivered) ?? base) : base;
}

function isWaitForHumanResult(
  name: string,
  args: Record<string, unknown>,
  result: McpToolResult,
): boolean {
  if (name !== 'studio_act' || args.action !== 'wait_for_human' || result.isError) return false;
  const block = result.content[0];
  if (!block || block.type !== 'text') return false;
  try {
    const data = JSON.parse(block.text) as unknown;
    return data !== null && typeof data === 'object' && !Array.isArray(data)
      && (data as Record<string, unknown>).action === 'wait_for_human';
  } catch {
    return false;
  }
}

function waitError(error_reason: string, hint: string): McpToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error_reason, hint }, null, 2) }],
    isError: true,
  };
}

function mintWaitId(): string {
  return `wait_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

async function resolveHumanWait(
  openStore: () => Promise<RunsStore | undefined>,
  runIdFor: (name: string, args: Record<string, unknown>) => string | undefined,
  caller: () => ClientInfo | undefined,
  activeWaits: Map<string, () => void>,
  name: string,
  args: Record<string, unknown>,
  result: McpToolResult,
  signal?: AbortSignal,
): Promise<McpToolResult> {
  const runId = runIdFor(name, args);
  if (!runId) return waitError('run_required', 'wait_for_human requires the run_id of the run to park.');
  const reason = typeof args.reason === 'string' ? args.reason.trim() : '';
  if (!reason) return waitError('invalid_wait', 'wait_for_human requires a non-empty reason.');
  if (reason.length > MAX_MESSAGE_TEXT_CHARS) {
    return waitError('invalid_wait', `wait_for_human reason is capped at ${MAX_MESSAGE_TEXT_CHARS} characters.`);
  }
  const store = await openStore();
  if (!store) return waitError('run_store_unavailable', 'The run store is unavailable; the wait was not started.');
  // Mechanism 2 is the one mechanism that cannot degrade quietly: parking a run on a store that can
  // neither record the wait nor tell us when a message lands would hang the agent until it gives
  // up, which is the silence law 7 and §7 row 11 both forbid. So it is refused BEFORE anything is
  // appended — a typed refusal the agent can act on, and a log that never claims a wait nobody kept.
  const { appendEvent, subscribeEvents } = store;
  if (!appendEvent || !subscribeEvents) {
    return waitError('wait_unsupported', 'This host cannot park a run on the human queue; ask your question in the result and return.');
  }
  const run = await drivingRun(store, runId, caller());
  if (!run) return waitError('run_not_found', `No driven run ${runId} is available for this wait.`);
  if (activeWaits.has(run.id)) {
    return waitError('wait_already_pending', 'This run is already waiting for a human answer.');
  }
  // A request row with no live in-process waiter can only be the tail of a restarted/replaced
  // coordinator. Close it before starting the replacement so the durable log never claims two
  // simultaneous waits for one run.
  const orphaned = (await store.unansweredEvents?.(run.id, {
    askType: DELIVERY_WAIT_REQUESTED,
    answerType: DELIVERY_WAIT_RESOLVED,
    correlationKey: 'waitId',
    limit: 1,
  }))?.[0];
  if (orphaned) {
    await appendEvent(run.id, {
      actor: actorForRun(run),
      type: DELIVERY_WAIT_RESOLVED,
      payload: { waitId: orphaned.payload.waitId, outcome: 'abandoned' },
    });
  }
  activeWaits.set(run.id, () => {});
  const waitId = mintWaitId();
  try {
    await appendEvent(run.id, {
      actor: actorForRun(run),
      type: DELIVERY_WAIT_REQUESTED,
      payload: { waitId, reason },
    });

    const outcome = await new Promise<
      { kind: 'answer'; messageId: string } | { kind: 'interrupt'; pending: PendingInterrupt } | { kind: 'aborted' }
    >((resolve, reject) => {
      let settled = false;
      let unsubscribe = () => {};
      const onAbort = (): void => finish({ kind: 'aborted' });
      const finish = (value: { kind: 'answer'; messageId: string } | { kind: 'interrupt'; pending: PendingInterrupt } | { kind: 'aborted' }): void => {
        if (settled) return;
        settled = true;
        unsubscribe();
        signal?.removeEventListener('abort', onAbort);
        resolve(value);
      };
      // Reads are async now, so a check can still be in flight when the next event arrives. `settled`
      // already makes a duplicate observation a no-op; the `catch` mirrors it so a rejected read
      // rejects the wait once instead of escaping as an unhandled rejection.
      const check = (): void => {
        void (async () => {
          try {
            const first = (await undeliveredOn(store, run.id, MAX_MESSAGES_PER_RESULT))
              .find((message) => message.from.kind === 'human');
            if (first) finish({ kind: 'answer', messageId: first.messageId });
          } catch (err) {
            if (settled) return;
            settled = true;
            unsubscribe();
            reject(err);
          }
        })();
      };
      // Subscribe first, then re-read the durable queue. An append between those operations is seen by
      // the listener and by the read; `settled` turns the duplicate observation into a no-op.
      unsubscribe = subscribeEvents(run.id, (event) => {
        if (event.type === MESSAGE_QUEUED && event.actor.kind === 'human') {
          check();
          return;
        }
        if (event.type !== 'driver.changed' && event.type !== 'run.paused' && event.type !== 'run.cancelled') return;
        void (async () => {
          try {
            const latest = await store.get(run.id);
            if (!latest) return;
            const pending = await pendingInterrupt(store, latest, caller());
            if (pending) finish({ kind: 'interrupt', pending });
          } catch (err) {
            log.warn('wait could not classify an interrupt trigger; the wait continues', { run: run.id, error: String(err) });
          }
        })();
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      activeWaits.set(run.id, onAbort);
      if (signal?.aborted) onAbort();
      check();
    });

    if (outcome.kind === 'aborted') {
      await appendEvent(run.id, {
        actor: actorForRun(run),
        type: DELIVERY_WAIT_RESOLVED,
        payload: { waitId, outcome: 'aborted' },
      });
      return waitError('wait_aborted', 'The client disconnected or cancelled the human wait; no message was delivered.');
    }

    if (outcome.kind === 'interrupt') {
      const latest = (await store.get(run.id)) ?? run;
      const interrupted = await consumeInterrupt(store, latest, caller(), outcome.pending);
      if (!interrupted) return waitError('wait_interrupted', 'The run was interrupted while waiting; call again to inspect it.');
      await appendEvent(run.id, {
        actor: actorForRun(run),
        type: DELIVERY_WAIT_RESOLVED,
        payload: { waitId, triggerSeq: outcome.pending.event.seq, outcome: 'interrupted' },
      });
      return interrupted;
    }

    const delivered = await deliverOn(store, run.id, { via: 'wait', actor: actorForRun(run) });
    const answer = delivered.find((message) => message.messageId === outcome.messageId);
    if (!answer) return waitError('wait_resolution_lost', 'The answer was claimed by another result; call wait_for_human again.');
    await appendEvent(run.id, {
      actor: actorForRun(run),
      type: DELIVERY_WAIT_RESOLVED,
      payload: { waitId, messageId: answer.messageId },
    });
    if (answer.urgent) {
      await appendEvent(run.id, {
        actor: actorForRun(run),
        type: DELIVERY_INTERRUPT_CONSUMED,
        payload: { triggerSeq: answer.queuedAtStep, target: run.driver },
      });
    }
    const carried = withHumanMessages(result, delivered);
    if (!carried) return waitError('wait_result_invalid', 'The host wait result could not carry the human answer.');
    const block = carried.content[0];
    if (!block || block.type !== 'text') return carried;
    const body = JSON.parse(block.text) as Record<string, unknown>;
    body.answer = messageView(answer);
    return { ...carried, content: [{ type: 'text', text: JSON.stringify(body, null, 2) }, ...carried.content.slice(1)] };
  } finally {
    activeWaits.delete(run.id);
  }
}

/** The run's driver, wearing the actor shape — the same mapping the baton's `actorFor` makes. */
function actorForRun(run: Run): Actor {
  return {
    kind: run.driver.kind === 'human' ? 'human' : 'agent',
    driver: run.driver.kind,
    ...(run.driver.client ? { client: run.driver.client } : {}),
  };
}
