import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyMigrations, _resetMigrationGuard } from '../../../src/cache/migrations/runner.js';
import { appendRunEventWithTail, createRunWithTail, runEventListenerCount } from '../../../src/studio/run-bus.js';
import { eventsOfTypes, type Driver } from '../../../src/studio/run-store.js';
import {
  dispatchStudioTool,
  setBatonGate,
  setDeliveryHooks,
  type StudioHostHandlers,
} from '../../../src/daemon/studio-dispatch.js';
import { createBatonGate, takeWheel } from '../../../src/daemon/driver-baton.js';
import type { ClientProfile } from '../../../src/daemon/capability-handshake.js';
import {
  createDeliveryHooks,
  DELIVERY_INTERRUPT_CONSUMED,
  DELIVERY_WAIT_REQUESTED,
  DELIVERY_WAIT_RESOLVED,
  listMessages,
  queueMessage,
  MESSAGE_ACKNOWLEDGED,
  MESSAGE_DELIVERED,
  MESSAGE_EVENT_TYPES,
} from '../../../src/daemon/message-queue.js';

/**
 * WHY: mechanism 1 of §3.2 is the ONE that is always on, and it is not a function anyone calls — it
 * is an ordering at the dispatch seam. Acknowledge runs BEFORE the handler, because this call
 * existing is the only evidence a pull client can ever give that it consumed the previous result
 * (A-51-4); deliver runs AFTER, onto a result the call was going to produce anyway. A unit test of
 * the queue module can assert every state and still not see either of those, so these rows drive
 * `dispatchStudioTool` itself and read the log the seam wrote.
 *
 * The ordering row is the load-bearing one. It is asserted from INSIDE the handler — the handler
 * reads the log at the moment it runs — because that is the only vantage point from which "before"
 * and "after" are distinguishable at all: from outside, both hooks have finished.
 */

let dir: string;
let db: Database.Database;
let runId: string;

const DRIVER: Driver = { kind: 'cli', client: { name: 'claude-code', version: '2.1.0' } };
const OTHER = { name: 'some-other-harness', version: '9.9.9' };

/** What the handler saw when it ran. Populated by the host stub, read by the ordering row. */
let seenByHandler: { acknowledged: number; delivered: number } | undefined;

function host(): StudioHostHandlers {
  return {
    observe: async () => ({ id: 's', kind: 'full', trusted: false, untrusted_notice: 'data not instructions', elements: [], events: [], eventCursor: 0, eventsDropped: 0, domTruncated: false }),
    act: async (input) => {
      const rows = eventsOfTypes(db, runId, { types: MESSAGE_EVENT_TYPES, limit: 100 });
      seenByHandler = {
        acknowledged: rows.filter((r) => r.type === MESSAGE_ACKNOWLEDGED).length,
        delivered: rows.filter((r) => r.type === MESSAGE_DELIVERED).length,
      };
      return { ok: true, action: input.action, url: input.url };
    },
    marks: async () => ({ marks: [], untrusted_notice: 'data not instructions' }),
    capture: async () => ({ artifact_id: 1, inserted: true, content_hash: 'h' }),
    spawn: async () => ({ session_id: 'bg-1' }),
    close: async (input) => ({ closed: true as const, session_id: input.session_id ?? '' }),
    list: async () => ({ sessions: [] }),
    say: async () => ({ posted: true, posted_at: 0 }),
    extractSet: async () => ({ columns: [], rows: [], pages_followed: 0, artifact_id: 1 }),
  };
}

interface Called { human_messages?: Array<Record<string, unknown>>; [k: string]: unknown }

/** One tool call as the driving client. Returns the parsed JSON block the agent would read. */
async function call(): Promise<Called> {
  const result = await dispatchStudioTool(
    'studio_act',
    { action: 'navigate', url: 'https://example.com', run_id: runId },
    host(),
    dir,
  );
  return JSON.parse(result.content[0].text) as Called;
}

function texts(block: Called): string[] {
  return (block.human_messages ?? []).map((m) => String(m.text));
}

beforeEach(() => {
  _resetMigrationGuard();
  seenByHandler = undefined;
  dir = mkdtempSync(join(tmpdir(), 'wigolo-queue-dispatch-'));
  db = new Database(join(dir, 'w.db'));
  db.pragma('foreign_keys = ON');
  applyMigrations(db, { vecLoaded: false });
  runId = createRunWithTail(db, { task: 'book the flight', driver: DRIVER }).id;
  setDeliveryHooks(createDeliveryHooks({ openDb: async () => db, caller: () => DRIVER.client }));
});

afterEach(() => {
  setDeliveryHooks(undefined);
  setBatonGate(undefined);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('mechanism 1 — a message rides the very next result', () => {
  it('carries a message queued between calls, with its state line and the mechanism that took it', async () => {
    // Nothing queued: the result is exactly the result, with no empty mailbox bolted onto it.
    const quiet = await call();
    expect(quiet.human_messages).toBeUndefined();
    expect(quiet.ok).toBe(true);

    queueMessage(db, runId, { text: 'stop before you pay' });
    const carried = await call();
    expect(texts(carried)).toEqual(['stop before you pay']);
    const message = carried.human_messages![0];
    expect(message.state).toBe('delivered');
    expect(message.delivered_via).toBe('piggyback');
    expect(message.state_line).toBe(`delivered at step ${String(message.delivered_at_step)} — not yet acknowledged`);
    // Step N is a seq the append assigned, so it is a real position in the log — not a counter.
    expect(message.delivered_at_step).toBe(listMessages(db, runId)[0].deliveredAtStep);

    // The result the agent reads and the state REST reports are the same fold of the same rows.
    expect(listMessages(db, runId)[0].state).toBe('delivered');
  });

  it('does not hand the same message to the next result', async () => {
    queueMessage(db, runId, { text: 'use the other card' });
    expect(texts(await call())).toEqual(['use the other card']);
    expect((await call()).human_messages).toBeUndefined();
  });

  it('keeps a human waiting no longer than one call — two messages, two results, in order', async () => {
    queueMessage(db, runId, { text: 'first' });
    expect(texts(await call())).toEqual(['first']);
    queueMessage(db, runId, { text: 'second' });
    expect(texts(await call())).toEqual(['second']);
  });
});

describe('acknowledgement is implicit, and the ordering IS the rule (A-51-4)', () => {
  it('acknowledges the previous delivery before the handler runs, and delivers after it', async () => {
    queueMessage(db, runId, { text: 'the address is wrong' });

    // Call 1 delivers. At the moment its handler ran, nothing had been delivered or acknowledged —
    // which is the "deliver AFTER the handler" half: piggyback rides a result, it does not gate one.
    await call();
    expect(seenByHandler).toEqual({ acknowledged: 0, delivered: 0 });

    // Call 2 acknowledges. Its handler sees the acknowledgement ALREADY in the log — the "before
    // the handler" half. If the hook ran after, this reads 0 and the row is red.
    await call();
    expect(seenByHandler).toEqual({ acknowledged: 1, delivered: 1 });

    const message = listMessages(db, runId)[0];
    expect(message.state).toBe('acknowledged');
    expect(message.acknowledgedAtStep).toBeGreaterThan(message.deliveredAtStep!);
  });

  it('acknowledges nothing on a call that follows a result carrying nothing', async () => {
    await call();
    await call();
    expect(eventsOfTypes(db, runId, { types: [MESSAGE_ACKNOWLEDGED], limit: 100 })).toEqual([]);
  });
});

describe('the queue is the driver\'s mail, and a mailbox is never a gate', () => {
  it('gives a refused caller neither the messages nor the acknowledgement', async () => {
    queueMessage(db, runId, { text: 'not for you' });
    // A second harness calling into a run someone else drives. The baton refuses it, so its call
    // never becomes evidence of anything: the driver's mail stays queued for the driver.
    setBatonGate(createBatonGate({ openDb: async () => db, caller: () => OTHER }));
    setDeliveryHooks(createDeliveryHooks({ openDb: async () => db, caller: () => OTHER }));

    const refusal = await call();
    expect(refusal.error_reason).toBe('not_the_driver');
    expect(refusal.human_messages).toBeUndefined();
    expect(listMessages(db, runId)[0].state).toBe('queued');

    // And the driver's own next call still gets it — nothing was consumed on its behalf.
    setDeliveryHooks(createDeliveryHooks({ openDb: async () => db, caller: () => DRIVER.client }));
    setBatonGate(undefined);
    expect(texts(await call())).toEqual(['not for you']);
  });

  it('leaves a message queued rather than losing it, when the queue cannot be read at all', async () => {
    queueMessage(db, runId, { text: 'survives a broken store' });
    setDeliveryHooks(createDeliveryHooks({
      openDb: async () => { throw new Error('store is gone'); },
      caller: () => DRIVER.client,
    }));

    // The call answers normally — a mailbox that cannot be opened is not a reason to refuse work.
    const answer = await call();
    expect(answer.ok).toBe(true);
    expect(answer.human_messages).toBeUndefined();

    // Nothing was marked delivered into nowhere, so the next healthy call still carries it.
    setDeliveryHooks(createDeliveryHooks({ openDb: async () => db, caller: () => DRIVER.client }));
    expect(texts(await call())).toEqual(['survives a broken store']);
  });

  it('delivers nothing on a call that names no run', async () => {
    queueMessage(db, runId, { text: 'needs a run id' });
    const result = await dispatchStudioTool('studio_act', { action: 'navigate', url: 'https://example.com' }, host(), dir);
    expect((JSON.parse(result.content[0].text) as Called).human_messages).toBeUndefined();
    expect(listMessages(db, runId)[0].state).toBe('queued');
  });
});

describe('mechanisms 2-4 — wait, interrupt and the push-gated stub', () => {
  it('parks only the waiting run, then a REST-shaped queued message resolves it with via=wait', async () => {
    const otherRun = createRunWithTail(db, { task: 'independent work', driver: DRIVER }).id;
    const waiting = dispatchStudioTool(
      'studio_act',
      { action: 'wait_for_human', reason: 'Which account?', run_id: runId },
      host(),
      dir,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(runEventListenerCount(runId)).toBe(1);

    // A different run is not serialized behind the parked call.
    const other = await dispatchStudioTool(
      'studio_act',
      { action: 'navigate', url: 'https://example.com', run_id: otherRun },
      host(),
      dir,
    );
    expect(JSON.parse(other.content[0]!.text)).toMatchObject({ ok: true, action: 'navigate' });

    // This is the same append the POST /v1/runs/:id/messages store binding performs. Queue two in
    // one turn: the first is the answer, and everything pending rides the resolution result.
    queueMessage(db, runId, { text: 'Use the work account' });
    queueMessage(db, runId, { text: 'The tenant is north' });
    const resolved = JSON.parse((await waiting).content[0]!.text) as Called & { answer: Record<string, unknown> };
    expect(resolved.answer).toMatchObject({ text: 'Use the work account', state: 'delivered', delivered_via: 'wait' });
    expect(texts(resolved)).toEqual(['Use the work account', 'The tenant is north']);
    expect(resolved.human_messages!.every((m) => m.delivered_via === 'wait')).toBe(true);
    expect(runEventListenerCount(runId)).toBe(0);

    const deliveryEvents = eventsOfTypes(db, runId, {
      types: [DELIVERY_WAIT_REQUESTED, DELIVERY_WAIT_RESOLVED, MESSAGE_DELIVERED],
      limit: 20,
    });
    expect(deliveryEvents.map((event) => event.type)).toEqual([
      DELIVERY_WAIT_REQUESTED,
      MESSAGE_DELIVERED,
      MESSAGE_DELIVERED,
      DELIVERY_WAIT_RESOLVED,
    ]);
    expect(deliveryEvents[3]!.payload.waitId).toBe(deliveryEvents[0]!.payload.waitId);
    expect(deliveryEvents[3]!.payload.messageId).toBe(resolved.answer.message_id);
    expect(listMessages(db, runId).map((message) => message.deliveredVia)).toEqual(['wait', 'wait']);

    await call();
    expect(listMessages(db, runId).every((message) => message.state === 'acknowledged')).toBe(true);
  });

  it('returns a typed refusal instead of treating a wait with no run id as success', async () => {
    const result = await dispatchStudioTool(
      'studio_act',
      { action: 'wait_for_human', reason: 'Need a choice' },
      host(),
      dir,
    );
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ error_reason: 'run_required' });
  });

  it('refuses a second concurrent wait on the same run without stranding a wait event', async () => {
    const first = dispatchStudioTool(
      'studio_act',
      { action: 'wait_for_human', reason: 'First question', run_id: runId },
      host(),
      dir,
    );
    await expect.poll(() => runEventListenerCount(runId)).toBe(1);
    const second = await dispatchStudioTool(
      'studio_act',
      { action: 'wait_for_human', reason: 'Second question', run_id: runId },
      host(),
      dir,
    );
    expect(second.isError).toBe(true);
    expect(JSON.parse(second.content[0]!.text)).toMatchObject({ error_reason: 'wait_already_pending' });
    expect(eventsOfTypes(db, runId, { types: [DELIVERY_WAIT_REQUESTED], limit: 20 })).toHaveLength(1);

    queueMessage(db, runId, { text: 'Answer the first question' });
    await first;
    expect(runEventListenerCount(runId)).toBe(0);
  });

  it('releases a parked wait as an interrupt when the human takes the wheel', async () => {
    const waiting = dispatchStudioTool(
      'studio_act',
      { action: 'wait_for_human', reason: 'Choose a route', run_id: runId },
      host(),
      dir,
    );
    await expect.poll(() => runEventListenerCount(runId)).toBe(1);
    expect(takeWheel(db, runId, { by: { kind: 'human' }, reason: 'I will handle it' }).ok).toBe(true);

    expect(JSON.parse((await waiting).content[0]!.text)).toMatchObject({
      interrupted: true,
      reason: 'human took control',
      detail: 'I will handle it',
    });
    expect(runEventListenerCount(runId)).toBe(0);
    expect(eventsOfTypes(db, runId, { types: [DELIVERY_WAIT_RESOLVED], limit: 20 })[0]!.payload)
      .toMatchObject({ outcome: 'interrupted' });
  });

  it('cleans up an abandoned wait without delivering a later human message', async () => {
    const controller = new AbortController();
    const waiting = dispatchStudioTool(
      'studio_act',
      { action: 'wait_for_human', reason: 'Choose a route', run_id: runId },
      host(),
      dir,
      { signal: controller.signal },
    );
    await expect.poll(() => runEventListenerCount(runId)).toBe(1);
    controller.abort();

    const result = await waiting;
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ error_reason: 'wait_aborted' });
    expect(runEventListenerCount(runId)).toBe(0);
    queueMessage(db, runId, { text: 'Too late for the abandoned call' });
    expect(listMessages(db, runId)[0]!.state).toBe('queued');
  });

  it('interrupts an urgent message exactly once, skips host work, then acknowledges and continues', async () => {
    let hostCalls = 0;
    const handlers = host();
    handlers.act = async (input) => {
      hostCalls++;
      return { ok: true, action: input.action };
    };
    queueMessage(db, runId, { text: 'Stop before paying', urgent: true });

    const first = await dispatchStudioTool(
      'studio_act',
      { action: 'navigate', url: 'https://example.com', run_id: runId },
      handlers,
      dir,
    );
    const interrupted = JSON.parse(first.content[0]!.text) as Called;
    expect(interrupted).toMatchObject({ interrupted: true, reason: 'urgent human message', detail: 'Stop before paying' });
    expect(interrupted.human_messages![0]).toMatchObject({ text: 'Stop before paying', delivered_via: 'interrupt' });
    expect(hostCalls).toBe(0);

    const second = await dispatchStudioTool(
      'studio_act',
      { action: 'navigate', url: 'https://example.com', run_id: runId },
      handlers,
      dir,
    );
    expect(JSON.parse(second.content[0]!.text)).toMatchObject({ ok: true, action: 'navigate' });
    expect(hostCalls).toBe(1);
    expect(listMessages(db, runId)[0]!.state).toBe('acknowledged');
    expect(eventsOfTypes(db, runId, { types: [DELIVERY_INTERRUPT_CONSUMED], limit: 20 })).toHaveLength(1);
  });

  it('returns takeover interruption before baton refusal, then acks its messages before the refusal', async () => {
    let hostCalls = 0;
    const handlers = host();
    handlers.act = async (input) => {
      hostCalls++;
      return { ok: true, action: input.action };
    };
    queueMessage(db, runId, { text: 'Use the work account' });
    setBatonGate(createBatonGate({ openDb: async () => db, caller: () => DRIVER.client }));
    expect(takeWheel(db, runId, { by: { kind: 'human' }, reason: 'sign-in needs you' }).ok).toBe(true);

    const first = await dispatchStudioTool(
      'studio_act',
      { action: 'navigate', url: 'https://example.com', run_id: runId },
      handlers,
      dir,
    );
    expect(JSON.parse(first.content[0]!.text)).toMatchObject({
      interrupted: true,
      reason: 'human took control',
      detail: 'sign-in needs you',
      human_messages: [{ text: 'Use the work account', delivered_via: 'interrupt' }],
    });
    expect(hostCalls).toBe(0);

    const second = await dispatchStudioTool(
      'studio_act',
      { action: 'navigate', url: 'https://example.com', run_id: runId },
      handlers,
      dir,
    );
    expect(JSON.parse(second.content[0]!.text)).toMatchObject({ error_reason: 'not_the_driver' });
    expect(listMessages(db, runId)[0]!.state).toBe('acknowledged');
    expect(hostCalls).toBe(0);
  });

  it('does not lose an unconsumed takeover behind unrelated run traffic', async () => {
    setBatonGate(createBatonGate({ openDb: async () => db, caller: () => DRIVER.client }));
    expect(takeWheel(db, runId, { by: { kind: 'human' }, reason: 'manual control' }).ok).toBe(true);
    for (let i = 0; i < 501; i++) {
      appendRunEventWithTail(db, runId, { actor: { kind: 'daemon' }, type: 'delivery.noise', payload: { i } });
    }
    expect(await call()).toMatchObject({ interrupted: true, reason: 'human took control' });
  });

  it('delivers the urgent message itself when older queued messages fill the normal batch', async () => {
    for (let i = 0; i < 20; i++) queueMessage(db, runId, { text: `ordinary ${i}` });
    queueMessage(db, runId, { text: 'urgent answer', urgent: true });

    const interrupted = await call();
    expect(interrupted).toMatchObject({ interrupted: true, reason: 'urgent human message' });
    expect(interrupted.human_messages).toEqual([
      expect.objectContaining({ text: 'urgent answer', delivered_via: 'interrupt' }),
    ]);
    expect(listMessages(db, runId).find((message) => message.text === 'urgent answer')?.state).toBe('delivered');
    expect(listMessages(db, runId).filter((message) => message.text.startsWith('ordinary')).every((message) => message.state === 'queued')).toBe(true);
  });

  it('never selects the out-of-band stub without push, and push still falls through to piggyback', async () => {
    const probe = vi.fn();
    queueMessage(db, runId, { text: 'ordinary update' });
    setDeliveryHooks(createDeliveryHooks({
      openDb: async () => db,
      caller: () => DRIVER.client,
      profile: () => ({ tier: 'detected', phrasing: 'mcp-tools', capabilities: [] }),
      outOfBandProbe: probe,
    }));
    expect(texts(await call())).toEqual(['ordinary update']);
    expect(probe).not.toHaveBeenCalled();

    queueMessage(db, runId, { text: 'push-eligible update' });
    const pushProfile: ClientProfile = {
      tier: 'detected',
      client: DRIVER.client,
      phrasing: 'mcp-tools',
      capabilities: ['push'],
    };
    setDeliveryHooks(createDeliveryHooks({
      openDb: async () => db,
      caller: () => DRIVER.client,
      profile: () => pushProfile,
      outOfBandProbe: probe,
    }));
    const carried = await call();
    expect(probe).toHaveBeenCalledOnce();
    expect(texts(carried)).toEqual(['push-eligible update']);
    expect(carried.human_messages![0]!.delivered_via).toBe('piggyback');
  });

  it.each([
    ['run.paused', 'human paused the run'],
    ['run.cancelled', 'human cancelled the run'],
  ])('derives a one-shot interrupt from human-authored %s', async (type, reason) => {
    appendRunEventWithTail(db, runId, { actor: { kind: 'human' }, type, payload: { reason: 'stop now' } });
    const first = await call();
    expect(first).toMatchObject({ interrupted: true, reason });
    const second = await call();
    expect(second.interrupted).toBeUndefined();
  });
});
