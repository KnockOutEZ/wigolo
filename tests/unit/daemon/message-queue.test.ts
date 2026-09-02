/**
 * The delivery queue (SD2 mini-spec §3) — the lifecycle, the clock, and the honesty rule.
 *
 * Every assertion here reads the LOG back rather than a return value where it can, because the
 * claim being made is that the queue is a fold over events and not a structure the daemon holds:
 * a test that only checked what `deliverMessages` returned would pass against an in-memory map.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyMigrations, _resetMigrationGuard } from '../../../src/cache/migrations/runner.js';
import { createRunWithTail } from '../../../src/studio/run-bus.js';
import { eventsSince, type Actor, type Driver, type Run } from '../../../src/studio/run-store.js';
import type { McpToolResult } from '../../../src/daemon/studio-dispatch.js';
import {
  acknowledgeDelivered,
  deliverMessages,
  listMessages,
  messageView,
  queueMessage,
  renderMessageState,
  undeliveredMessages,
  withHumanMessages,
  MAX_MESSAGE_TEXT_CHARS,
  MAX_MESSAGES_PER_RESULT,
  MESSAGE_ACKNOWLEDGED,
  MESSAGE_DELIVERED,
  MESSAGE_QUEUED,
  type RunMessage,
} from '../../../src/daemon/message-queue.js';

let dir: string;
let db: Database.Database;

const CLI: Driver = { kind: 'cli', client: { name: 'claude-code', version: '2.1.0' } };
const HUMAN: Actor = { kind: 'human' };

beforeEach(() => {
  _resetMigrationGuard();
  dir = mkdtempSync(join(tmpdir(), 'wigolo-msgq-'));
  db = new Database(join(dir, 'w.db'));
  db.pragma('foreign_keys = ON');
  applyMigrations(db, { vecLoaded: false });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function newRun(driver: Driver = CLI): Run {
  return createRunWithTail(db, { task: 'compare two monitors', driver });
}

function types(runId: string): string[] {
  return eventsSince(db, runId, 0, 200).map((e) => e.type);
}

function payloads(runId: string, type: string): Record<string, unknown>[] {
  return eventsSince(db, runId, 0, 200).filter((e) => e.type === type).map((e) => e.payload);
}

function seqOf(runId: string, type: string): number[] {
  return eventsSince(db, runId, 0, 200).filter((e) => e.type === type).map((e) => e.seq);
}

function send(runId: string, text: string, from: Actor = HUMAN): RunMessage {
  const result = queueMessage(db, runId, { text, from });
  if (!result.ok) throw new Error(`queue refused: ${result.error_reason}`);
  return result.message;
}

function jsonResult(data: Record<string, unknown>): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], isError: false };
}

function block(result: McpToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

describe('a message is three rows in the run log, and nothing else', () => {
  it('queues, delivers and acknowledges as message.queued → message.delivered → message.acknowledged', () => {
    const run = newRun();
    send(run.id, 'the left one is the 27-inch');

    expect(types(run.id)).toEqual(['run.created', MESSAGE_QUEUED]);

    deliverMessages(db, run.id);
    expect(types(run.id)).toEqual(['run.created', MESSAGE_QUEUED, MESSAGE_DELIVERED]);

    acknowledgeDelivered(db, run.id);
    expect(types(run.id)).toEqual(['run.created', MESSAGE_QUEUED, MESSAGE_DELIVERED, MESSAGE_ACKNOWLEDGED]);
  });

  it('carries the text, the sender and the urgency into the queued payload', () => {
    const run = newRun();
    const sender: Actor = { kind: 'human', driver: 'studio' };
    const queued = queueMessage(db, run.id, { text: 'stop after this one', from: sender, urgent: true });
    expect(queued.ok).toBe(true);

    expect(payloads(run.id, MESSAGE_QUEUED)).toEqual([
      { messageId: expect.stringMatching(/^hm_/), text: 'stop after this one', from: sender, urgent: true },
    ]);
    // The envelope actor is the sender too — the payload restates it, it does not replace it.
    expect(eventsSince(db, run.id, 0, 10).find((e) => e.type === MESSAGE_QUEUED)!.actor).toEqual(sender);
  });

  it('refuses an empty message, an oversized one, and one for a run that does not exist', () => {
    const run = newRun();
    expect(queueMessage(db, run.id, { text: '   ' })).toMatchObject({ ok: false, error_reason: 'invalid_message' });
    expect(queueMessage(db, run.id, { text: 'x'.repeat(MAX_MESSAGE_TEXT_CHARS + 1) })).toMatchObject({
      ok: false,
      error_reason: 'invalid_message',
    });
    expect(queueMessage(db, 'zzzz', { text: 'hello' })).toMatchObject({ ok: false, error_reason: 'run_not_found' });
    // A refusal writes nothing: the log still holds only the birth event.
    expect(types(run.id)).toEqual(['run.created']);
  });

  it('reads a hand-written row that the store\'s envelope mechanics accepted but that is not a message', () => {
    const run = newRun();
    db.prepare('INSERT INTO studio_run_events (run_id, seq, ts, actor, type, payload) VALUES (?, ?, ?, ?, ?, ?)').run(
      run.id,
      99,
      new Date().toISOString(),
      JSON.stringify(HUMAN),
      MESSAGE_QUEUED,
      JSON.stringify({ messageId: 'hm_empty' }),
    );
    // No `text`, so it is not a message and it is not delivered — an empty line rendered to the
    // agent as if a human had typed it is worse than a dropped row.
    expect(undeliveredMessages(db, run.id)).toEqual([]);
    expect(listMessages(db, run.id)).toEqual([]);
  });
});

describe('step N is the run-event seq (A-51-3) — the log is the only clock', () => {
  it('records delivery at the seq of its own message.delivered row', () => {
    const run = newRun();
    send(run.id, 'first');
    const delivered = deliverMessages(db, run.id);

    const [deliveredSeq] = seqOf(run.id, MESSAGE_DELIVERED);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.deliveredAtStep).toBe(deliveredSeq);
    expect(deliveredSeq).toBe(3); // run.created = 1, message.queued = 2
  });

  it('acknowledges the delivery by its step, not by its own', () => {
    const run = newRun();
    send(run.id, 'first');
    deliverMessages(db, run.id);
    const [deliveredSeq] = seqOf(run.id, MESSAGE_DELIVERED);

    acknowledgeDelivered(db, run.id);
    const [ack] = payloads(run.id, MESSAGE_ACKNOWLEDGED);
    expect(ack).toEqual({ messageId: expect.stringMatching(/^hm_/), step: deliveredSeq });
    // The ack's own seq is a later number; `step` names what it answers.
    expect(seqOf(run.id, MESSAGE_ACKNOWLEDGED)[0]).toBeGreaterThan(deliveredSeq);
  });

  it('does not copy the delivering step into its own payload', () => {
    const run = newRun();
    send(run.id, 'first');
    deliverMessages(db, run.id);
    // A-54-1: the row's `seq` IS step N. A `step` field here would be a second copy of one number,
    // and one that could only be written by predicting a seq the append has not assigned yet.
    expect(payloads(run.id, MESSAGE_DELIVERED)).toEqual([{ messageId: expect.any(String), via: 'piggyback' }]);
  });
});

describe('the undelivered set is FIFO and drains once', () => {
  it('delivers in the order the messages were queued', () => {
    const run = newRun();
    send(run.id, 'one');
    send(run.id, 'two');
    send(run.id, 'three');

    expect(deliverMessages(db, run.id).map((m) => m.text)).toEqual(['one', 'two', 'three']);
  });

  it('never delivers the same message twice', () => {
    const run = newRun();
    send(run.id, 'one');
    expect(deliverMessages(db, run.id)).toHaveLength(1);
    expect(deliverMessages(db, run.id)).toEqual([]);
    expect(seqOf(run.id, MESSAGE_DELIVERED)).toHaveLength(1);
  });

  it('leaves a message queued between two others that already went', () => {
    const run = newRun();
    send(run.id, 'one');
    deliverMessages(db, run.id);
    send(run.id, 'two');

    expect(undeliveredMessages(db, run.id).map((m) => m.text)).toEqual(['two']);
  });

  it('caps one result at MAX_MESSAGES_PER_RESULT and hands the rest to the next call', () => {
    const run = newRun();
    for (let i = 0; i < MAX_MESSAGES_PER_RESULT + 3; i++) send(run.id, `line ${i}`);

    const first = deliverMessages(db, run.id);
    expect(first).toHaveLength(MAX_MESSAGES_PER_RESULT);
    expect(first[0]!.text).toBe('line 0'); // the oldest, not the newest
    expect(deliverMessages(db, run.id).map((m) => m.text)).toEqual(['line 20', 'line 21', 'line 22']);
  });
});

describe('acknowledgement is implicit (A-51-4)', () => {
  it('acknowledges everything the previous delivery carried, and nothing still queued', () => {
    const run = newRun();
    send(run.id, 'delivered one');
    send(run.id, 'delivered two');
    deliverMessages(db, run.id);
    send(run.id, 'still queued');

    expect(acknowledgeDelivered(db, run.id)).toHaveLength(2);
    const states = new Map(listMessages(db, run.id).map((m) => [m.text, m.state]));
    expect(states.get('delivered one')).toBe('acknowledged');
    expect(states.get('delivered two')).toBe('acknowledged');
    expect(states.get('still queued')).toBe('queued');
  });

  it('acknowledges nothing when nothing was delivered', () => {
    const run = newRun();
    send(run.id, 'queued only');
    expect(acknowledgeDelivered(db, run.id)).toEqual([]);
    expect(types(run.id)).toEqual(['run.created', MESSAGE_QUEUED]);
  });

  it('is idempotent — a second call appends no second acknowledgement', () => {
    const run = newRun();
    send(run.id, 'one');
    deliverMessages(db, run.id);
    acknowledgeDelivered(db, run.id);
    expect(acknowledgeDelivered(db, run.id)).toEqual([]);
    expect(seqOf(run.id, MESSAGE_ACKNOWLEDGED)).toHaveLength(1);
  });
});

describe('the honesty rule (law 7) on the wire', () => {
  const FORBIDDEN = /\b(sent|seen|read|instant|instantly|immediately|now|received|arrived)\b/i;

  it('renders every state without a word that implies the agent already has it', () => {
    const lines = [
      renderMessageState({ state: 'queued' }),
      renderMessageState({ state: 'delivered', deliveredAtStep: 7 }),
      renderMessageState({ state: 'acknowledged', acknowledgedAtStep: 9 }),
    ];
    for (const line of lines) expect(line).not.toMatch(FORBIDDEN);
    expect(lines[0]).toBe('queued — reaches the agent at its next tool call');
    expect(lines[1]).toContain('step 7');
    expect(lines[2]).toContain('step 9');
  });

  it('puts state, delivered_at_step and the state line on the wire representation', () => {
    const run = newRun();
    send(run.id, 'the left one');
    let view = messageView(listMessages(db, run.id)[0]!);
    expect(view.state).toBe('queued');
    expect(view.delivered_at_step).toBeUndefined();
    expect(view.state_line).toBe('queued — reaches the agent at its next tool call');

    const [delivered] = deliverMessages(db, run.id);
    view = messageView(delivered!);
    expect(view).toMatchObject({
      state: 'delivered',
      delivered_at_step: delivered!.deliveredAtStep,
      delivered_via: 'piggyback',
    });

    acknowledgeDelivered(db, run.id);
    view = messageView(listMessages(db, run.id)[0]!);
    expect(view).toMatchObject({ state: 'acknowledged', delivered_at_step: delivered!.deliveredAtStep });
    expect(String(view.state_line)).not.toMatch(FORBIDDEN);
  });

  it('names no state the queue cannot be in', () => {
    const run = newRun();
    send(run.id, 'a');
    send(run.id, 'b');
    deliverMessages(db, run.id, { limit: 1 });
    acknowledgeDelivered(db, run.id);
    const states = listMessages(db, run.id).map((m) => m.state);
    for (const state of states) expect(['queued', 'delivered', 'acknowledged']).toContain(state);
  });
});

describe('the listing folds the log newest first', () => {
  it('reports each message at the state its rows put it in', () => {
    const run = newRun();
    send(run.id, 'oldest');
    deliverMessages(db, run.id);
    acknowledgeDelivered(db, run.id);
    send(run.id, 'middle');
    deliverMessages(db, run.id);
    send(run.id, 'newest');

    expect(listMessages(db, run.id).map((m) => [m.text, m.state])).toEqual([
      ['newest', 'queued'],
      ['middle', 'delivered'],
      ['oldest', 'acknowledged'],
    ]);
  });

  it('honours a limit without changing which end of the list it takes', () => {
    const run = newRun();
    send(run.id, 'one');
    send(run.id, 'two');
    send(run.id, 'three');
    expect(listMessages(db, run.id, 2).map((m) => m.text)).toEqual(['three', 'two']);
  });

  it('is empty for a run nobody has written to', () => {
    expect(listMessages(db, newRun().id)).toEqual([]);
  });
});

describe('the piggyback merge (§3.2 mechanism 1)', () => {
  it('folds the messages into the result JSON block as human_messages', () => {
    const run = newRun();
    send(run.id, 'the left one is the 27-inch');
    const delivered = deliverMessages(db, run.id);

    const merged = withHumanMessages(jsonResult({ ok: true, marks: [] }), delivered)!;
    const body = block(merged);
    expect(body.ok).toBe(true);
    expect(body.marks).toEqual([]);
    expect(body.human_messages).toEqual([
      expect.objectContaining({
        text: 'the left one is the 27-inch',
        state: 'delivered',
        delivered_at_step: delivered[0]!.deliveredAtStep,
        state_line: expect.stringContaining('delivered at step'),
      }),
    ]);
  });

  it('leaves the rest of the result untouched, including a second content block', () => {
    const run = newRun();
    send(run.id, 'hello');
    const base: McpToolResult = {
      content: [
        { type: 'text', text: JSON.stringify({ ok: true }, null, 2) },
        { type: 'text', text: '— run 7fq2 —' },
      ],
      isError: true,
    };
    const merged = withHumanMessages(base, deliverMessages(db, run.id))!;
    expect(merged.isError).toBe(true);
    expect(merged.content).toHaveLength(2);
    expect(merged.content[1]).toEqual({ type: 'text', text: '— run 7fq2 —' });
  });

  it('refuses a result whose block is not a JSON object, so nothing is marked delivered into nowhere', () => {
    const run = newRun();
    const messages = [send(run.id, 'hello')];
    expect(withHumanMessages({ content: [{ type: 'text', text: 'not json' }], isError: false }, messages)).toBeUndefined();
    expect(withHumanMessages({ content: [{ type: 'text', text: '[1,2,3]' }], isError: false }, messages)).toBeUndefined();
    expect(withHumanMessages({ content: [], isError: false }, messages)).toBeUndefined();
  });
});
