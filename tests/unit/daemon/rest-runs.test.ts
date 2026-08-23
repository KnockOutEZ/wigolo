import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyMigrations, _resetMigrationGuard } from '../../../src/cache/migrations/runner.js';
import {
  parseRunsPath,
  resolveSince,
  createOrderedEmitter,
} from '../../../src/daemon/rest/runs.js';
import {
  subscribeRunEvents,
  publishRunEvent,
  runEventListenerCount,
  createRunWithTail,
  appendRunEventWithTail,
} from '../../../src/studio/run-bus.js';
import type { RunEvent } from '../../../src/studio/run-store.js';
import type { RunsStore } from '../../../src/daemon/rest/runs-store.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * WHY: the SSE tail's promise to a client is exactly-once delivery per sequence number across a
 * dropped connection. Two mechanisms make that true and both are invisible from the wire in the
 * happy case — the hold-back that stops a live event overtaking an older replayed one, and the
 * monotone guard that drops a held event the replay already covered. The overlap they handle is
 * real because replay yields to the event loop between pages, so these rows drive the emitter
 * directly and force the interleave a passing end-to-end test would never produce.
 */

function ev(seq: number, type = 'tab.attached'): RunEvent {
  return { seq, ts: `2026-08-22T14:00:0${seq % 10}.000Z`, actor: { kind: 'daemon' }, type, payload: {} };
}

describe('run stream ordering — the exactly-once door', () => {
  it('holds a live event that arrives mid-replay until the replay is done', async () => {
    const written: number[] = [];
    const emitter = createOrderedEmitter(0, (e) => written.push(e.seq));

    emitter.emit(ev(1));
    // A live append lands while the replay is still paging — it must NOT go out ahead of seq 2.
    emitter.offer(ev(3));
    expect(written).toEqual([1]);

    emitter.emit(ev(2));
    await emitter.goLive();
    expect(written).toEqual([1, 2, 3]);
  });

  it('drops a held event the replay already covered — the overlap is a no-op, not a duplicate', async () => {
    const written: number[] = [];
    const emitter = createOrderedEmitter(0, (e) => written.push(e.seq));

    emitter.emit(ev(1));
    // The classic race: appended during the yield, so it is BOTH published to us and picked up by
    // the next page's query.
    emitter.offer(ev(2));
    emitter.emit(ev(2));
    await emitter.goLive();

    expect(written).toEqual([1, 2]);
    expect(emitter.lastEmitted()).toBe(2);
  });

  it('never re-sends anything at or below the resume point', async () => {
    const written: number[] = [];
    const emitter = createOrderedEmitter(4, (e) => written.push(e.seq));

    for (const seq of [2, 3, 4]) emitter.emit(ev(seq));
    expect(written).toEqual([]);

    emitter.emit(ev(5));
    await emitter.goLive();
    emitter.offer(ev(5));
    emitter.offer(ev(6));

    expect(written).toEqual([5, 6]);
  });

  /**
   * WHY: the hold-back is the one place on this route where the daemon's heap grows with something
   * it does not control — a run appending while a long log replays, with the deliberate yield
   * between pages widening the window. The ceiling is what makes that bounded, and DROPPING at the
   * ceiling rather than trimming is what keeps the promise: a trimmed buffer puts a hole in the
   * middle of the stream and calls it delivery, a dropped one ends the stream and sends the client
   * back through the reconnect door it already has.
   */
  it('holds up to the ceiling and no further — the buffer cannot grow with the run', async () => {
    const written: number[] = [];
    const emitter = createOrderedEmitter(0, (e) => written.push(e.seq), 4);

    for (const seq of [2, 3, 4, 5]) emitter.offer(ev(seq));
    expect(emitter.overflowed()).toBe(false);
    await emitter.goLive();
    // Exactly at the ceiling is still a delivery, not a drop.
    expect(written).toEqual([2, 3, 4, 5]);
  });

  it('drops the whole hold buffer past the ceiling rather than delivering it with a hole in it', async () => {
    const written: number[] = [];
    const emitter = createOrderedEmitter(0, (e) => written.push(e.seq), 4);
    emitter.emit(ev(1));

    for (let seq = 2; seq <= 40; seq++) emitter.offer(ev(seq));

    expect(emitter.overflowed()).toBe(true);
    await emitter.goLive();
    // Nothing from the storm goes out: whatever the buffer was holding is gone, and the caller's
    // answer to `overflowed()` is to end the stream so the client replays the gap from the log.
    expect(written).toEqual([1]);
    expect(emitter.lastEmitted()).toBe(1);
  });

  it('does not spend the ceiling on events the replay has already covered', async () => {
    const written: number[] = [];
    const emitter = createOrderedEmitter(0, (e) => written.push(e.seq), 2);

    // The overlap window, at volume: every one of these is both published to us and visible to the
    // next page's query. Holding them would burn the ceiling on events `goLive` drops anyway — so a
    // storm the replay is KEEPING UP with must not be mistaken for one that outran it.
    for (let seq = 1; seq <= 50; seq++) {
      emitter.emit(ev(seq));
      emitter.offer(ev(seq));
    }

    expect(emitter.overflowed()).toBe(false);
    await emitter.goLive();
    expect(written).toHaveLength(50);
  });

  it('flushes held events in sequence order even if they were offered out of order', async () => {
    const written: number[] = [];
    const emitter = createOrderedEmitter(0, (e) => written.push(e.seq));
    emitter.offer(ev(3));
    emitter.offer(ev(2));
    await emitter.goLive();
    expect(written).toEqual([2, 3]);
  });
});

/**
 * WHY: a byte budget beside the count is not belt-and-braces — the count bounds the wrong quantity.
 * An event payload is capped at 64k characters, so 2048 held events is a ~128 MB hold buffer per
 * tail that the count is perfectly happy with, and a tail is opened by anyone who can authenticate.
 * The overflow BEHAVIOUR has to be identical whichever ceiling trips, because a client cannot tell
 * the two apart and its only correct response — reconnect and replay the gap — is the same.
 */
describe('the hold buffer is bounded in bytes as well as in events', () => {
  const big = (seq: number): RunEvent => ({
    seq,
    ts: '2026-08-22T14:00:00.000Z',
    actor: { kind: 'daemon' },
    type: 'run.note',
    payload: { text: 'x'.repeat(4000) },
  });

  it('drops the buffer on bytes even when the event count is nowhere near its ceiling', async () => {
    const written: number[] = [];
    // A count ceiling this high can never trip in this row: only the byte budget can end it.
    const emitter = createOrderedEmitter(0, (e) => written.push(e.seq), 10_000, 10_000);
    emitter.emit(ev(1));

    for (let seq = 2; seq <= 6; seq++) emitter.offer(big(seq));

    expect(emitter.overflowed()).toBe(true);
    await emitter.goLive();
    // Identical to the count overflow: nothing partial goes out, and the caller ends the stream so
    // the client resumes from the durable log.
    expect(written).toEqual([1]);
    expect(emitter.lastEmitted()).toBe(1);
  });

  it('delivers a buffer that fits the budget — the bound is a ceiling, not a tax on every tail', async () => {
    const written: number[] = [];
    const emitter = createOrderedEmitter(0, (e) => written.push(e.seq), 10_000, 10_000);

    emitter.offer(big(2));
    emitter.offer(big(3));

    expect(emitter.overflowed()).toBe(false);
    await emitter.goLive();
    expect(written).toEqual([2, 3]);
  });

  it('starts each replay window from zero bytes, so a delivered buffer is not charged twice', async () => {
    const written: number[] = [];
    const emitter = createOrderedEmitter(0, (e) => written.push(e.seq), 10_000, 10_000);

    emitter.offer(big(2));
    await emitter.goLive();
    // Live now: nothing is held, so a long-lived tail cannot accumulate its way into a false
    // overflow on events it already wrote.
    for (let seq = 3; seq <= 20; seq++) emitter.offer(big(seq));

    expect(emitter.overflowed()).toBe(false);
    expect(written).toHaveLength(19);
  });
});

/**
 * WHY: the events route is the single surface that escapes the router's slot and deadline
 * discipline, on the stated reasoning that its own connection cap bounds it instead. That was true
 * only of an ESTABLISHED stream. The cap used to be checked after the ownership resolve (a
 * synchronous handle read) and after `store.exists` — which on the studio host is a broker RPC that
 * holds a pending-map entry for up to the call timeout — and the 404 for an id that does not exist
 * returned BEFORE the check and so was never metered at all. An authenticated caller could buy K
 * concurrent owner resolves and K broker round-trips for the price of K sockets.
 */
describe('the SSE connection cap meters the whole request, not just the established stream', () => {
  const MISSING_ID = 'c29x';
  let previousCap: string | undefined;

  function spyStore(overrides: Partial<RunsStore> = {}): { store: RunsStore; calls: string[] } {
    const calls: string[] = [];
    const store: RunsStore = {
      create: async () => { calls.push('create'); throw new Error('not used'); },
      list: async () => { calls.push('list'); return { runs: [] }; },
      get: async () => { calls.push('get'); return undefined; },
      exists: async (id) => { calls.push(`exists:${id}`); return false; },
      eventsSince: async () => { calls.push('eventsSince'); return []; },
      ...overrides,
    };
    return { store, calls };
  }

  function exchange(): { req: IncomingMessage; res: ServerResponse; close: () => void } {
    const closers: Array<() => void> = [];
    const req = {
      headers: {},
      destroyed: false,
      socket: { setTimeout: () => {} },
      on: (event: string, fn: () => void) => { if (event === 'close') closers.push(fn); },
    } as unknown as IncomingMessage;
    const res = {
      destroyed: false,
      headersSent: false,
      setTimeout: () => {},
      writeHead: () => {},
      flushHeaders: () => {},
      write: () => true,
      end: () => {},
      on: (event: string, fn: () => void) => { if (event === 'close') closers.push(fn); },
      off: () => {},
    } as unknown as ServerResponse;
    return { req, res, close: () => { for (const fn of closers) fn(); } };
  }

  async function tail(
    id: string,
    store: RunsStore,
    statuses: number[],
  ): Promise<{ done: Promise<void>; close: () => void }> {
    const { handleRunsRequest } = await import('../../../src/daemon/rest/runs.js');
    const ex = exchange();
    const done = handleRunsRequest(ex.req, ex.res, {
      pathname: `/v1/runs/${id}/events`,
      method: 'GET',
      url: new URL(`http://127.0.0.1/v1/runs/${id}/events`),
      respond: () => {},
      sendError: (e) => { statuses.push(e.status); },
      store,
    });
    return { done, close: ex.close };
  }

  beforeEach(() => {
    previousCap = process.env.WIGOLO_STUDIO_SSE_MAX_CONNECTIONS;
    process.env.WIGOLO_STUDIO_SSE_MAX_CONNECTIONS = '2';
  });

  afterEach(() => {
    if (previousCap === undefined) delete process.env.WIGOLO_STUDIO_SSE_MAX_CONNECTIONS;
    else process.env.WIGOLO_STUDIO_SSE_MAX_CONNECTIONS = previousCap;
  });

  it('refuses the request past the cap BEFORE it reaches the store — a miss costs a slot too', async () => {
    const { openRunStreamCount } = await import('../../../src/daemon/rest/runs.js');
    const before = openRunStreamCount();
    let releaseExists = (): void => {};
    const gate = new Promise<void>((resolve) => { releaseExists = resolve; });
    // The broker RPC, forced: `exists` is in flight for as long as the test wants it to be, which is
    // exactly the window the old ordering left unmetered.
    const { store, calls } = spyStore({ exists: async (id) => { calls.push(`exists:${id}`); await gate; return false; } });

    const statuses: number[] = [];
    const held = [await tail(MISSING_ID, store, statuses), await tail(MISSING_ID, store, statuses)];
    // Let both reach the store and park there.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(calls).toEqual([`exists:${MISSING_ID}`, `exists:${MISSING_ID}`]);
    expect(openRunStreamCount()).toBe(before + 2);

    const refused: number[] = [];
    const third = await tail(MISSING_ID, store, refused);
    await third.done;

    expect(refused).toEqual([429]);
    // The load-bearing assertion: the refusal did not spend a store round-trip. Asserting only the
    // status would pass just as well if the cap moved back behind `exists`.
    expect(calls).toHaveLength(2);

    releaseExists();
    await Promise.all(held.map((h) => h.done));
    expect(statuses).toEqual([404, 404]);
    // And a miss gives its slot back, or K typo'd urls would 429 the surface for good.
    expect(openRunStreamCount()).toBe(before);
  });

  it('counts established tails and refuses a miss against them — one meter, not two', async () => {
    const { openRunStreamCount } = await import('../../../src/daemon/rest/runs.js');
    const before = openRunStreamCount();
    const { store, calls } = spyStore({ exists: async (id) => { calls.push(`exists:${id}`); return true; } });

    const opened = [await tail('7fq2', store, []), await tail('7fq2', store, [])];
    await Promise.all(opened.map((o) => o.done));
    expect(openRunStreamCount()).toBe(before + 2);

    const callsAfterOpen = calls.length;
    const refused: number[] = [];
    const miss = await tail(MISSING_ID, store, refused);
    await miss.done;

    expect(refused).toEqual([429]);
    expect(calls).toHaveLength(callsAfterOpen);

    for (const o of opened) o.close();
    expect(openRunStreamCount()).toBe(before);
  });

  /**
   * WHY: a process is handed a bound store only by the host that owns it (the desktop gateway passes
   * its broker-backed store), so the ownership answer is `local` by construction. Resolving it there
   * is a synchronous handle read plus an interface enumeration per request to re-derive a constant —
   * on the event loop that every other request shares.
   */
  it('does not resolve ownership at all when the store is bound', async () => {
    const { handleRunsRequest } = await import('../../../src/daemon/rest/runs.js');
    const { store } = spyStore({ get: async () => undefined });
    let resolves = 0;

    const statuses: number[] = [];
    await handleRunsRequest(exchange().req, exchange().res, {
      pathname: '/v1/runs/7fq2',
      method: 'GET',
      url: new URL('http://127.0.0.1/v1/runs/7fq2'),
      respond: () => {},
      sendError: (e) => { statuses.push(e.status); },
      store,
      resolveOwner: () => { resolves++; return { kind: 'local' }; },
    });

    expect(resolves).toBe(0);
    expect(statuses).toEqual([404]);
  });
});

describe('run route parsing', () => {
  it('recognizes exactly the three run shapes', async () => {
    expect(parseRunsPath('/v1/runs')).toEqual({ kind: 'collection' });
    expect(parseRunsPath('/v1/runs/')).toEqual({ kind: 'collection' });
    expect(parseRunsPath('/v1/runs/7fq2')).toEqual({ kind: 'item', id: '7fq2' });
    expect(parseRunsPath('/v1/runs/7fq2/events')).toEqual({ kind: 'events', id: '7fq2' });
  });

  it('refuses anything else rather than coercing it to the nearest match', async () => {
    expect(parseRunsPath('/v1/runs//events')).toBeNull();
    expect(parseRunsPath('/v1/runs/7fq2/events/extra')).toBeNull();
    expect(parseRunsPath('/v1/runs/7fq2/cancel')).toBeNull();
    expect(parseRunsPath('/v1/runs/7fq2/')).toBeNull();
  });
});

describe('resume point resolution', () => {
  it('prefers Last-Event-ID over ?since= — the header is what a reconnect re-sends by itself', async () => {
    expect(resolveSince('7', '2')).toEqual({ ok: true, since: 7 });
    expect(resolveSince(undefined, '2')).toEqual({ ok: true, since: 2 });
    expect(resolveSince('', '2')).toEqual({ ok: true, since: 2 });
    expect(resolveSince(undefined, null)).toEqual({ ok: true, since: 0 });
    expect(resolveSince(['9', '1'], null)).toEqual({ ok: true, since: 9 });
  });

  it('refuses a resume point that is not a non-negative integer', async () => {
    expect(resolveSince(undefined, '-1').ok).toBe(false);
    expect(resolveSince(undefined, '1.5').ok).toBe(false);
    expect(resolveSince('banana', null).ok).toBe(false);
    expect(resolveSince(undefined, 'NaN').ok).toBe(false);
  });
});

describe('a client that aborts before the stream is set up', () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wigolo-rest-runs-abort-'));
    _resetMigrationGuard();
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyMigrations(db, { vecLoaded: false });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * The handler reaches its close handlers across two awaits — the router's dynamic import of this
   * module and the store resolve. A client that gave up during either has ALREADY emitted 'close',
   * so those handlers never fire, and `res.write` on a destroyed response emits no 'error' either.
   *
   * Every lost race used to be permanent: a leaked connection slot (32 of them and the route 429s
   * for the life of the process), a bus listener holding a dead response, and a self-re-arming
   * timer. This drives exactly that shape.
   */
  it('leaks no connection slot, no listener and no timer', async () => {
    const { handleRunsRequest, openRunStreamCount } = await import('../../../src/daemon/rest/runs.js');
    const run = createRunWithTail(db, { task: 'abort me' }, { dataDir: dir });

    const before = openRunStreamCount();
    const writes: string[] = [];
    // A request and response that are already dead by the time the handler gets to them, and whose
    // 'close' fired while the handler was still awaiting.
    const req = {
      headers: {},
      destroyed: true,
      socket: { setTimeout: () => {} },
      on: () => {},
    } as unknown as import('node:http').IncomingMessage;
    let ended = false;
    const res = {
      destroyed: true,
      setTimeout: () => {},
      writeHead: () => {},
      flushHeaders: () => {},
      write: (chunk: string) => { writes.push(chunk); return true; },
      end: () => { ended = true; },
      on: () => {},
      off: () => {},
    } as unknown as import('node:http').ServerResponse;

    await handleRunsRequest(req, res, {
      pathname: `/v1/runs/${run.id}/events`,
      method: 'GET',
      url: new URL(`http://127.0.0.1/v1/runs/${run.id}/events`),
      respond: () => {},
      sendError: () => {},
      openDb: () => db,
      // Pinned, not defaulted: ownership now resolves from the published studio handle, and the
      // default reads the DEVELOPER's `~/.wigolo/studio/current.json`. Left ambient, this row would
      // take the proxy path — and pass or fail on whether the app happened to be open.
      resolveOwner: () => ({ kind: 'local' }),
    });

    expect(openRunStreamCount()).toBe(before);
    expect(runEventListenerCount(run.id)).toBe(0);
    expect(ended).toBe(true);

    // Nothing further reaches the dead socket either: appending must not write to it.
    const writesAfterSetup = writes.length;
    appendRunEventWithTail(db, run.id, { actor: { kind: 'daemon' }, type: 'tab.attached', payload: {} }, { dataDir: dir });
    expect(writes.length).toBe(writesAfterSetup);
  });
});

describe('input bounds on create', () => {
  it('caps the fields that get persisted twice, not just the one the spec named', async () => {
    const { MAX_SPACE_ID_CHARS, MAX_CLIENT_FIELD_CHARS } = await import('../../../src/daemon/rest/runs.js');
    // `task` had a documented cap; `spaceId` and the client strings did not, and all three are
    // written into the event log AND the run's events.jsonl. An uncapped one is a disk-fill
    // primitive bounded only by the 1 MiB body cap.
    expect(MAX_SPACE_ID_CHARS).toBeLessThanOrEqual(1000);
    expect(MAX_CLIENT_FIELD_CHARS).toBeLessThanOrEqual(1000);
  });
});

describe('the live tail bus', () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wigolo-rest-runs-unit-'));
    _resetMigrationGuard();
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyMigrations(db, { vecLoaded: false });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('puts every committed envelope on the tail, and stops the moment a subscriber leaves', async () => {
    const seen: RunEvent[] = [];
    const run = createRunWithTail(db, { task: 'tail me' }, { dataDir: dir });

    const off = subscribeRunEvents(run.id, (e) => seen.push(e));
    appendRunEventWithTail(db, run.id, { actor: { kind: 'agent', driver: 'cli' }, type: 'tab.attached', payload: { tabId: 't1' } }, { dataDir: dir });
    expect(seen.map((e) => e.seq)).toEqual([2]);

    off();
    expect(runEventListenerCount(run.id)).toBe(0);
    appendRunEventWithTail(db, run.id, { actor: { kind: 'daemon' }, type: 'run.completed', payload: {} }, { dataDir: dir });
    expect(seen.map((e) => e.seq)).toEqual([2]);
  });

  it('subscribes case-insensitively, so a tail opened on an id read aloud still receives', async () => {
    const seen: number[] = [];
    const run = createRunWithTail(db, { task: 'case' }, { dataDir: dir });
    const off = subscribeRunEvents(run.id.toUpperCase(), (e) => seen.push(e.seq));
    appendRunEventWithTail(db, run.id, { actor: { kind: 'daemon' }, type: 'tab.attached', payload: {} }, { dataDir: dir });
    expect(seen).toEqual([2]);
    off();
  });

  it('one subscriber throwing does not cost the others their event', async () => {
    const seen: number[] = [];
    const run = createRunWithTail(db, { task: 'isolate' }, { dataDir: dir });
    const offBad = subscribeRunEvents(run.id, () => { throw new Error('listener blew up'); });
    const offGood = subscribeRunEvents(run.id, (e) => seen.push(e.seq));

    expect(() => appendRunEventWithTail(db, run.id, { actor: { kind: 'daemon' }, type: 'tab.attached', payload: {} }, { dataDir: dir })).not.toThrow();
    expect(seen).toEqual([2]);
    offBad();
    offGood();
  });

  it('publishing to a run nobody is watching is a no-op, not a crash', async () => {
    expect(() => publishRunEvent('nobody', ev(1))).not.toThrow();
  });

  it('preserves a caller-supplied onEvent hook instead of replacing it', async () => {
    const viaHook: number[] = [];
    const viaBus: number[] = [];
    const run = createRunWithTail(db, { task: 'both hooks' }, { dataDir: dir, onEvent: (_id, e) => viaHook.push(e.seq) });
    const off = subscribeRunEvents(run.id, (e) => viaBus.push(e.seq));
    appendRunEventWithTail(db, run.id, { actor: { kind: 'daemon' }, type: 'tab.attached', payload: {} }, { dataDir: dir, onEvent: (_id, e) => viaHook.push(e.seq) });
    expect(viaHook).toEqual([1, 2]);
    expect(viaBus).toEqual([2]);
    off();
  });
});
