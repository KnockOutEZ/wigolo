import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { SearchEngine } from '../../src/types.js';
import type { SmartRouter } from '../../src/fetch/router.js';
import { resetConfig } from '../../src/config.js';
import { initDatabase, getDatabase, closeDatabase } from '../../src/cache/db.js';
import {
  createBrokerHandlers,
  MAX_BOOT_EVENTS_PER_RUN,
  MAX_BOOT_FRAME_CHARS,
} from '../../src/daemon/studio-db-broker.js';

/**
 * SD1 perf (F4, F6) — the two reads the Electron host makes across the broker pipe that used to cost
 * more than the question they ask.
 *
 * The host holds no native handle: every read is a stdio round-trip, and whatever the child answers
 * with is JSON-serialized both ways. So the shape of an answer is a cost, not a detail — `runList`
 * returns projected `Run`s the host recomputes anyway, and `runGet` replays a whole log to say whether
 * a run exists. These rows pin the two cheaper reads against a REAL store, with the SQL the child
 * actually issues as the instrument: an assertion about the returned value cannot see which tables
 * were read to produce it.
 */

/** Records the SQL the store issues, so "bounded" is a checkable claim rather than a comment. */
function recordingDb(db: Database.Database, sql: string[]): Database.Database {
  return new Proxy(db, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === 'prepare' && typeof value === 'function') {
        return (query: string) => {
          sql.push(query);
          return (value as Database.Database['prepare']).call(target, query);
        };
      }
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

interface ReadRecord { sql: string; rows: number; chars: number }

/**
 * Records what each read EXECUTION returned, not what was prepared.
 *
 * `recordingDb` sees `prepare`, and the store caches one statement per SQL string per handle — so a
 * read issued fifty times appears once. That is enough to ask WHICH table a read touched and useless
 * for asking HOW MUCH it moved, which is the whole question a budget is about. This wraps the
 * statement instead and counts the rows and the payload characters each `all()` actually returned.
 */
function countingDb(db: Database.Database, reads: ReadRecord[]): Database.Database {
  return new Proxy(db, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === 'prepare' && typeof value === 'function') {
        return (query: string) => {
          const prepared = (value as Database.Database['prepare']).call(target, query);
          return new Proxy(prepared, {
            get(stTarget, stProp, stReceiver) {
              const stValue = Reflect.get(stTarget, stProp, stReceiver);
              if (stProp === 'all' && typeof stValue === 'function') {
                return (...args: unknown[]) => {
                  const rows = (stValue as (...a: unknown[]) => unknown[]).apply(stTarget, args);
                  const chars = rows.reduce<number>((n, r) => {
                    const payload = (r as { payload?: unknown }).payload;
                    return n + (typeof payload === 'string' ? payload.length : 0);
                  }, 0);
                  reads.push({ sql: query, rows: rows.length, chars });
                  return rows;
                };
              }
              return typeof stValue === 'function'
                ? (stValue as (...a: unknown[]) => unknown).bind(stTarget)
                : stValue;
            },
          });
        };
      }
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/**
 * Grow a run's log to a size the caps are about, by the same INSERT the store makes.
 *
 * Not `runAppend` in a loop: the shipped per-run cap is two thousand envelopes, and each append is
 * its own IMMEDIATE transaction plus a status fold, so forcing the real constant that way costs
 * seconds per arm. The rows are identical to the ones the store writes, and `last_seq` is advanced
 * with them so a later append cannot collide.
 */
function bulkAppend(
  db: Database.Database,
  runId: string,
  count: number,
  make: (i: number) => { type: string; payload: Record<string, unknown> },
): number {
  const head = db.prepare('SELECT last_seq FROM studio_runs WHERE id = ?').get(runId) as { last_seq: number };
  const insert = db.prepare('INSERT INTO studio_run_events (run_id, seq, ts, actor, type, payload) VALUES (?, ?, ?, ?, ?, ?)');
  const actor = JSON.stringify({ kind: 'agent' });
  let seq = head.last_seq;
  db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const { type, payload } = make(i);
      seq += 1;
      insert.run(runId, seq, new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), actor, type, JSON.stringify(payload));
    }
    db.prepare('UPDATE studio_runs SET last_seq = ? WHERE id = ?').run(seq, runId);
  })();
  return seq;
}

describe('studio-db-broker — the host-side run reads are bounded', () => {
  const originalEnv = process.env;
  const mockSearchEngine: SearchEngine = { name: 'mock', search: vi.fn().mockResolvedValue([]) };
  const mockRouter = { fetch: vi.fn() } as unknown as SmartRouter;

  let dir: string;
  let sql: string[];
  let handlers: ReturnType<typeof createBrokerHandlers>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wigolo-broker-run-reads-'));
    process.env = { ...originalEnv, LOG_LEVEL: 'error', WIGOLO_DATA_DIR: dir };
    resetConfig();
    initDatabase(':memory:');
    sql = [];
    handlers = createBrokerHandlers({
      db: recordingDb(getDatabase(), sql),
      engines: [mockSearchEngine],
      router: mockRouter,
      backendStatus: undefined,
      onArtifact: () => {},
    });
  });

  afterEach(() => {
    closeDatabase();
    process.env = originalEnv;
    resetConfig();
    rmSync(dir, { recursive: true, force: true });
  });

  // F6. Same question, two costs: `runGet` replays the log to answer it, `runExists` asks the key.
  it('answers existence off the run key, never off the event log', async () => {
    const run = await handlers.runCreate({ input: { task: 'a long one' } });
    for (let i = 0; i < 40; i++) {
      await handlers.runAppend({ runId: run.id, event: { actor: { kind: 'agent' }, type: 'run.progress', payload: { i } } });
    }

    sql.length = 0;
    expect(await handlers.runExists({ runId: run.id })).toBe(true);
    expect(sql.join(' ')).toContain('FROM studio_runs');
    expect(sql.join(' '), 'existence read the log it exists to avoid reading').not.toContain('studio_run_events');

    sql.length = 0;
    expect(await handlers.runGet({ runId: run.id })).toBeDefined();
    // The control: the projection DOES read the log, which is why `exists` must not go through it.
    expect(sql.join(' ')).toContain('studio_run_events');

    expect(await handlers.runExists({ runId: 'nosuchrun' })).toBe(false);
  });

  // F4. One call for the whole boot page, carrying facts+events and nothing the host recomputes.
  it('returns facts and events together for the page, without the projections the host rebuilds', async () => {
    const a = await handlers.runCreate({ input: { task: 'first', sessionId: 'sess-a' } });
    const b = await handlers.runCreate({ input: { task: 'second' } });
    await handlers.runAppend({ runId: a.id, event: { actor: { kind: 'agent' }, type: 'tab.attached', payload: { tabId: 'tab-1' } } });

    const { entries } = await handlers.runListLogs({});

    expect(entries.map((l) => l.facts.id).sort()).toEqual([a.id, b.id].sort());
    const first = entries.find((l) => l.facts.id === a.id)!;
    // Exactly the stored facts — a projected `Run` here would be the duplication this read removes.
    expect(Object.keys(first.facts).sort()).toEqual(['createdAt', 'id', 'spaceId', 'task']);
    expect(first.facts.task).toBe('first');
    // The WHOLE log, not the projection subset: the host folds later envelopes on by seq, so a page
    // that skipped a non-projection event would hand it a log with a hole at the first append.
    expect(first.events.map((e) => [e.seq, e.type])).toEqual([[1, 'run.created'], [2, 'tab.attached']]);
    expect(first.events[0].payload.sessionId).toBe('sess-a');
    // The true tail, on every entry — the host rejects stale envelopes and detects gaps against it.
    expect(first.lastSeq).toBe(2);
    // A run that fits carries no projection: sending one would be the duplication this read removes.
    expect(first.projection).toBeUndefined();
    expect(entries.find((l) => l.facts.id === b.id)!.events.map((e) => e.type)).toEqual(['run.created']);
  });

  it('pages the combined read exactly as the listing does, and hands back the cursor that continues it', async () => {
    for (let i = 0; i < 3; i++) await handlers.runCreate({ input: { task: `run ${i}` } });

    const page = await handlers.runListLogs({ limit: 2 });
    const listed = await handlers.runList({ limit: 2 });

    expect(page.entries.map((l) => l.facts.id)).toEqual(listed.runs.map((r) => r.id));
    expect(page.entries).toHaveLength(2);
    // Without this the host's boot took the first page and stopped, and a machine with more runs
    // than one page booted the app missing every run past it.
    expect(page.nextCursor).toBe(listed.nextCursor);

    const rest = await handlers.runListLogs({ limit: 2, cursor: page.nextCursor });
    expect(rest.entries).toHaveLength(1);
    expect(rest.nextCursor).toBeUndefined();
    const all = [...page.entries, ...rest.entries].map((e) => e.facts.task);
    expect(all.sort()).toEqual(['run 0', 'run 1', 'run 2']);
  });

  /**
   * MED-2 / perf #5 — the boot read moved UNBOUNDED payloads as single stdio frames.
   *
   * `runListLogs` mapped the fifty-run page to a full `eventsSince(id, 0)` per run and
   * `JSON.stringify`d the lot into ONE newline-delimited line, which the host accumulates as one JS
   * string and parses synchronously on the thread that paints. Fifty long-lived runs of tens of
   * thousands of envelopes is hundreds of megabytes of that, at startup, with no fallback.
   *
   * Both arms FORCE the shipped constants rather than sampling near them: they build the log the
   * cap is about, by the same INSERT the store makes, and assert the read stopped.
   */
  it('sends a projection instead of a log too long for one frame, with the run’s true tail seq', async () => {
    const run = await handlers.runCreate({ input: { task: 'a very long run', sessionId: 'sess-long' } });
    await handlers.runAppend({ runId: run.id, event: { actor: { kind: 'agent' }, type: 'tab.attached', payload: { tabId: 'tab-1' } } });
    const tail = bulkAppend(getDatabase(), run.id, MAX_BOOT_EVENTS_PER_RUN, () => ({ type: 'run.progress', payload: { note: 'x' } }));

    sql.length = 0;
    const { entries } = await handlers.runListLogs({});
    const entry = entries.find((e) => e.facts.id === run.id)!;

    expect(entry.lastSeq, 'the cap is not reached, so this arm proves nothing').toBeGreaterThan(MAX_BOOT_EVENTS_PER_RUN);
    expect(entry.events, 'the whole log crossed the pipe in one frame').toEqual([]);
    // …and the answer is not degraded: it is the same projection REST gives for the same run.
    expect(entry.projection).toEqual(await handlers.runGet({ runId: run.id }));
    expect(entry.projection!.tabIds).toEqual(['tab-1']);
    // The tail seq is the STORE's, not the truncated read's — this is what stops the host treating
    // the next live envelope as a hole and replaying a run that missed nothing.
    expect(entry.lastSeq).toBe(tail);
    // The session link normally rides on the `run.created` envelope, which is not in this entry.
    expect(entry.sessionId).toBe('sess-long');
    // The instrument: an assertion about the returned value cannot see how many rows were read.
    const unbounded = sql.filter((q) => q.includes('FROM studio_run_events') && q.includes('seq > ?') && !q.includes('LIMIT'));
    expect(unbounded, 'the capped read still asked the log for every row it has').toEqual([]);
  });

  it('stops sending logs once the page’s character budget is spent, and keeps answering', async () => {
    const big = 'y'.repeat(50_000);
    const wide = await handlers.runCreate({ input: { task: 'wide payloads' } });
    // Few events, enormous ones: a count is not a size, which is why the bound is stated in both.
    const rows = Math.ceil(MAX_BOOT_FRAME_CHARS / big.length) + 2;
    bulkAppend(getDatabase(), wide.id, rows, () => ({ type: 'run.progress', payload: { blob: big } }));
    const small = await handlers.runCreate({ input: { task: 'ordinary' } });

    const { entries } = await handlers.runListLogs({});
    const wideEntry = entries.find((e) => e.facts.id === wide.id)!;
    const smallEntry = entries.find((e) => e.facts.id === small.id)!;

    expect(rows, 'the run is under the EVENT cap, so only the char cap can be doing the work').toBeLessThan(MAX_BOOT_EVENTS_PER_RUN);
    expect(wideEntry.events).toEqual([]);
    expect(wideEntry.projection).toBeDefined();
    expect(JSON.stringify(entries).length).toBeLessThan(MAX_BOOT_FRAME_CHARS);
    // The budget is spent by one run, not by the page: a small run beside it still comes whole.
    expect(smallEntry.events.map((e) => e.type)).toEqual(['run.created']);
    expect(smallEntry.projection).toBeUndefined();
  });

  /**
   * MED-1 — the char budget was charged when a log was ACCEPTED, and a rejected one cost the same
   * read for nothing.
   *
   * The event bound is decided from the listing row, before a row is read. The char bound was not:
   * the only way to learn a log's serialized size was to MATERIALIZE it — up to two thousand rows,
   * `JSON.parse` per payload, `JSON.stringify` over the array — and a run that then failed the check
   * returned its projection WITHOUT decrementing either budget. So `charsLeft` was still the full
   * four million for the next run on the page, which read itself in full to fail the same way. A page
   * of fifty five-megabyte runs read, parsed and re-serialized a quarter of a gigabyte to answer with
   * fifty projections a few hundred bytes each, and the next hydration page did it again.
   *
   * The read count is the instrument. The returned page looks IDENTICAL before and after — same
   * projections, same tail seqs — so an assertion about the answer cannot see the defect at all.
   */
  it('spends the frame budget on the run that read it, so one rejection does not re-read the page', async () => {
    const big = 'z'.repeat(50_000);
    // Each run alone overruns the whole page's char budget, and every one of them is under the EVENT
    // cap — so the char check is the only thing that can be rejecting them.
    const rowsPerRun = Math.ceil(MAX_BOOT_FRAME_CHARS / big.length) + 2;
    expect(rowsPerRun).toBeLessThan(MAX_BOOT_EVENTS_PER_RUN);
    const oversized = 5;
    for (let i = 0; i < oversized; i++) {
      const run = await handlers.runCreate({ input: { task: `oversized ${i}`, sessionId: `sess-${i}` } });
      bulkAppend(getDatabase(), run.id, rowsPerRun, () => ({ type: 'run.progress', payload: { blob: big } }));
    }

    const reads: ReadRecord[] = [];
    const counted = createBrokerHandlers({
      db: countingDb(getDatabase(), reads),
      engines: [mockSearchEngine],
      router: mockRouter,
      backendStatus: undefined,
      onArtifact: () => {},
    });
    const { entries } = await counted.runListLogs({});

    // The answer is unchanged: every run is condensed, and carries what a condensed entry owes.
    expect(entries).toHaveLength(oversized);
    for (const entry of entries) {
      expect(entry.events).toEqual([]);
      expect(entry.projection).toBeDefined();
      expect(entry.lastSeq).toBe(rowsPerRun + 1);
      expect(entry.sessionId).toMatch(/^sess-\d$/);
    }

    // The log read — `eventsSince` is the only one shaped `seq > ?`; the projection's per-type reads
    // are not. A rejected run must not have materialized its log, so the only one left is the
    // one-row session link a condensed entry needs.
    const logReads = reads.filter((r) => r.sql.includes('FROM studio_run_events') && r.sql.includes('seq > ?'));
    const materialized = logReads.filter((r) => r.rows > 1);
    expect(materialized.map((r) => r.rows), 'a run rejected on size still read its whole log').toEqual([]);

    // …and the bytes, across EVERY event read the page made: the page cannot move more characters
    // than the frame it is bounding. Before this, the five runs moved five full logs — five times it.
    const charsRead = reads
      .filter((r) => r.sql.includes('FROM studio_run_events'))
      .reduce((n, r) => n + r.chars, 0);
    expect(charsRead, 'the page read more than the frame budget it exists to enforce')
      .toBeLessThan(MAX_BOOT_FRAME_CHARS);
  });

  /**
   * The other half of MED-1, and the one the SUM cannot reach.
   *
   * The pre-read estimate is deliberately a LOWER bound — it counts stored payload characters and not
   * the `seq`, `ts`, `actor` and `type` the frame also carries — because an estimate that could
   * OVER-state would condense runs that fit, and the accepted path has to stay exactly what it was.
   * The cost of that soundness is a band: a run whose payloads sit just under the budget still gets
   * materialized, and can still fail on the real serialized size.
   *
   * That is the case where charging is the whole mechanism. This run is built INTO the band, so it
   * cannot be rejected before the read — and the run behind it must then find the budget already
   * spent rather than a fresh four million to read itself against.
   */
  it('charges an overrun the read cost it, so the run behind it is never read at all', async () => {
    // ~2 KB payloads, just under two thousand of them: the payload sum lands under the frame budget
    // and the envelope overhead the frame also carries pushes the serialized size over it.
    const blob = 'w'.repeat(1_990);
    const rowsPerRun = 1_990;
    for (let i = 0; i < 2; i++) {
      const run = await handlers.runCreate({ input: { task: `banded ${i}`, sessionId: `sess-band-${i}` } });
      bulkAppend(getDatabase(), run.id, rowsPerRun, () => ({ type: 'run.progress', payload: { blob } }));
      expect(rowsPerRun + 1, 'the EVENT cap would be doing the work instead').toBeLessThan(MAX_BOOT_EVENTS_PER_RUN);
    }

    const reads: ReadRecord[] = [];
    const counted = createBrokerHandlers({
      db: countingDb(getDatabase(), reads),
      engines: [mockSearchEngine],
      router: mockRouter,
      backendStatus: undefined,
      onArtifact: () => {},
    });
    const { entries } = await counted.runListLogs({});

    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry.events, 'neither run fits, so both must come back condensed').toEqual([]);
      expect(entry.projection).toBeDefined();
    }

    const materialized = reads
      .filter((r) => r.sql.includes('FROM studio_run_events') && r.sql.includes('seq > ?') && r.rows > 1);
    // EXACTLY one. Two means the first overrun was free and the page starts over on every run — the
    // defect. Zero means the estimate rejected it before the read, so this row is testing the arm it
    // was written to test and not the cheaper one beside it.
    expect(materialized).toHaveLength(1);
    expect(materialized[0].rows).toBe(rowsPerRun + 1);
  });

  /**
   * The half of that charge the CALLER could not see, and the reason a paging host multiplied it.
   *
   * The allowance is a local of this call. A host that follows `nextCursor` gets a fresh four million
   * per page, so the only bound it can carry across a boot is one it computes from the page it was
   * handed — and the page reported `entries`. A condensed entry's `entries` is empty, so a page of
   * runs that cost the child a full `eventsSince` + `JSON.stringify` each looked FREE from up there:
   * the host's allowance never moved, every page kept asking for envelopes, and this call's budget was
   * multiplied by the host's page cap.
   *
   * So the page reports the READ. Same rule as the charge above and for the same reason — the cost is
   * paid at materialization, and a caller that can only see the acceptance cannot bound the work.
   */
  it('reports the read it was charged for, not the envelopes it shipped', async () => {
    // The same band as the arm above: the payload sum sits under the frame budget, so the estimate
    // cannot rule the run out, and the envelope overhead pushes the serialized size over it.
    const blob = 'w'.repeat(1_990);
    const rowsPerRun = 1_990;
    const banded = await handlers.runCreate({ input: { task: 'banded', sessionId: 'sess-report' } });
    bulkAppend(getDatabase(), banded.id, rowsPerRun, () => ({ type: 'run.progress', payload: { blob } }));

    const page = await handlers.runListLogs({});
    const entry = page.entries.find((e) => e.facts.id === banded.id)!;

    // The premise: this run was READ and then condensed, so its cost is exactly the cost `entries`
    // cannot show. Zero shipped envelopes, and the page still moved four million characters.
    expect(entry.events, 'the run fitted, so there is no unreported read for this arm to be about').toEqual([]);
    expect(entry.projection).toBeDefined();
    expect(page.entries.reduce((n, e) => n + e.events.length, 0)).toBe(0);

    // …and the report says so. `events.length` — what the host used to charge — is zero here; the
    // spend is the whole log, and the characters are over the very budget that condensed the run.
    expect(page.eventsSpent, 'the report followed the acceptance rather than the read').toBe(rowsPerRun + 1);
    expect(page.charsSpent, 'a read that overran the frame budget reported less than it').toBeGreaterThan(MAX_BOOT_FRAME_CHARS);
  });

  // The accepted side of the same report: when everything fits, what was read IS what shipped, so the
  // two numbers have to agree. A report that only ever fired on the condensed path would let a host
  // page forever over ordinary runs.
  it('reports a spend that matches the page it shipped when every run fits', async () => {
    const first = await handlers.runCreate({ input: { task: 'a' } });
    await handlers.runAppend({ runId: first.id, event: { actor: { kind: 'agent' }, type: 'tab.attached', payload: { tabId: 'tab-1' } } });
    await handlers.runCreate({ input: { task: 'b' } });

    const page = await handlers.runListLogs({});
    const shipped = page.entries.flatMap((e) => e.events);

    expect(page.entries.every((e) => e.projection === undefined), 'a run was condensed, so this is not the accepted path').toBe(true);
    expect(page.eventsSpent).toBe(shipped.length);
    expect(page.charsSpent).toBe(page.entries.reduce((n, e) => n + JSON.stringify(e.events).length, 0));
    expect(page.charsSpent).toBeLessThan(MAX_BOOT_FRAME_CHARS);
  });

  // `limit` used to be optional, and omitting it meant "every event this run ever had" in one frame
  // — which is exactly how the host's gap replay called it. A required parameter is only half of it:
  // the ceiling is enforced here too, so no caller can ask for a frame the host cannot survive.
  it('refuses an unbounded event read and caps an over-large one', async () => {
    const run = await handlers.runCreate({ input: { task: 't' } });
    bulkAppend(getDatabase(), run.id, 40, () => ({ type: 'run.progress', payload: {} }));

    await expect(handlers.runEventsSince({ runId: run.id } as unknown as { runId: string; limit: number }))
      .rejects.toThrow(/positive limit/);
    await expect(handlers.runEventsSince({ runId: run.id, limit: 0 })).rejects.toThrow(/positive limit/);
    expect(await handlers.runEventsSince({ runId: run.id, limit: 10 })).toHaveLength(10);
    // Asking for more than the ceiling gets a SHORT page, never an unbounded one — which is why the
    // host's paged reader stops on an empty page rather than on a short one.
    expect(await handlers.runEventsSince({ runId: run.id, limit: 10_000_000 })).toHaveLength(41);
  });

  // The facts-only read (perf #6). The gap replay opened with `runGet`, which makes the store PROJECT
  // the run — reading its projection rows, folding its cost, seeking its tail — and then kept four
  // strings, immediately before reading the same log again to build its own projection.
  it('answers a run’s stored facts without projecting it or reading its log', async () => {
    const run = await handlers.runCreate({ input: { task: 'facts only', spaceId: 'space-7' } });
    await handlers.runAppend({ runId: run.id, event: { actor: { kind: 'agent' }, type: 'tab.attached', payload: { tabId: 'tab-1' } } });

    sql.length = 0;
    expect(await handlers.runFacts({ runId: run.id })).toEqual({
      id: run.id, task: 'facts only', spaceId: 'space-7', createdAt: run.createdAt,
    });
    expect(sql.join(' ')).toContain('FROM studio_runs');
    expect(sql.join(' '), 'the facts read went through the log it exists to avoid').not.toContain('studio_run_events');

    // Refused before anything looks it up: `i` is outside the mint alphabet.
    expect(await handlers.runFacts({ runId: 'missing' })).toBeUndefined();
    expect(await handlers.runFacts({ runId: 'nosuchrun' })).toBeUndefined();
  });
});
