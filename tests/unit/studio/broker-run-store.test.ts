import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SearchEngine } from '../../../src/types.js';
import type { SmartRouter } from '../../../src/fetch/router.js';
import { resetConfig } from '../../../src/config.js';
import { initDatabase, getDatabase, closeDatabase } from '../../../src/cache/db.js';
import { createBrokerHandlers } from '../../../src/daemon/studio-db-broker.js';
import type { RunEvent } from '../../../src/studio/run-store.js';

/**
 * SD1 — the run store behind the broker. A run lives in the process that owns the DB handle, so
 * these are the methods the Electron main has instead of a table: create, append, read, list, tail.
 */
describe('studio-db-broker — run store methods', () => {
  const originalEnv = process.env;
  const mockSearchEngine: SearchEngine = { name: 'mock', search: vi.fn().mockResolvedValue([]) };
  const mockRouter = { fetch: vi.fn() } as unknown as SmartRouter;

  let dir: string;
  let events: Array<{ runId: string; event: RunEvent }>;
  let handlers: ReturnType<typeof createBrokerHandlers>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wigolo-broker-runs-'));
    process.env = { ...originalEnv, LOG_LEVEL: 'error', WIGOLO_DATA_DIR: dir };
    resetConfig();
    initDatabase(':memory:');
    events = [];
    handlers = createBrokerHandlers({
      db: getDatabase(),
      engines: [mockSearchEngine],
      router: mockRouter,
      backendStatus: undefined,
      onArtifact: () => {},
      onRunEvent: (runId, event) => { events.push({ runId, event }); },
    });
  });

  afterEach(() => {
    closeDatabase();
    process.env = originalEnv;
    resetConfig();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates a run and reads it back by id', async () => {
    const run = await handlers.runCreate({ input: { task: 'compare two pages', driver: { kind: 'cli' } } });
    expect(run.id).toMatch(/^[23456789abcdefghjkmnpqrstvwxyz]{4,}$/);
    expect(await handlers.runGet({ runId: run.id })).toEqual(run);
    expect(await handlers.runGet({ runId: 'nope' })).toBeUndefined();
  });

  it('appends events and reads them back in order', async () => {
    const run = await handlers.runCreate({ input: { task: 't' } });
    await handlers.runAppend({ runId: run.id, event: { actor: { kind: 'agent', driver: 'cli' }, type: 'tab.attached', payload: { tabId: 'tab-1' } } });
    await handlers.runAppend({ runId: run.id, event: { actor: { kind: 'agent', driver: 'cli' }, type: 'cost.recorded', payload: { kind: 'browser_action', amount: 1 } } });
    const log = await handlers.runEventsSince({ runId: run.id });
    expect(log.map((e) => [e.seq, e.type])).toEqual([[1, 'run.created'], [2, 'tab.attached'], [3, 'cost.recorded']]);
    expect(await handlers.runEventsSince({ runId: run.id, since: 2 })).toHaveLength(1);
    const after = await handlers.runGet({ runId: run.id });
    expect(after!.tabIds).toEqual(['tab-1']);
    expect(after!.cost.browserActions).toBe(1);
  });

  it('pushes every committed envelope to the live tail, once, in seq order', async () => {
    const run = await handlers.runCreate({ input: { task: 't' } });
    await handlers.runAppend({ runId: run.id, event: { actor: { kind: 'agent' }, type: 'tab.attached', payload: { tabId: 'x' } } });
    expect(events.map((e) => e.event.seq)).toEqual([1, 2]);
    expect(events.every((e) => e.runId === run.id)).toBe(true);
  });

  it('lists runs newest first', async () => {
    const a = await handlers.runCreate({ input: { task: 'a' } });
    const b = await handlers.runCreate({ input: { task: 'b' } });
    const listed = (await handlers.runList({})).runs.map((r) => r.id);
    expect(new Set(listed)).toEqual(new Set([a.id, b.id]));
    expect((await handlers.runList({ limit: 1 })).nextCursor).toBeTruthy();
  });

  it('exposes no method that could rewrite or drop an event', async () => {
    // The append-only guarantee has to hold at the RPC surface too: a host that can call
    // `runUpdate` has a second source of truth no matter what the store module refuses.
    const names = Object.keys(handlers).filter((n) => n.startsWith('run'));
    expect(names.sort()).toEqual(['runAppend', 'runCreate', 'runEventsSince', 'runGet', 'runList']);
  });

  it('surfaces a refusal instead of silently dropping a malformed append', async () => {
    const run = await handlers.runCreate({ input: { task: 't' } });
    await expect(handlers.runAppend({ runId: run.id, event: { actor: { kind: 'agent' }, type: 'nope' } })).rejects.toThrow(/type/i);
    await expect(handlers.runAppend({ runId: 'missing', event: { actor: { kind: 'agent' }, type: 'a.b' } })).rejects.toThrow(/not found/i);
    expect(await handlers.runEventsSince({ runId: run.id })).toHaveLength(1);
  });
});
