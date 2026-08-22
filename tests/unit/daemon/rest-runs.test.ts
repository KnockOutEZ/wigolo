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
  it('holds a live event that arrives mid-replay until the replay is done', () => {
    const written: number[] = [];
    const emitter = createOrderedEmitter(0, (e) => written.push(e.seq));

    emitter.emit(ev(1));
    // A live append lands while the replay is still paging — it must NOT go out ahead of seq 2.
    emitter.offer(ev(3));
    expect(written).toEqual([1]);

    emitter.emit(ev(2));
    emitter.goLive();
    expect(written).toEqual([1, 2, 3]);
  });

  it('drops a held event the replay already covered — the overlap is a no-op, not a duplicate', () => {
    const written: number[] = [];
    const emitter = createOrderedEmitter(0, (e) => written.push(e.seq));

    emitter.emit(ev(1));
    // The classic race: appended during the yield, so it is BOTH published to us and picked up by
    // the next page's query.
    emitter.offer(ev(2));
    emitter.emit(ev(2));
    emitter.goLive();

    expect(written).toEqual([1, 2]);
    expect(emitter.lastEmitted()).toBe(2);
  });

  it('never re-sends anything at or below the resume point', () => {
    const written: number[] = [];
    const emitter = createOrderedEmitter(4, (e) => written.push(e.seq));

    for (const seq of [2, 3, 4]) emitter.emit(ev(seq));
    expect(written).toEqual([]);

    emitter.emit(ev(5));
    emitter.goLive();
    emitter.offer(ev(5));
    emitter.offer(ev(6));

    expect(written).toEqual([5, 6]);
  });

  it('flushes held events in sequence order even if they were offered out of order', () => {
    const written: number[] = [];
    const emitter = createOrderedEmitter(0, (e) => written.push(e.seq));
    emitter.offer(ev(3));
    emitter.offer(ev(2));
    emitter.goLive();
    expect(written).toEqual([2, 3]);
  });
});

describe('run route parsing', () => {
  it('recognizes exactly the three run shapes', () => {
    expect(parseRunsPath('/v1/runs')).toEqual({ kind: 'collection' });
    expect(parseRunsPath('/v1/runs/')).toEqual({ kind: 'collection' });
    expect(parseRunsPath('/v1/runs/7fq2')).toEqual({ kind: 'item', id: '7fq2' });
    expect(parseRunsPath('/v1/runs/7fq2/events')).toEqual({ kind: 'events', id: '7fq2' });
  });

  it('refuses anything else rather than coercing it to the nearest match', () => {
    expect(parseRunsPath('/v1/runs//events')).toBeNull();
    expect(parseRunsPath('/v1/runs/7fq2/events/extra')).toBeNull();
    expect(parseRunsPath('/v1/runs/7fq2/cancel')).toBeNull();
    expect(parseRunsPath('/v1/runs/7fq2/')).toBeNull();
  });
});

describe('resume point resolution', () => {
  it('prefers Last-Event-ID over ?since= — the header is what a reconnect re-sends by itself', () => {
    expect(resolveSince('7', '2')).toEqual({ ok: true, since: 7 });
    expect(resolveSince(undefined, '2')).toEqual({ ok: true, since: 2 });
    expect(resolveSince('', '2')).toEqual({ ok: true, since: 2 });
    expect(resolveSince(undefined, null)).toEqual({ ok: true, since: 0 });
    expect(resolveSince(['9', '1'], null)).toEqual({ ok: true, since: 9 });
  });

  it('refuses a resume point that is not a non-negative integer', () => {
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

  it('puts every committed envelope on the tail, and stops the moment a subscriber leaves', () => {
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

  it('subscribes case-insensitively, so a tail opened on an id read aloud still receives', () => {
    const seen: number[] = [];
    const run = createRunWithTail(db, { task: 'case' }, { dataDir: dir });
    const off = subscribeRunEvents(run.id.toUpperCase(), (e) => seen.push(e.seq));
    appendRunEventWithTail(db, run.id, { actor: { kind: 'daemon' }, type: 'tab.attached', payload: {} }, { dataDir: dir });
    expect(seen).toEqual([2]);
    off();
  });

  it('one subscriber throwing does not cost the others their event', () => {
    const seen: number[] = [];
    const run = createRunWithTail(db, { task: 'isolate' }, { dataDir: dir });
    const offBad = subscribeRunEvents(run.id, () => { throw new Error('listener blew up'); });
    const offGood = subscribeRunEvents(run.id, (e) => seen.push(e.seq));

    expect(() => appendRunEventWithTail(db, run.id, { actor: { kind: 'daemon' }, type: 'tab.attached', payload: {} }, { dataDir: dir })).not.toThrow();
    expect(seen).toEqual([2]);
    offBad();
    offGood();
  });

  it('publishing to a run nobody is watching is a no-op, not a crash', () => {
    expect(() => publishRunEvent('nobody', ev(1))).not.toThrow();
  });

  it('preserves a caller-supplied onEvent hook instead of replacing it', () => {
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
