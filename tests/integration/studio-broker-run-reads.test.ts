import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { SearchEngine } from '../../src/types.js';
import type { SmartRouter } from '../../src/fetch/router.js';
import { resetConfig } from '../../src/config.js';
import { initDatabase, getDatabase, closeDatabase } from '../../src/cache/db.js';
import { createBrokerHandlers } from '../../src/daemon/studio-db-broker.js';

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

    const logs = await handlers.runListLogs({});

    expect(logs.map((l) => l.facts.id).sort()).toEqual([a.id, b.id].sort());
    const first = logs.find((l) => l.facts.id === a.id)!;
    // Exactly the stored facts — a projected `Run` here would be the duplication this read removes.
    expect(Object.keys(first.facts).sort()).toEqual(['createdAt', 'id', 'spaceId', 'task']);
    expect(first.facts.task).toBe('first');
    // The WHOLE log, not the projection subset: the host folds later envelopes on by seq, so a page
    // that skipped a non-projection event would hand it a log with a hole at the first append.
    expect(first.events.map((e) => [e.seq, e.type])).toEqual([[1, 'run.created'], [2, 'tab.attached']]);
    expect(first.events[0].payload.sessionId).toBe('sess-a');
    expect(logs.find((l) => l.facts.id === b.id)!.events.map((e) => e.type)).toEqual(['run.created']);
  });

  it('pages the combined read exactly as the listing does', async () => {
    for (let i = 0; i < 3; i++) await handlers.runCreate({ input: { task: `run ${i}` } });

    const page = await handlers.runListLogs({ limit: 2 });
    const listed = await handlers.runList({ limit: 2 });

    expect(page.map((l) => l.facts.id)).toEqual(listed.runs.map((r) => r.id));
    expect(page).toHaveLength(2);
  });
});
