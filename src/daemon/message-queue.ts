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
 * WHAT THIS IS NOT. It is not a transport and it is not a guarantee of attention. Only mechanism 1
 * of §3.2 — return-channel piggyback — lands here; the blocking wait, the interrupt flag and the
 * out-of-band relay are `wigolo-studio-run#218` and SD8. `via` records which mechanism carried a
 * message so the four stay distinguishable in one log.
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
  type ProjectableEvent,
  type Run,
  type RunEvent,
} from '../studio/run-store.js';
import { createLogger } from '../logger.js';
import { currentClientProfile } from './capability-handshake.js';
import { notDriving } from './driver-baton.js';
import type { DeliveryHooks, McpToolResult } from './studio-dispatch.js';

const log = createLogger('studio');

export const MESSAGE_QUEUED = 'message.queued';
export const MESSAGE_DELIVERED = 'message.delivered';
export const MESSAGE_ACKNOWLEDGED = 'message.acknowledged';

/** The three rows one message's life is made of, oldest state first. */
export const MESSAGE_EVENT_TYPES: readonly string[] = [MESSAGE_QUEUED, MESSAGE_DELIVERED, MESSAGE_ACKNOWLEDGED];

/** The payload field that pairs a delivery and an acknowledgement back to their queued row. */
const CORRELATION_KEY = 'messageId';

/**
 * §3.2's four mechanisms. Only `piggyback` is produced today; the other three are named because a
 * `via` that could not spell them would have to change shape when they land, and #58's e2e asserts
 * an MCP client observing the states with the mechanism that carried them.
 */
export type DeliveryMechanism = 'piggyback' | 'wait' | 'interrupt' | 'out_of_band';

/** The honesty rule's value domain (§3.1). There is no `sent`, and there is no `seen`. */
export type MessageState = 'queued' | 'delivered' | 'acknowledged';

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
  event: RunEvent;
}

export type QueueMessageResult = MessageQueued | MessageRefused;

export interface QueueMessageInput {
  text: string;
  /** Defaults to the human actor: REST's `POST /v1/runs/:id/messages` is a person typing. */
  from?: Actor;
  urgent?: boolean;
  /** Injectable so a caller can make the append idempotent against its own retry. */
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
 */
export function queueMessage(db: Database.Database, runId: string, input: QueueMessageInput): QueueMessageResult {
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
  const messageId = input.messageId?.trim() || mintMessageId();
  const urgent = input.urgent === true;
  const event = appendRunEventWithTail(db, runId, {
    actor: from,
    type: MESSAGE_QUEUED,
    // `from` restates the envelope actor rather than replacing it: the envelope is where an actor
    // lives for every event type, and §3.1 pins the payload. Both are written from one value here,
    // so there is no second source that could disagree with the first.
    payload: { messageId, text, from, ...(urgent ? { urgent: true } : {}) },
  });
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
  return unansweredEvents(db, runId, {
    askType: MESSAGE_QUEUED,
    answerType: MESSAGE_DELIVERED,
    correlationKey: CORRELATION_KEY,
    limit,
  })
    .map(queuedMessageOf)
    .filter((m): m is RunMessage => m !== undefined);
}

/**
 * The delivered-but-unacknowledged set, oldest first — what the PREVIOUS result carried, which is
 * exactly what this call's existence acknowledges (A-51-4).
 */
export function unacknowledgedDeliveries(db: Database.Database, runId: string, limit = MAX_MESSAGES_PER_RESULT): ProjectableEvent[] {
  return unansweredEvents(db, runId, {
    askType: MESSAGE_DELIVERED,
    answerType: MESSAGE_ACKNOWLEDGED,
    correlationKey: CORRELATION_KEY,
    limit,
  });
}

export interface DeliverOptions {
  via?: DeliveryMechanism;
  /** The agent the result is being minted for. Defaults to the daemon, which is what moves it. */
  actor?: Actor;
  limit?: number;
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
  const pending = undeliveredMessages(db, runId, opts.limit ?? MAX_MESSAGES_PER_RESULT);
  const delivered: RunMessage[] = [];
  for (const message of pending) {
    // No `step` in the payload: the row's own `seq` IS step N (A-51-3, A-54-1), and a copy of it in
    // the payload would be a second source of truth for one number — one that can only ever be
    // written by predicting a `seq` the append has not assigned yet.
    const event = appendRunEventWithTail(db, runId, {
      actor,
      type: MESSAGE_DELIVERED,
      payload: { messageId: message.messageId, via },
    });
    delivered.push({ ...message, state: 'delivered', deliveredAtStep: event.seq, deliveredVia: via });
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
    const messageId = str(delivery.payload.messageId);
    if (!messageId) continue;
    // `step` here names the DELIVERY this acknowledges, which is information the row does not
    // otherwise carry — unlike the delivered row's own step, which is its `seq`.
    appendRunEventWithTail(db, runId, {
      actor,
      type: MESSAGE_ACKNOWLEDGED,
      payload: { messageId, step: delivery.seq },
    });
    acknowledged.push(messageId);
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
  const rows = eventsOfTypes(db, runId, { types: MESSAGE_EVENT_TYPES, limit: MAX_TYPED_EVENT_ROWS, newestFirst: true });
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
  return [...byId.values()].sort((a, b) => b.queuedAtStep - a.queuedAtStep).slice(0, n);
}

const MECHANISMS = new Set<string>(['piggyback', 'wait', 'interrupt', 'out_of_band']);

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

export interface DeliveryHooksOptions {
  /**
   * The run log. Resolved per call and allowed to fail, for the same reason the baton gate's is: a
   * process that cannot open the store has no queue to drain, and refusing the call over that would
   * be a worse answer than the surface had before the queue existed.
   */
  openDb?: () => Promise<Database.Database | undefined>;
  /** Which run this call is about. The same seam `#217` moves onto the connection's attachment. */
  runIdFor?: (name: string, args: Record<string, unknown>) => string | undefined;
  /** Who is calling. Defaults to the MCP handshake badge, scoped over the dispatch. */
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
 * Resolve the run this call is about, and refuse to touch its queue unless the caller is the one
 * driving it. Absence allows, exactly as the baton does: an unnamed run, an unreadable store or a
 * badgeless client is not evidence that someone ELSE holds the wheel, and delivering to the only
 * client there is is the whole of the single-client case.
 */
function drivingRun(db: Database.Database, runId: string, caller: ClientInfo | undefined): Run | undefined {
  const run = getRun(db, runId);
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
  const openDb = options.openDb ?? defaultDb;
  const runIdFor = options.runIdFor ?? runIdFromArgs;
  const caller = options.caller ?? (() => currentClientProfile().client);

  async function resolve(name: string, args: Record<string, unknown>): Promise<{ db: Database.Database; run: Run } | undefined> {
    const runId = runIdFor(name, args);
    if (!runId) return undefined;
    const db = await openDb();
    if (!db) return undefined;
    const run = drivingRun(db, runId, caller());
    return run ? { db, run } : undefined;
  }

  return {
    async acknowledge(name, args) {
      try {
        const resolved = await resolve(name, args);
        if (!resolved) return;
        acknowledgeDelivered(resolved.db, resolved.run.id, { actor: actorForRun(resolved.run) });
      } catch (err) {
        log.warn('delivery queue could not acknowledge; leaving the messages delivered', { error: String(err) });
      }
    },
    async deliver(name, args, result) {
      try {
        const resolved = await resolve(name, args);
        if (!resolved) return result;
        // The merge is attempted BEFORE anything is appended: a result whose block cannot carry the
        // messages leaves them queued for the next one rather than marking them delivered into
        // nowhere. So the pending set is read, the merge is rehearsed, and only then are the
        // `message.delivered` rows written for exactly the messages that rode.
        const pending = undeliveredMessages(resolved.db, resolved.run.id);
        if (pending.length === 0) return result;
        if (!withHumanMessages(result, pending)) {
          log.debug('delivery queue: result block is not a JSON object; messages stay queued', { run: resolved.run.id });
          return result;
        }
        const delivered = deliverMessages(resolved.db, resolved.run.id, {
          via: 'piggyback',
          actor: actorForRun(resolved.run),
        });
        return withHumanMessages(result, delivered) ?? result;
      } catch (err) {
        log.warn('delivery queue could not deliver; messages stay queued', { error: String(err) });
        return result;
      }
    },
  };
}

/** The run's driver, wearing the actor shape — the same mapping the baton's `actorFor` makes. */
function actorForRun(run: Run): Actor {
  return {
    kind: run.driver.kind === 'human' ? 'human' : 'agent',
    driver: run.driver.kind,
    ...(run.driver.client ? { client: run.driver.client } : {}),
  };
}
