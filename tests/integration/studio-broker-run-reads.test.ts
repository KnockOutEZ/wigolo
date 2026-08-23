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
