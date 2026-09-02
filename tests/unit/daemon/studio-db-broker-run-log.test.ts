import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SearchEngine } from '../../../src/types.js';
import type { SmartRouter } from '../../../src/fetch/router.js';
import { resetConfig } from '../../../src/config.js';
import { applyMigrations, _resetMigrationGuard } from '../../../src/cache/migrations/runner.js';
import { createBrokerHandlers } from '../../../src/daemon/studio-db-broker.js';
import {
  sqliteRunsStore,
  type DriverGesture,
  type RunsStore,
} from '../../../src/daemon/rest/runs-store.js';
import { createRun, type ClientInfo, type Driver, type RunEvent } from '../../../src/studio/run-store.js';
import type { QueueMessageInput } from '../../../src/daemon/message-queue.js';

/**
 * #334 — the six SD2 run-log methods the broker child owes the store port.
 *
 * WHAT IS BEING CLAIMED. `RunsStore` names nine members; the daemon's native binding has all nine
 * and the app's broker-backed binding could bind three, because `driver`, `sendMessage`,
 * `messages`, `typedEvents`, `unansweredEvents` and `interruptTrigger` had no method on the child.
 * Measured on the launched app, `GET /v1/runs/:id` answered 200 while `POST /v1/runs/:id/driver`
 * and both `/messages` routes answered `503 store_unavailable` — so with the app as host, no
 * gesture moved the baton and no message could be queued, from any surface.
 *
 * HOW IT IS TESTED, AND WHY THIS WAY. Every row below drives the SAME input through BOTH bindings
 * and asserts the answers are deep-equal — not that the broker's answer merely looks plausible.
 * That is the whole claim of a transport widening: the app's answer and the daemon's answer to one
 * request body must be the same value, and a paraphrase of the baton's or the queue's grammar in
 * the child would show up here as a difference rather than as a divergence discovered in the app
 * weeks later.
 *
 * The two bindings run against SEPARATE databases, seeded identically, because four of the six are
 * WRITES: sharing one handle would mean the second caller acts on the state the first one left, and
 * two different answers would be correct. The clock and `Math.random` are pinned for the same
 * reason — a minted request id and an event timestamp are the only fields that could differ
 * without a divergence, and normalizing them away afterwards would also hide a real one.
 */

const ENGINE: SearchEngine = { name: 'mock', search: vi.fn().mockResolvedValue([]) };
const ROUTER = { fetch: vi.fn() } as unknown as SmartRouter;

const CLI: Driver = { kind: 'cli', client: { name: 'claude-code', version: '2.1.0' } };
const SDK: Driver = { kind: 'sdk', client: { name: 'wigolo-sdk', version: '0.4.0' } };
const HUMAN: Driver = { kind: 'human' };
const CLI_BADGE: ClientInfo = { name: 'claude-code', version: '2.1.0' };

/** The run id both databases mint, so one id names one run on both sides of the comparison. */
const RUN = 'par2z3q';
const ABSENT = 'zzzzzzz';

/** The six, by their port member and their broker method. Load-bearing — see the dispatch row. */
const SIX = [
  ['driver', 'runDriver'],
  ['sendMessage', 'runSendMessage'],
  ['messages', 'runMessages'],
  ['typedEvents', 'runTypedEvents'],
  ['unansweredEvents', 'runUnansweredEvents'],
  ['interruptTrigger', 'runInterruptTrigger'],
] as const;

type Handlers = ReturnType<typeof createBrokerHandlers>;

interface Side {
  db: Database.Database;
  store: RunsStore;
  handlers: Handlers;
  events: Array<{ runId: string; event: RunEvent }>;
}

let dir: string;
let native: Side;
let broker: Side;

function openSide(name: string): Side {
  const db = new Database(join(dir, `${name}.db`));
  db.pragma('foreign_keys = ON');
  applyMigrations(db, { vecLoaded: false });
  // Seeded by the store function directly, with the id and the clock injected: the seeding is not
  // what is under test, and both sides have to start from a byte-identical log for a difference in
  // the answers below to mean what this file says it means.
  createRun(db, { task: 'compare two monitors', driver: CLI }, { mintId: () => RUN, dataDir: dir });
  const events: Array<{ runId: string; event: RunEvent }> = [];
  return {
    db,
    store: sqliteRunsStore(db),
    handlers: createBrokerHandlers({
      db,
      engines: [ENGINE],
      router: ROUTER,
      backendStatus: undefined,
      onArtifact: () => {},
      onRunEvent: (runId, event) => { events.push({ runId, event }); },
    }),
    events,
  };
}

beforeEach(() => {
  _resetMigrationGuard();
  dir = mkdtempSync(join(tmpdir(), 'wigolo-broker-runlog-'));
  process.env.WIGOLO_DATA_DIR = dir;
  process.env.LOG_LEVEL = 'error';
  resetConfig();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-03T12:00:00.000Z'));
  vi.spyOn(Math, 'random').mockReturnValue(0.4242);
  native = openSide('native');
  broker = openSide('broker');
});

afterEach(() => {
  native.db.close();
  broker.db.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete process.env.WIGOLO_DATA_DIR;
  resetConfig();
  rmSync(dir, { recursive: true, force: true });
});

/** Run one gesture through both bindings and hand back both answers. */
async function bothDriver(runId: string, input: DriverGesture): Promise<[unknown, unknown]> {
  return [
    await native.store.driver!(runId, input),
    await broker.handlers.runDriver({ runId, input }),
  ];
}

async function bothSend(runId: string, input: QueueMessageInput): Promise<[unknown, unknown]> {
  return [
    await native.store.sendMessage!(runId, input),
    await broker.handlers.runSendMessage({ runId, input }),
  ];
}

describe('studio-db-broker — the six SD2 run-log methods', () => {
  describe('answer the same value the native binding answers', () => {
    it('driver — an accepted gesture, down to the events it committed and the run it left behind', async () => {
      const [a, b] = await bothDriver(RUN, { gesture: 'takeover', by: HUMAN, reason: 'I will finish this' });
      expect((a as { ok: boolean }).ok).toBe(true);
      expect(b).toEqual(a);
      // The events are the point: a paraphrased grammar would still say `ok: true`.
      expect((b as { events: RunEvent[] }).events.map((e) => e.type)).toEqual(['driver.changed']);
    });

    it('driver — a release into an empty queue, which is TWO events and a paused run', async () => {
      const [a, b] = await bothDriver(RUN, { gesture: 'release', by: CLI });
      expect(b).toEqual(a);
      expect((b as { events: RunEvent[] }).events.map((e) => e.type)).toEqual(['driver.changed', 'run.paused']);
    });

    it('driver — a request, then the grant that answers it by its minted id', async () => {
      const [reqA, reqB] = await bothDriver(RUN, { gesture: 'request', by: SDK, reason: 'let me try' });
      expect(reqB).toEqual(reqA);
      const requestId = (reqA as { requestId: string }).requestId;
      expect(requestId).toBeTruthy();
      const [grantA, grantB] = await bothDriver(RUN, { gesture: 'grant', by: CLI, requestId });
      expect(grantB).toEqual(grantA);
      expect((grantB as { run: { driver: Driver } }).run.driver).toEqual(SDK);
    });

    it('driver — a REFUSAL arrives as a resolved value carrying error_reason, on both bindings', async () => {
      const [notDriver, notDriverB] = await bothDriver(RUN, { gesture: 'release', by: SDK });
      expect(notDriverB).toEqual(notDriver);
      expect(notDriverB).toMatchObject({ ok: false, error_reason: 'not_the_driver' });

      const [absent, absentB] = await bothDriver(ABSENT, { gesture: 'takeover', by: HUMAN });
      expect(absentB).toEqual(absent);
      expect(absentB).toMatchObject({ ok: false, error_reason: 'run_not_found' });

      const [unknown, unknownB] = await bothDriver(RUN, { gesture: 'deny', by: CLI, requestId: 'wr_nope' });
      expect(unknownB).toEqual(unknown);
      expect(unknownB).toMatchObject({ ok: false, error_reason: 'unknown_request' });

      const [noSuccessor, noSuccessorB] = await bothDriver(RUN, { gesture: 'grant', by: CLI });
      expect(noSuccessorB).toEqual(noSuccessor);
      expect(noSuccessorB).toMatchObject({ ok: false, error_reason: 'no_successor' });
    });

    it('sendMessage — the queued message, its committed row, and the replay a retry gets', async () => {
      const [a, b] = await bothSend(RUN, { text: 'stop at the checkout page', messageId: 'hm_fixed' });
      expect(b).toEqual(a);
      expect(b).toMatchObject({ ok: true, message: { messageId: 'hm_fixed', state: 'queued' } });

      const [retryA, retryB] = await bothSend(RUN, { text: 'stop at the checkout page', messageId: 'hm_fixed' });
      expect(retryB).toEqual(retryA);
      expect(retryB).toMatchObject({ ok: true, replayed: true });
    });

    it('sendMessage — a REFUSAL arrives as a resolved value carrying error_reason, on both bindings', async () => {
      const [blank, blankB] = await bothSend(RUN, { text: '   ' });
      expect(blankB).toEqual(blank);
      expect(blankB).toMatchObject({ ok: false, error_reason: 'invalid_message' });

      const [absent, absentB] = await bothSend(ABSENT, { text: 'nobody home' });
      expect(absentB).toEqual(absent);
      expect(absentB).toMatchObject({ ok: false, error_reason: 'run_not_found' });
    });

    it('messages — newest first, each folded to the state its rows put it in', async () => {
      await bothSend(RUN, { text: 'first', messageId: 'hm_1' });
      await bothSend(RUN, { text: 'second', messageId: 'hm_2' });
      const a = await native.store.messages!(RUN, 50);
      const b = await broker.handlers.runMessages({ runId: RUN, limit: 50 });
      expect(b).toEqual(a);
      expect(b.map((m) => m.messageId)).toEqual(['hm_2', 'hm_1']);
      // The limit is honoured, and omitting it is not "everything".
      expect(await broker.handlers.runMessages({ runId: RUN, limit: 1 })).toEqual(await native.store.messages!(RUN, 1));
      expect(await broker.handlers.runMessages({ runId: RUN })).toEqual(await native.store.messages!(RUN, 50));
    });

    it('typedEvents — the named types, in log order, and nothing else', async () => {
      await bothDriver(RUN, { gesture: 'takeover', by: HUMAN });
      const query = { types: ['run.created', 'driver.changed'], limit: 10 };
      const a = await native.store.typedEvents!(RUN, query);
      const b = await broker.handlers.runTypedEvents({ runId: RUN, query });
      expect(b).toEqual(a);
      expect(b.map((e) => e.type)).toEqual(['run.created', 'driver.changed']);
      expect(await broker.handlers.runTypedEvents({ runId: RUN, query: { types: ['run.created'], limit: 10 } }))
        .toEqual(await native.store.typedEvents!(RUN, { types: ['run.created'], limit: 10 }));
    });

    it('unansweredEvents — the anti-join behind "queued but not delivered"', async () => {
      await bothSend(RUN, { text: 'first', messageId: 'hm_1' });
      await bothSend(RUN, { text: 'second', messageId: 'hm_2' });
      const query = { askType: 'message.queued', answerType: 'message.delivered', correlationKey: 'messageId', limit: 10 };
      const a = await native.store.unansweredEvents!(RUN, query);
      const b = await broker.handlers.runUnansweredEvents({ runId: RUN, query });
      expect(b).toEqual(a);
      expect(b).toHaveLength(2);

      // Answer one through each side's OWN general write — the native binding's `appendEvent`, the
      // child's `runAppend` — and the anti-join has to drop it on both.
      const delivered = { actor: { kind: 'daemon' as const }, type: 'message.delivered', payload: { messageId: 'hm_1' } };
      await native.store.appendEvent!(RUN, delivered);
      await broker.handlers.runAppend({ runId: RUN, event: delivered });
      const after = await broker.handlers.runUnansweredEvents({ runId: RUN, query });
      expect(after).toEqual(await native.store.unansweredEvents!(RUN, query));
      expect(after.map((e) => (e.payload as { messageId: string }).messageId)).toEqual(['hm_2']);
    });

    it('interruptTrigger — the ONE oldest unconsumed trigger, or nothing', async () => {
      expect(await broker.handlers.runInterruptTrigger({ runId: RUN, caller: CLI_BADGE }))
        .toEqual(await native.store.interruptTrigger!(RUN, CLI_BADGE));

      await bothDriver(RUN, { gesture: 'takeover', by: HUMAN, reason: 'taking over' });
      const a = await native.store.interruptTrigger!(RUN, CLI_BADGE);
      const b = await broker.handlers.runInterruptTrigger({ runId: RUN, caller: CLI_BADGE });
      expect(b).toEqual(a);
      expect(b).toMatchObject({ type: 'driver.changed' });

      // A caller the takeover was not FROM is owed nothing, and the two bindings agree on that too.
      expect(await broker.handlers.runInterruptTrigger({ runId: RUN, caller: { name: 'someone-else', version: '1.0.0' } }))
        .toEqual(await native.store.interruptTrigger!(RUN, { name: 'someone-else', version: '1.0.0' }));
    });
  });

  describe('the writes carry their committed envelope out of the process', () => {
    /**
     * The child's in-process bus has no subscribers in the child, so `deps.onRunEvent` is the only
     * way a `driver.changed` or a `message.queued` row reaches the host's live tail. Without it the
     * write commits and every watching surface hears nothing — §7 rows 2 and 3 have a gesture that
     * leaves no trace, and `queued → delivered at step N → acknowledged` starts invisibly.
     */
    it('a driver gesture surfaces every event it committed, with the seqs the answer names', async () => {
      const result = await broker.handlers.runDriver({ runId: RUN, input: { gesture: 'release', by: CLI } });
      const committed = (result as { events: RunEvent[] }).events;
      expect(committed.map((e) => e.type)).toEqual(['driver.changed', 'run.paused']);
      expect(broker.events).toEqual(committed.map((event) => ({ runId: RUN, event })));
    });

    it('a queued message surfaces the row its state line is folded from', async () => {
      const result = await broker.handlers.runSendMessage({ runId: RUN, input: { text: 'hello', messageId: 'hm_x' } });
      const event = (result as { event: RunEvent }).event;
      expect(broker.events).toEqual([{ runId: RUN, event }]);
      expect(event.type).toBe('message.queued');
    });

    it('publishes nothing when nothing was committed — a refusal has no tail', async () => {
      await broker.handlers.runDriver({ runId: RUN, input: { gesture: 'release', by: SDK } });
      await broker.handlers.runSendMessage({ runId: RUN, input: { text: '  ' } });
      expect(broker.events).toEqual([]);
    });
  });

  describe('the wire', () => {
    /**
     * Every answer crosses newline-delimited JSON, so a handle, a class instance or a function in
     * one would arrive as `{}` — silently, and only in the app. Compared against the value itself
     * rather than merely parsed, because `JSON.parse(JSON.stringify(x))` succeeds on the lossy
     * cases too.
     */
    it('every answer survives a JSON round-trip unchanged', async () => {
      await broker.handlers.runSendMessage({ runId: RUN, input: { text: 'first', messageId: 'hm_1' } });
      const answers: unknown[] = [
        await broker.handlers.runDriver({ runId: RUN, input: { gesture: 'takeover', by: HUMAN } }),
        await broker.handlers.runDriver({ runId: RUN, input: { gesture: 'release', by: SDK } }),
        await broker.handlers.runSendMessage({ runId: RUN, input: { text: 'second', messageId: 'hm_2' } }),
        await broker.handlers.runSendMessage({ runId: RUN, input: { text: '   ' } }),
        await broker.handlers.runMessages({ runId: RUN, limit: 50 }),
        await broker.handlers.runTypedEvents({ runId: RUN, query: { types: ['message.queued'], limit: 10 } }),
        await broker.handlers.runUnansweredEvents({ runId: RUN, query: { askType: 'message.queued', answerType: 'message.delivered', correlationKey: 'messageId', limit: 10 } }),
        await broker.handlers.runInterruptTrigger({ runId: RUN, caller: CLI_BADGE }),
      ];
      expect(answers).toHaveLength(8);
      for (const answer of answers) {
        expect(JSON.parse(JSON.stringify(answer ?? null))).toEqual(answer ?? null);
      }
    });

    it('all six are own-properties of the dispatch map, under the names the port members map to', () => {
      // `Object.hasOwn` is the lookup the RPC loop itself makes, so a handler reachable only through
      // the prototype chain is not reachable at all. The list is declared here rather than derived
      // from the map: a derived one would agree with a rename, which is the change this catches.
      for (const [member, method] of SIX) {
        expect(Object.hasOwn(broker.handlers, method), `${member} → ${method}`).toBe(true);
        expect(typeof (broker.handlers as unknown as Record<string, unknown>)[method]).toBe('function');
      }
      expect(Object.hasOwn(broker.handlers, 'constructor')).toBe(false);
    });

    it('leaves the native binding alone — the daemon path still has all nine members', () => {
      for (const member of ['create', 'list', 'get', 'exists', 'eventsSince', ...SIX.map(([m]) => m), 'appendEvent', 'subscribeEvents']) {
        expect(typeof (native.store as unknown as Record<string, unknown>)[member], member).toBe('function');
      }
    });
  });
});
