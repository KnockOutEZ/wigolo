import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

/**
 * Every emitter has to state a gap policy — there is no default, because a default is what let the
 * live tail write `seq` N+2 straight after N. The rows below have no holes in them, so theirs is to
 * shout: a gap here would mean one of these fixtures grew one, not that the row under test passed.
 */
const noGaps = (from: number, arrivedAt: number): never => {
  throw new Error(`unexpected seq gap on an in-order row: ${from} -> ${arrivedAt}`);
};

describe('run stream ordering — the exactly-once door', () => {
  it('holds a live event that arrives mid-replay until the replay is done', async () => {
    const written: number[] = [];
    const emitter = createOrderedEmitter(0, (e) => written.push(e.seq), { onGap: noGaps });

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
    const emitter = createOrderedEmitter(0, (e) => written.push(e.seq), { onGap: noGaps });

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
    const emitter = createOrderedEmitter(4, (e) => written.push(e.seq), { onGap: noGaps });

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
    const emitter = createOrderedEmitter(0, (e) => written.push(e.seq), { onGap: noGaps, maxHeld: 4 });

    for (const seq of [2, 3, 4, 5]) emitter.offer(ev(seq));
    expect(emitter.overflowed()).toBe(false);
    await emitter.goLive();
    // Exactly at the ceiling is still a delivery, not a drop.
    expect(written).toEqual([2, 3, 4, 5]);
  });

  it('drops the whole hold buffer past the ceiling rather than delivering it with a hole in it', async () => {
    const written: number[] = [];
    const emitter = createOrderedEmitter(0, (e) => written.push(e.seq), { onGap: noGaps, maxHeld: 4 });
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
    const emitter = createOrderedEmitter(0, (e) => written.push(e.seq), { onGap: noGaps, maxHeld: 2 });

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
    const emitter = createOrderedEmitter(0, (e) => written.push(e.seq), { onGap: noGaps });
    emitter.offer(ev(3));
    emitter.offer(ev(2));
    await emitter.goLive();
    expect(written).toEqual([2, 3]);
  });
});

/**
 * WHY: the tail's header promises exactly-once per seq with no holes, and until this door existed it
 * kept only half of that. `emit` accepted ANY `seq > last`, so a live event landing at N+2 after N
 * went straight out and the skipped seq was gone — silently, permanently, with the heartbeat keeping
 * the connection alive so the client never reconnected and never resumed from `Last-Event-ID`.
 *
 * The hole is reachable because the publish chain is not atomic: an event is committed and THEN
 * notified, so a writer that dies between the two — or a client-side buffer drop — loses the notify
 * for an event that is durably in the log. A lost `run.completed` is the worst shape of it: every
 * consumer of that stream believes the run is still going, forever.
 *
 * These rows drive the emitter directly because the interleave is what matters and a live-wire test
 * cannot force which notify goes missing.
 */
describe('the live tail detects a seq gap and refuses to write a hole', () => {
  interface Gap { from: number; arrivedAt: number }

  function live(since = 0, opts: { maxHeld?: number; maxBytes?: number } = {}): {
    emitter: ReturnType<typeof createOrderedEmitter>;
    written: number[];
    gaps: Gap[];
  } {
    const written: number[] = [];
    const gaps: Gap[] = [];
    const emitter = createOrderedEmitter(since, (e) => written.push(e.seq), {
      onGap: (from, arrivedAt) => gaps.push({ from, arrivedAt }),
      ...opts,
    });
    return { emitter, written, gaps };
  }

  it('does not write a live event that skips a seq, and reports where the hole is', async () => {
    const { emitter, written, gaps } = live();
    emitter.emit(ev(1));
    await emitter.goLive();

    // The notify for seq 2 never arrived. Seq 3 is the first anyone hears about it.
    emitter.offer(ev(3));

    expect(written).toEqual([1]);
    expect(gaps).toEqual([{ from: 1, arrivedAt: 3 }]);
    expect(emitter.lastEmitted()).toBe(1);
  });

  it('holds everything behind the hole instead of racing the healer onto the wire', async () => {
    const { emitter, written, gaps } = live();
    emitter.emit(ev(1));
    await emitter.goLive();

    emitter.offer(ev(3));
    // The run keeps working while the heal reads the log. None of this may overtake seq 2.
    emitter.offer(ev(4));
    emitter.offer(ev(5));

    expect(written).toEqual([1]);
    // One hole, one report: the events behind it are queued, not four more alarms.
    expect(gaps).toHaveLength(1);
  });

  it('fills the hole from the durable log and then continues in order, exactly once per seq', async () => {
    const { emitter, written, gaps } = live();
    emitter.emit(ev(1));
    await emitter.goLive();

    emitter.offer(ev(3));
    emitter.offer(ev(4));
    expect(gaps).toEqual([{ from: 1, arrivedAt: 3 }]);

    // What the healer does: re-read the durable log from `from`, through the same door. Seqs 3 and 4
    // are in that read too, and the monotone guard is what stops them being delivered twice.
    for (const seq of [2, 3, 4]) emitter.emit(ev(seq));
    await emitter.goLive();

    expect(written).toEqual([1, 2, 3, 4]);
    expect(emitter.lastEmitted()).toBe(4);
    // Live again afterwards, with no second alarm for a hole that has been filled.
    emitter.offer(ev(5));
    expect(written).toEqual([1, 2, 3, 4, 5]);
    expect(gaps).toHaveLength(1);
  });

  it('reports the whole hole, not just its first seq — a crashed writer can lose several notifies', async () => {
    const { emitter, gaps } = live();
    emitter.emit(ev(4));
    await emitter.goLive();

    emitter.offer(ev(9));

    expect(gaps).toEqual([{ from: 4, arrivedAt: 9 }]);
  });

  it('a second hole after a heal is its own alarm', async () => {
    const { emitter, written, gaps } = live();
    emitter.emit(ev(1));
    await emitter.goLive();

    emitter.offer(ev(3));
    emitter.emit(ev(2));
    emitter.emit(ev(3));
    await emitter.goLive();
    expect(written).toEqual([1, 2, 3]);

    emitter.offer(ev(7));
    expect(written).toEqual([1, 2, 3]);
    expect(gaps).toEqual([{ from: 1, arrivedAt: 3 }, { from: 3, arrivedAt: 7 }]);
  });

  /**
   * The in-order path is the one every healthy tail is on. A door that fires on it would turn every
   * run into a stream of unnecessary store reads, so it is pinned as tightly as the hole is.
   */
  it('never fires on the in-order path, on a duplicate, or below the resume point', async () => {
    const { emitter, written, gaps } = live(4);

    for (const seq of [2, 3, 4]) emitter.emit(ev(seq)); // at or below the resume point
    emitter.emit(ev(5));
    emitter.emit(ev(6));
    await emitter.goLive();
    emitter.offer(ev(6)); // the reconnect overlap, replayed and published
    emitter.offer(ev(7));
    emitter.offer(ev(8));

    expect(written).toEqual([5, 6, 7, 8]);
    expect(gaps).toEqual([]);
  });

  /**
   * The replay pages the durable log in seq order by construction, so a gap there is the store's
   * own, not a lost notify — and a heal would re-read the same rows, find the same gap and end a
   * healthy stream. The door is the LIVE phase's, and the hold buffer is where a replay-window
   * arrival waits.
   */
  it('stays out of the replay and its flush — a held event is not a live one', async () => {
    const { emitter, written, gaps } = live();

    emitter.emit(ev(1));
    emitter.offer(ev(3)); // arrived while the replay was still paging: held, not judged
    emitter.emit(ev(2));
    await emitter.goLive();

    expect(written).toEqual([1, 2, 3]);
    expect(gaps).toEqual([]);
  });

  /**
   * A heal is a second replay, and the events arriving during one grow this daemon's heap the way
   * the events arriving during the first one do. It spends the SAME ceiling, and overflows the same
   * way — dropped whole, so the caller ends the stream rather than delivering a buffer with a second
   * hole in it.
   */
  it('spends the hold ceiling while it waits, and overflows into the existing door', async () => {
    const { emitter, written } = live(0, { maxHeld: 3 });
    emitter.emit(ev(1));
    await emitter.goLive();

    emitter.offer(ev(3));
    expect(emitter.overflowed()).toBe(false);
    for (let seq = 4; seq <= 40; seq++) emitter.offer(ev(seq));

    expect(emitter.overflowed()).toBe(true);
    await emitter.goLive();
    expect(written).toEqual([1]);
  });
});

/**
 * WHY: the live door above is exposed BY an arrival, and the flush is the phase where no arrival can
 * expose anything — `replaying` is still true for the whole of `goLive`, so a hold buffer that itself
 * has a hole in it (a notify lost in the window between the replay's last page and the flush) was
 * written out whole, hole and all, by the one path whose entire job is ordering.
 *
 * Two things make this its own door rather than a term dropped from `emit`'s:
 *
 *  - Dropping `!replaying` OOMs the process. `emit`'s door RE-HOLDS the event that tripped it, and
 *    `goLive`'s drain-to-empty loop re-splices and re-emits that same event forever.
 *  - `seq > last + 1` is not the predicate here. During the flush `last` may still be the resume
 *    point rather than a seq this stream delivered, so a pruned log — `?since=0` against a log whose
 *    first row is seq 5 — would read as a hole and end a perfectly healthy stream.
 */
describe('the go-live flush refuses to write a hole that is inside the hold buffer', () => {
  interface Gap { from: number; arrivedAt: number }

  function tail(since = 0, opts: { maxHeld?: number } = {}): {
    emitter: ReturnType<typeof createOrderedEmitter>;
    written: number[];
    gaps: Gap[];
  } {
    const written: number[] = [];
    const gaps: Gap[] = [];
    const emitter = createOrderedEmitter(since, (e) => written.push(e.seq), {
      onGap: (from, arrivedAt) => gaps.push({ from, arrivedAt }),
      ...opts,
    });
    return { emitter, written, gaps };
  }

  it('stops at the hole instead of flushing across it, and reports where it is', async () => {
    const { emitter, written, gaps } = tail();
    // The replay delivered seq 1. Seq 2's notify was lost in the window before the flush, so what is
    // held is 3 and 4 — a buffer with a hole at its head.
    emitter.emit(ev(1));
    emitter.offer(ev(3));
    emitter.offer(ev(4));

    await emitter.goLive();

    expect(written).toEqual([1]);
    expect(gaps).toEqual([{ from: 1, arrivedAt: 3 }]);
    expect(emitter.lastEmitted()).toBe(1);
  });

  it('finds a hole in the MIDDLE of the buffer, after flushing the part that is contiguous', async () => {
    const { emitter, written, gaps } = tail();
    emitter.emit(ev(1));
    emitter.offer(ev(2));
    emitter.offer(ev(3));
    emitter.offer(ev(6)); // 4 and 5 lost their notifies

    await emitter.goLive();

    expect(written).toEqual([1, 2, 3]);
    expect(gaps).toEqual([{ from: 3, arrivedAt: 6 }]);
  });

  it('hands the healer the same state the live door does — everything from the hole is still held', async () => {
    const { emitter, written, gaps } = tail();
    emitter.emit(ev(1));
    emitter.offer(ev(3));
    emitter.offer(ev(4));
    await emitter.goLive();
    expect(gaps).toHaveLength(1);
    expect(emitter.overflowed()).toBe(false);

    // What the healer does: re-read the durable log from `from` through the same door, then flush.
    // Seqs 3 and 4 are in that read AND still in the buffer; the monotone guard is what stops the
    // re-held copies being delivered a second time.
    for (const seq of [2, 3, 4]) emitter.emit(ev(seq));
    await emitter.goLive();

    expect(written).toEqual([1, 2, 3, 4]);
    // Live again afterwards, with no second alarm for a hole that has been filled.
    emitter.offer(ev(5));
    expect(written).toEqual([1, 2, 3, 4, 5]);
    expect(gaps).toHaveLength(1);
  });

  /**
   * The OOM regression, pinned. `emit`'s door re-holds; this one must NOT go back round the
   * drain-to-empty loop and look at the same event again. `pace` counts the passes: the door fires
   * before anything is emitted, so a single hand-off spends zero of them.
   */
  it('hands off once and returns — it does not re-splice the event that tripped it', async () => {
    const { emitter, written, gaps } = tail();
    emitter.emit(ev(1));
    await emitter.goLive();
    emitter.suspend();
    for (const seq of [3, 4, 5, 6]) emitter.offer(ev(seq));

    let passes = 0;
    await emitter.goLive(() => { passes += 1; return true; });

    expect(passes).toBe(0);
    expect(written).toEqual([1]);
    expect(gaps).toEqual([{ from: 1, arrivedAt: 3 }]);
  });

  /**
   * The pruned-log shape, and the reason the predicate is `hasDelivered()` rather than a seq
   * comparison alone. `?since=0` against a log whose first row is seq 5 replays nothing, so `last`
   * is still 0 when the flush starts — and 5 is not a hole, it is the beginning.
   */
  it('does not read the first event of a pruned log as a hole', async () => {
    const { emitter, written, gaps } = tail(0);
    expect(emitter.hasDelivered()).toBe(false);

    emitter.offer(ev(5));
    emitter.offer(ev(6));
    await emitter.goLive();

    expect(written).toEqual([5, 6]);
    expect(gaps).toEqual([]);
  });

  /**
   * Same predicate, the other shape it protects: a reconnect whose next event has not committed yet,
   * so the replay delivers nothing and `last` is the client's resume point. That first held event is
   * deliberately let through — and the live door picks the stream up from there, which is what makes
   * letting it through safe rather than a second hole.
   */
  it('does not read a resumed stream\'s first held event as a hole, and the live door covers it after', async () => {
    const { emitter, written, gaps } = tail(4);
    expect(emitter.lastEmitted()).toBe(4);
    expect(emitter.hasDelivered()).toBe(false);

    emitter.offer(ev(9));
    await emitter.goLive();
    expect(written).toEqual([9]);
    expect(gaps).toEqual([]);
    expect(emitter.hasDelivered()).toBe(true);

    emitter.offer(ev(11));
    expect(written).toEqual([9]);
    expect(gaps).toEqual([{ from: 9, arrivedAt: 11 }]);
  });

  /**
   * Re-holding can blow the ceiling — the buffer grew while the flush was running. Overflow is the
   * existing door and it answers the same way: dropped whole, and the caller ends the stream.
   */
  it('overflowing while it re-holds is the existing overflow door, not a partial flush', async () => {
    const { emitter, written, gaps } = tail(0, { maxHeld: 4 });
    emitter.emit(ev(1));
    // Contiguous up to 3, then a hole. The run keeps appending DURING the flush — that is what makes
    // the buffer too full to take the tail of itself back, and it is the only way here is reachable.
    for (const seq of [2, 3, 6, 7]) emitter.offer(ev(seq));

    let storm = 8;
    await emitter.goLive(() => {
      for (let i = 0; i < 2; i++) emitter.offer(ev(storm++));
      return true;
    });

    expect(written).toEqual([1, 2, 3]);
    expect(gaps).toEqual([{ from: 3, arrivedAt: 6 }]);
    // Dropped whole. The caller's `goLiveOrEnd` sees this and ends the stream, so the client resumes
    // from `Last-Event-ID` — never half a buffer delivered with a hole where the rest was.
    expect(emitter.overflowed()).toBe(true);
  });

  /**
   * `suspend` is what the silence reconcile uses to put a LIVE emitter back into holding before it
   * reads the log — the gap door does the same thing from inside `emit`, but a reconcile has no
   * arriving event to do it from.
   */
  it('suspend puts a live emitter back into holding, and is a no-op on one that already is', async () => {
    const { emitter, written } = tail();
    emitter.emit(ev(1));
    await emitter.goLive();
    emitter.offer(ev(2));
    expect(written).toEqual([1, 2]); // live: offered events go straight out

    emitter.suspend();
    emitter.suspend(); // idempotent — a caller need not know which phase it is in
    emitter.offer(ev(3));
    expect(written).toEqual([1, 2]);

    await emitter.goLive();
    expect(written).toEqual([1, 2, 3]);
  });

  it('reports delivery separately from the resume point — lastEmitted cannot answer it', () => {
    const { emitter } = tail(4);
    expect(emitter.lastEmitted()).toBe(4);
    expect(emitter.hasDelivered()).toBe(false);
    emitter.emit(ev(5));
    expect(emitter.hasDelivered()).toBe(true);
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
    const emitter = createOrderedEmitter(0, (e) => written.push(e.seq), { onGap: noGaps, maxHeld: 10_000, maxBytes: 10_000 });
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
    const emitter = createOrderedEmitter(0, (e) => written.push(e.seq), { onGap: noGaps, maxHeld: 10_000, maxBytes: 10_000 });

    emitter.offer(big(2));
    emitter.offer(big(3));

    expect(emitter.overflowed()).toBe(false);
    await emitter.goLive();
    expect(written).toEqual([2, 3]);
  });

  it('starts each replay window from zero bytes, so a delivered buffer is not charged twice', async () => {
    const written: number[] = [];
    const emitter = createOrderedEmitter(0, (e) => written.push(e.seq), { onGap: noGaps, maxHeld: 10_000, maxBytes: 10_000 });

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

/**
 * WHY: this route's whole bound on the daemon's heap was a count. The hold buffer wrote down that a
 * count bounds the wrong thing — an event payload is capped at 64k, so N events is 64N kilobytes and
 * the count never notices — and then applied that reasoning only to itself. Every other writer on
 * the stream kept counting items or nothing at all: replay checked drain once per PAGE (500 events,
 * so up to ~32 MB handed to a socket that already said it was full), the `goLive` flush handed over
 * the entire hold buffer in one burst at the moment the socket is most likely fullest, the live
 * emitter recorded `needsDrain` and nothing ever read it, and the heartbeat wrote unconditionally.
 *
 * A reader that simply stops reading is not exotic — a paused tab, a suspended laptop, a `curl` into
 * a full pipe — and each of these turns it into per-tail heap growth for as long as the run emits.
 * Every row below FORCES the stall rather than hoping for it: the response accepts nothing until the
 * test says so, which is the only way these bounds are observable at all.
 */
describe('SSE writes are bounded in bytes on every path, not only between replay pages', () => {
  const KNOBS = ['WIGOLO_STUDIO_SSE_FLUSH_BYTES', 'WIGOLO_STUDIO_SSE_MAX_STALLED_BYTES'] as const;
  let saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved = {};
    for (const k of KNOBS) saved[k] = process.env[k];
  });

  afterEach(() => {
    for (const k of KNOBS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  /** ~1 KiB of payload, so a frame is a round number of bytes to reason about a budget in. */
  function bulky(seq: number): RunEvent {
    return {
      seq,
      ts: '2026-08-22T14:00:00.000Z',
      actor: { kind: 'daemon' },
      type: 'run.note',
      payload: { text: 'x'.repeat(1000) },
    };
  }

  /**
   * A response that accepts nothing until the test lets it — the forced condition these rows turn
   * on. `write` returning false is exactly what a socket whose peer stopped reading does, and
   * everything after it lives in this process's heap.
   */
  function stalledExchange(): {
    req: IncomingMessage;
    res: ServerResponse;
    frames: () => string[];
    bytes: () => number;
    ended: () => boolean;
    drain: () => void;
  } {
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    const written: string[] = [];
    let bytes = 0;
    let ended = false;
    let accept = false;

    const on = (event: string, fn: (...args: unknown[]) => void): unknown => {
      const list = listeners.get(event) ?? [];
      list.push(fn);
      listeners.set(event, list);
      return undefined;
    };
    const off = (event: string, fn: (...args: unknown[]) => void): unknown => {
      listeners.set(event, (listeners.get(event) ?? []).filter((f) => f !== fn));
      return undefined;
    };
    const fire = (event: string): void => { for (const fn of [...(listeners.get(event) ?? [])]) fn(); };

    const req = {
      headers: {},
      destroyed: false,
      socket: { setTimeout: () => {} },
      on,
      off,
    } as unknown as IncomingMessage;

    const res = {
      destroyed: false,
      headersSent: false,
      setTimeout: () => {},
      writeHead: () => {},
      flushHeaders: () => {},
      write: (chunk: string) => {
        written.push(chunk);
        bytes += Buffer.byteLength(chunk);
        return accept;
      },
      end: () => { ended = true; },
      on,
      off,
    } as unknown as ServerResponse;

    return {
      req,
      res,
      frames: () => written.filter((c) => c.startsWith('id: ')),
      bytes: () => bytes,
      ended: () => ended,
      drain: () => { accept = true; fire('drain'); },
    };
  }

  function tailWith(
    ex: { req: IncomingMessage; res: ServerResponse },
    store: RunsStore,
    id = '7fq2',
  ): Promise<void> {
    return import('../../../src/daemon/rest/runs.js').then(({ handleRunsRequest }) =>
      handleRunsRequest(ex.req, ex.res, {
        pathname: `/v1/runs/${id}/events`,
        method: 'GET',
        url: new URL(`http://127.0.0.1/v1/runs/${id}/events`),
        respond: () => {},
        sendError: () => {},
        store,
      }));
  }

  /** Let the handler's awaits settle. Macrotasks, because the replay yields with `setImmediate`. */
  async function settle(turns = 12): Promise<void> {
    for (let i = 0; i < turns; i++) await new Promise<void>((r) => setImmediate(r));
  }

  it('stops mid-PAGE once the replay has handed over its byte budget, not at the page boundary', async () => {
    // A budget two frames wide against a page twenty frames long: a gate that only runs between
    // pages cannot tell the difference, because this log is exactly one page.
    process.env.WIGOLO_STUDIO_SSE_FLUSH_BYTES = '2000';
    process.env.WIGOLO_STUDIO_SSE_MAX_STALLED_BYTES = String(64 * 1024 * 1024);

    const page = Array.from({ length: 20 }, (_, i) => bulky(i + 1));
    let pages = 0;
    const store: RunsStore = {
      create: async () => { throw new Error('not used'); },
      list: async () => ({ runs: [] }),
      get: async () => undefined,
      exists: async () => true,
      eventsSince: async () => { pages += 1; return pages === 1 ? page : []; },
    };

    const ex = stalledExchange();
    const done = tailWith(ex, store);
    await settle();

    // The load-bearing assertion. Per-page gating writes all twenty here; per-byte gating writes the
    // two that fit the budget and then waits on a socket that has taken nothing.
    expect(ex.frames().length).toBe(2);
    expect(ex.ended()).toBe(false);

    ex.drain();
    await done;
    // And the bound is a pause, not a loss: the whole page is delivered once the socket takes bytes.
    expect(ex.frames().length).toBe(20);
  });

  it('gates the go-live flush on the same budget — the hold buffer is one burst, not one write', async () => {
    process.env.WIGOLO_STUDIO_SSE_FLUSH_BYTES = '2000';
    process.env.WIGOLO_STUDIO_SSE_MAX_STALLED_BYTES = String(64 * 1024 * 1024);

    // The replay parks, which is the window in which live appends are HELD. Ten of them go into the
    // buffer, and the flush that releases them is the single largest write on this route.
    let releaseReplay = (): void => {};
    const parked = new Promise<void>((resolve) => { releaseReplay = resolve; });
    let calls = 0;
    const store: RunsStore = {
      create: async () => { throw new Error('not used'); },
      list: async () => ({ runs: [] }),
      get: async () => undefined,
      exists: async () => true,
      eventsSince: async () => { calls += 1; if (calls === 1) await parked; return []; },
    };

    const ex = stalledExchange();
    const done = tailWith(ex, store, '7fq3');
    await settle(3);
    for (let seq = 1; seq <= 10; seq++) publishRunEvent('7fq3', bulky(seq));
    expect(ex.frames()).toHaveLength(0);

    releaseReplay();
    await settle();

    // Ungated, `goLive` writes all ten before anything looks at the socket.
    expect(ex.frames().length).toBe(2);

    ex.drain();
    await done;
    expect(ex.frames().length).toBe(10);
  });

  it('ends the tail of a reader that stopped reading, rather than buffering the rest of the run', async () => {
    // Small enough to reach in a handful of frames, which is what makes the row deterministic.
    process.env.WIGOLO_STUDIO_SSE_FLUSH_BYTES = String(1024 * 1024);
    process.env.WIGOLO_STUDIO_SSE_MAX_STALLED_BYTES = '4000';

    const store: RunsStore = {
      create: async () => { throw new Error('not used'); },
      list: async () => ({ runs: [] }),
      get: async () => undefined,
      exists: async () => true,
      eventsSince: async () => [],
    };

    const ex = stalledExchange();
    await tailWith(ex, store, '7fq4');
    // Live now: an empty log means the replay and the flush are both no-ops, so every frame below
    // goes out through the live path — the one that recorded `needsDrain` and never read it.
    for (let seq = 1; seq <= 200; seq++) publishRunEvent('7fq4', bulky(seq));

    // The bound, in the unit the heap grows in. Unbounded, this is 200 frames and ~220 KB.
    expect(ex.bytes()).toBeLessThan(4000 + 1200);
    expect(ex.frames().length).toBeLessThan(6);
    // And it ends rather than waiting: law 1 makes the durable log the source of truth, so the
    // client resumes from `Last-Event-ID` and misses nothing.
    expect(ex.ended()).toBe(true);

    const afterEnd = ex.frames().length;
    for (let seq = 201; seq <= 400; seq++) publishRunEvent('7fq4', bulky(seq));
    expect(ex.frames().length).toBe(afterEnd);
  });

  it('does not heartbeat a socket that has not drained — the last writer on a silent stalled tail', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    try {
      const store: RunsStore = {
        create: async () => { throw new Error('not used'); },
        list: async () => ({ runs: [] }),
        get: async () => undefined,
        exists: async () => true,
        eventsSince: async () => [],
      };

      const ex = stalledExchange();
      await tailWith(ex, store, '7fq5');

      // Five intervals on a socket that takes nothing. The first ping is how the timer LEARNS the
      // socket is full; every one after it would be pure growth on a buffer nobody is draining, and
      // on a silent run this timer is the only writer left.
      for (let i = 0; i < 5; i++) vi.advanceTimersByTime(15_000);

      const pings = (ex.bytes() - Buffer.byteLength('retry: 3000\n\n')) / Buffer.byteLength(': ping\n\n');
      expect(pings).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * WHY: every other door on this route is exposed BY an arrival — a seq lands, and its distance from
 * the last one delivered says a notify was lost. A run whose LAST event loses its notify is never
 * followed by another live event, so nothing ever asks the question. The stream stays open, the
 * heartbeat keeps it alive, and every consumer goes on believing a finished run is still running,
 * forever. That is the `run.completed` shape, and it is the one that matters most.
 *
 * So the check has to be driven by SILENCE instead. The heartbeat already fires only when nothing
 * has been written for a full interval, which is exactly the state the hole hides in.
 *
 * These rows drive the route with a fake store because the assertion is about the READ: that an idle
 * tail issues exactly one single-row probe per interval and writes nothing when it comes back empty,
 * and that it issues none at all while a durable read already owns the stream.
 */
describe('the silence reconcile — a lost notify on a run\'s last event', () => {
  const HEARTBEAT = 'WIGOLO_STUDIO_SSE_HEARTBEAT_MS';
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[HEARTBEAT];
    // Short enough that a row is a test rather than a wait. The interval is the stream's only clock,
    // so this is the knob that makes the silence path observable at all.
    process.env[HEARTBEAT] = '30';
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[HEARTBEAT];
    else process.env[HEARTBEAT] = saved;
  });

  interface Read { from: number; limit: number | undefined }

  /** A response that takes every byte, so nothing here is confused with back-pressure. */
  function openExchange(): {
    req: IncomingMessage;
    res: ServerResponse;
    frames: () => string[];
    pings: () => number;
    ended: () => boolean;
    close: () => void;
  } {
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    const written: string[] = [];
    let ended = false;
    const on = (event: string, fn: (...args: unknown[]) => void): unknown => {
      const list = listeners.get(event) ?? [];
      list.push(fn);
      listeners.set(event, list);
      return undefined;
    };
    const off = (event: string, fn: (...args: unknown[]) => void): unknown => {
      listeners.set(event, (listeners.get(event) ?? []).filter((f) => f !== fn));
      return undefined;
    };
    const req = { headers: {}, destroyed: false, socket: { setTimeout: () => {} }, on, off } as unknown as IncomingMessage;
    const res = {
      destroyed: false,
      headersSent: false,
      setTimeout: () => {},
      writeHead: () => {},
      flushHeaders: () => {},
      write: (chunk: string) => { written.push(chunk); return true; },
      end: () => { ended = true; },
      on,
      off,
    } as unknown as ServerResponse;
    return {
      req,
      res,
      frames: () => written.filter((c) => c.startsWith('id: ')),
      pings: () => written.filter((c) => c.startsWith(': ping')).length,
      ended: () => ended,
      close: () => { for (const fn of [...(listeners.get('close') ?? [])]) fn(); },
    };
  }

  /** An in-memory durable log, so a row can append WITHOUT publishing — the lost-notify shape. */
  function fakeStore(log: RunEvent[], reads: Read[], gate?: () => Promise<void>): RunsStore {
    return {
      create: async () => { throw new Error('not used'); },
      list: async () => ({ runs: [] }),
      get: async () => undefined,
      exists: async () => true,
      eventsSince: async (_id: string, cursor: number, limit?: number) => {
        reads.push({ from: cursor, limit });
        if (gate !== undefined) await gate();
        const after = log.filter((e) => e.seq > cursor);
        return limit === undefined ? after : after.slice(0, limit);
      },
    };
  }

  function tail(ex: { req: IncomingMessage; res: ServerResponse }, store: RunsStore, id: string): Promise<void> {
    return import('../../../src/daemon/rest/runs.js').then(({ handleRunsRequest }) =>
      handleRunsRequest(ex.req, ex.res, {
        pathname: `/v1/runs/${id}/events`,
        method: 'GET',
        url: new URL(`http://127.0.0.1/v1/runs/${id}/events`),
        respond: () => {},
        sendError: () => {},
        store,
      }));
  }

  async function until(what: () => boolean, ms = 3000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!what()) {
      if (Date.now() > deadline) throw new Error('condition never held');
      await new Promise<void>((r) => setTimeout(r, 10));
    }
  }

  it('delivers a terminal event whose notify was lost, on a stream nothing else would ever wake', async () => {
    const log = [ev(1, 'run.created')];
    const reads: Read[] = [];
    const ex = openExchange();
    await tail(ex, fakeStore(log, reads), '7fq6');
    await until(() => ex.frames().length === 1);

    // Committed and durable, and NOBODY is told — the broker-crash-between-commit-and-notify shape.
    // Nothing follows it, because it is the run's last event. On the tip behaviour this stream sits
    // at [1] with heartbeats keeping it alive and every watcher believing the run is still going.
    log.push(ev(2, 'run.completed'));

    await until(() => ex.frames().length === 2);
    expect(ex.frames()[1]).toContain('event: run.completed');
    // Healed IN the stream: the client is not asked to reconnect for an event the daemon can read.
    expect(ex.ended()).toBe(false);
    ex.close();
  });

  it('writes nothing when the log has nothing — an idle run with a watcher is the ordinary case', async () => {
    const log = [ev(1, 'run.created')];
    const reads: Read[] = [];
    const ex = openExchange();
    await tail(ex, fakeStore(log, reads), '7fq7');
    await until(() => ex.frames().length === 1);
    const afterReplay = reads.length;

    // Several intervals of nothing happening. The heartbeat proves the clock actually ticked, so
    // "no frame was written" is a statement about the reconcile rather than about a timer that never
    // fired — and the probes prove it looked.
    await until(() => ex.pings() >= 3);

    const probes = reads.slice(afterReplay);
    expect(probes.length).toBeGreaterThanOrEqual(3);
    // One row, from exactly where this stream got to. Not a page, not a projection of the run.
    for (const probe of probes) expect(probe).toEqual({ from: 1, limit: 1 });
    // The whole assertion: it looked, found nothing, and left the wire alone.
    expect(ex.frames().length).toBe(1);
    expect(ex.ended()).toBe(false);
    ex.close();
  });

  it('does not probe while a durable read already owns the stream', async () => {
    const log = [ev(1, 'run.created')];
    const reads: Read[] = [];
    let release = (): void => {};
    const parked = new Promise<void>((resolve) => { release = resolve; });
    let first = true;
    const gate = async (): Promise<void> => {
      if (!first) return;
      first = false;
      await parked;
    };

    const ex = openExchange();
    const done = tail(ex, fakeStore(log, reads, gate), '7fq8');
    // The replay is parked mid-read. Heartbeats go on firing — that is the point — and each one
    // reaches the reconcile, which must decline: a second read across a running one would race the
    // same seqs onto the wire from two places.
    await until(() => ex.pings() >= 3);
    expect(reads.length).toBe(1);

    release();
    await done;
    // And it is a deferral, not a disable: the probe resumes the moment the replay lets go.
    await until(() => reads.length > 1);
    ex.close();
  });
});
