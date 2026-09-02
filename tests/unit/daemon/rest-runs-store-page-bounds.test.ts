import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type Database from 'better-sqlite3';
import { resetConfig } from '../../../src/config.js';
import { initDatabase, getDatabase, closeDatabase } from '../../../src/cache/db.js';
import { MAX_EVENT_PAYLOAD_CHARS, MAX_EVENTS_PAGE, MAX_EVENTS_PAGE_CHARS } from '../../../src/studio/run-store.js';
import { sqliteRunsStore, type RunsStore } from '../../../src/daemon/rest/runs-store.js';
import { handleRunsRequest } from '../../../src/daemon/rest/runs.js';
import type { RunEvent } from '../../../src/studio/run-store.js';

/**
 * SD1 exit-19 — the DAEMON binding of the replay read, bounded in both units.
 *
 * The broker binding has had a row clamp AND a character clamp since PX0, with the argument written
 * down: a count alone bounds the wrong thing, because one payload may be `MAX_EVENT_PAYLOAD_CHARS`
 * (64k) and a page of rows says nothing about how many of those it contains. The daemon binding —
 * the one that serves every standalone replay, on the daemon's own event loop, with no child process
 * between it and the socket — had the count and nothing else. So `GET /v1/runs/{id}/events` at the
 * route's own default page of 500 rows read and `JSON.parse`d ~32 MB in ONE uninterruptible
 * synchronous block, and `WIGOLO_STUDIO_RUN_REPLAY_PAGE` had no ceiling, so an operator could make
 * that block the whole log.
 *
 * These rows run against a REAL SQLite handle through `sqliteRunsStore`, because the defect was
 * exactly that the port's two bindings disagreed and no fixture store can show that: a fake honours
 * whatever limit it is handed, which is the behaviour the daemon binding wrongly had.
 *
 * The companion rows in `rest-runs.test.ts` ('replay stops on an EMPTY page, never on a short one')
 * pin the OTHER half of the contract this clamp depends on, with a fake store that clamps below the
 * ask. Adding a clamp is only compatible because of that rule, so the two files are one argument:
 * there the reader must not stop on a short page, here the store is now allowed to produce one.
 */

/** A payload the store accepts and cannot accept much more of — one maximal legal envelope. */
const MAXIMAL_PAYLOAD_CHARS = MAX_EVENT_PAYLOAD_CHARS - 200;

/**
 * Enough maximal envelopes to overrun the character budget three times over.
 *
 * Three, not one: a log that only just crosses the budget cannot tell a clamp that split correctly
 * from one that happened to stop at the end of the log, and two full pages leave no page that is
 * neither the first nor the last — which is exactly where a lost or repeated event would hide.
 */
const FAT_LOG_EVENTS = Math.ceil((MAX_EVENTS_PAGE_CHARS * 3) / MAXIMAL_PAYLOAD_CHARS);

/**
 * The most one clamped page may measure: the budget, plus the single event that trips it.
 *
 * The tripping event is INSIDE the page on purpose — a clamp that could answer nothing would end a
 * replay in the middle of a run, since every paged reader on this route reads an empty page as
 * end-of-log. So "budget plus one maximal event" is the contract, stated here as a number.
 */
const ADMISSIBLE_PAGE_CHARS = MAX_EVENTS_PAGE_CHARS + MAX_EVENT_PAYLOAD_CHARS;

interface SeedEvent {
  type: string;
  payload: Record<string, unknown>;
}

/**
 * Grow a run's log by the same INSERT the store makes.
 *
 * Not `appendRunEvent` in a loop: forcing a real character budget needs millions of characters, and
 * each append is its own IMMEDIATE transaction plus a status fold, for rows that are identical
 * either way.
 */
function bulkInsert(db: Database.Database, runId: string, events: readonly SeedEvent[]): number {
  const head = db.prepare('SELECT last_seq FROM studio_runs WHERE id = ?').get(runId) as { last_seq: number };
  const insert = db.prepare('INSERT INTO studio_run_events (run_id, seq, ts, actor, type, payload) VALUES (?, ?, ?, ?, ?, ?)');
  const actor = JSON.stringify({ kind: 'agent' });
  const ts = new Date(Date.UTC(2026, 0, 1)).toISOString();
  let seq = head.last_seq;
  db.transaction(() => {
    for (const e of events) {
      seq += 1;
      insert.run(runId, seq, ts, actor, e.type, JSON.stringify(e.payload));
    }
    db.prepare('UPDATE studio_runs SET last_seq = ? WHERE id = ?').run(seq, runId);
  })();
  return seq;
}

function fatEvents(count: number): SeedEvent[] {
  return Array.from({ length: count }, (_, i) => ({
    type: 'run.progress',
    payload: { i, blob: 'x'.repeat(MAXIMAL_PAYLOAD_CHARS) },
  }));
}

function tinyEvents(count: number): SeedEvent[] {
  return Array.from({ length: count }, (_, i) => ({ type: 'run.progress', payload: { i } }));
}

describe('the daemon runs-store binding bounds a replay page in rows AND characters', () => {
  const originalEnv = process.env;
  let dir: string;
  let store: RunsStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wigolo-daemon-page-bounds-'));
    process.env = { ...originalEnv, LOG_LEVEL: 'error', WIGOLO_DATA_DIR: dir };
    resetConfig();
    initDatabase(':memory:');
    store = sqliteRunsStore(getDatabase());
  });

  afterEach(() => {
    closeDatabase();
    process.env = originalEnv;
    resetConfig();
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * The finding itself: near-maximal payloads, a page asked for in rows, a page bounded in bytes.
   *
   * Shown able to fail: lifting the clamp in `runs-store.ts` (binding `eventsSince` directly again)
   * reds the character assertion at 12,081,018 against a 4,064,000 budget on this fixture alone — and
   * this fixture is 189 events where the route's default page is 500, i.e. the ~32 MB read the issue
   * names. The row assertion above it stays green at that size, which is the finding restated: a row
   * count cannot see this.
   */
  it('splits a page of near-maximal payloads at the character bound, not at the row limit', async () => {
    const run = await store.create({ task: 'a fat log' });
    const lastSeq = bulkInsert(getDatabase(), run.id, fatEvents(FAT_LOG_EVENTS));

    // What the route's own default replay asks for. Every one of those rows exists.
    const page = await store.eventsSince(run.id, 0, 500);

    expect(
      page.length,
      'the page came back at the row count asked for — the read is bounded in rows only, so its size ' +
      'is whatever the payloads happen to be, and at this log that is a ~32 MB synchronous read on ' +
      "the daemon's event loop",
    ).toBeLessThan(500);
    expect(page.length, 'a clamped page came back EMPTY — every reader on this route reads that as end-of-log').toBeGreaterThan(0);
    expect(
      JSON.stringify(page).length,
      'one page now exceeds the budget by more than the single event that trips it',
    ).toBeLessThanOrEqual(ADMISSIBLE_PAGE_CHARS);

    // A SHORT page is not end-of-log, and the clamp is only compatible because that is true.
    const next = await store.eventsSince(run.id, page[page.length - 1].seq, 500);
    expect(next.length, 'the log continues, so the page after a byte-tripped one must not be empty').toBeGreaterThan(0);
    expect(next[0].seq, 'the next page resumed somewhere other than the seq after the last one delivered').toBe(page[page.length - 1].seq + 1);
    expect(lastSeq, 'the fixture did not actually produce a multi-page log').toBeGreaterThan(page.length + next.length);
  });

  /**
   * The whole point of a bound that produces short pages: paging through it must lose nothing.
   *
   * Drains the log the way `pumpDurable` does — stop on an EMPTY page, never a short one — and
   * asserts the drained seqs are exactly `1..lastSeq` with no hole, no repeat and no early stop.
   */
  it('a reader that pages to an EMPTY page recovers every event of a char-split log', async () => {
    const run = await store.create({ task: 'drained' });
    const lastSeq = bulkInsert(getDatabase(), run.id, fatEvents(FAT_LOG_EVENTS));

    const seqs: number[] = [];
    let pages = 0;
    for (let cursor = 0; ; ) {
      const page = await store.eventsSince(run.id, cursor, 500);
      if (page.length === 0) break;
      pages += 1;
      for (const e of page) seqs.push(e.seq);
      cursor = page[page.length - 1].seq;
      expect(pages, 'the drain is not advancing — a store that ignored `since` would page forever').toBeLessThan(100);
    }

    expect(pages, 'the log did not split, so this run proves nothing about a split one').toBeGreaterThan(2);
    expect(seqs, 'the drain lost, duplicated or reordered events across the char-bound page splits')
      .toEqual(Array.from({ length: lastSeq }, (_, i) => i + 1));
  });

  /**
   * The row clamp, on the binding that did not have one, against the ask the env knob permits.
   *
   * `WIGOLO_STUDIO_RUN_REPLAY_PAGE` is an integer with no upper bound, so "the whole log in one
   * synchronous read" was a supported configuration. It is now unreachable FROM a caller: the store
   * refuses it whatever the caller asks for.
   */
  it('refuses an unbounded row ask, however large, on the store itself', async () => {
    const run = await store.create({ task: 'many small rows' });
    bulkInsert(getDatabase(), run.id, tinyEvents(MAX_EVENTS_PAGE + 500));

    const page = await store.eventsSince(run.id, 0, 1_000_000_000);

    expect(page.length, 'the store handed back more rows than its own per-page row ceiling allows').toBeLessThanOrEqual(MAX_EVENTS_PAGE);
    expect(page.length, 'the row clamp did not trip at all — the fixture is not larger than the ceiling').toBe(MAX_EVENTS_PAGE);
  });

  /** A non-positive or nonsense ask is not a licence to read the whole log. */
  it('answers an unusable limit with an empty page rather than an unbounded read', async () => {
    const run = await store.create({ task: 'bad ask' });
    bulkInsert(getDatabase(), run.id, tinyEvents(10));

    expect(await store.eventsSince(run.id, 0, 0)).toEqual([]);
    expect(await store.eventsSince(run.id, 0, -1)).toEqual([]);
    expect(await store.eventsSince(run.id, 0, Number.NaN)).toEqual([]);
  });
});

/**
 * The route's half: `replayPageSize()` is clamped, so the ask itself can no longer be unbounded.
 *
 * The store would refuse an oversized ask anyway, which is why this is about honesty rather than
 * safety — an ask the store will ALWAYS cut makes every page short, and a short page is the one
 * shape this route must never read as end-of-log. Driven through the real handler with a recording
 * store, because `replayPageSize` is not exported and the number that matters is the one that
 * reaches the port.
 */
describe('replayPageSize is clamped to the store ceiling', () => {
  const PAGE = 'WIGOLO_STUDIO_RUN_REPLAY_PAGE';
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[PAGE];
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[PAGE];
    else process.env[PAGE] = saved;
  });

  /** A response that takes every byte, so nothing here is confused with back-pressure. */
  function recordingTail(log: readonly RunEvent[]): { asked: number[]; run: () => Promise<void> } {
    const asked: number[] = [];
    const noop = (): unknown => undefined;
    const req = { headers: {}, destroyed: false, socket: { setTimeout: () => {} }, on: noop, off: noop } as unknown as IncomingMessage;
    const res = {
      destroyed: false,
      headersSent: false,
      setTimeout: () => {},
      writeHead: () => {},
      flushHeaders: () => {},
      write: () => true,
      end: () => {},
      on: noop,
      off: noop,
    } as unknown as ServerResponse;
    const store: RunsStore = {
      create: async () => { throw new Error('not used'); },
      list: async () => ({ runs: [] }),
      get: async () => undefined,
      exists: async () => true,
      eventsSince: async (_id, cursor, limit) => {
        asked.push(limit);
        return log.filter((e) => e.seq > cursor);
      },
    };
    return {
      asked,
      run: () => handleRunsRequest(req, res, {
        pathname: '/v1/runs/7fq8/events',
        method: 'GET',
        url: new URL('http://127.0.0.1/v1/runs/7fq8/events'),
        respond: () => {},
        sendError: () => {},
        store,
      }),
    };
  }

  const oneEvent: RunEvent[] = [{ seq: 1, ts: '2026-08-22T14:00:00.000Z', actor: { kind: 'daemon' }, type: 'tab.attached', payload: {} }];

  it('never asks the store for more rows than the store will ever return', async () => {
    process.env[PAGE] = String(MAX_EVENTS_PAGE * 1_000);
    const tail = recordingTail(oneEvent);
    await tail.run();

    expect(tail.asked.length, 'the replay never reached the store').toBeGreaterThan(0);
    expect(
      Math.max(...tail.asked),
      'the route still asks for a page the store cannot serve — the env knob buys an ask that is ' +
      'silently cut on every page instead of a page the operator can reason about',
    ).toBeLessThanOrEqual(MAX_EVENTS_PAGE);
  });

  /** Below the ceiling the knob still does exactly what it says — the clamp is a ceiling, not a rewrite. */
  it('leaves an ask below the ceiling alone', async () => {
    process.env[PAGE] = '7';
    const tail = recordingTail(oneEvent);
    await tail.run();

    expect(tail.asked[0]).toBe(7);
  });
});

// The suite must not leak a mocked clock or module into the files that follow it.
afterEach(() => {
  vi.restoreAllMocks();
});
