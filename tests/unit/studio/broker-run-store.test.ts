import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SearchEngine } from '../../../src/types.js';
import type { SmartRouter } from '../../../src/fetch/router.js';
import { resetConfig } from '../../../src/config.js';
import type DatabaseType from 'better-sqlite3';
import { initDatabase, getDatabase, closeDatabase } from '../../../src/cache/db.js';
import { createBrokerHandlers, MAX_BOOT_FRAME_CHARS } from '../../../src/daemon/studio-db-broker.js';
import type { RunEvent } from '../../../src/studio/run-store.js';

/**
 * Grow a run's log by the same INSERT the store makes, and place it at the head of the listing.
 *
 * Not `runAppend` in a loop: forcing a real `MAX_BOOT_*` constant needs millions of characters, and
 * each append is its own transaction plus a status fold. `created_at` is pinned because the listing
 * orders by it — an arm about what the FIRST run on a page does to the ones behind it cannot depend
 * on two runs created in the same millisecond tie-breaking the way it hoped.
 */
function seedOversizedRun(db: DatabaseType.Database, runId: string, rows: number, payloadChars: number): void {
  const insert = db.prepare('INSERT INTO studio_run_events (run_id, seq, ts, actor, type, payload) VALUES (?, ?, ?, ?, ?, ?)');
  const actor = JSON.stringify({ kind: 'agent' });
  const payload = JSON.stringify({ blob: 'x'.repeat(payloadChars) });
  const head = db.prepare('SELECT last_seq FROM studio_runs WHERE id = ?').get(runId) as { last_seq: number };
  let seq = head.last_seq;
  db.transaction(() => {
    for (let i = 0; i < rows; i++) {
      seq += 1;
      insert.run(runId, seq, new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), actor, 'run.progress', payload);
    }
    db.prepare('UPDATE studio_runs SET last_seq = ?, created_at = ? WHERE id = ?').run(seq, '2099-01-01T00:00:00.000Z', runId);
  })();
}

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
    const log = await handlers.runEventsSince({ runId: run.id, limit: 100 });
    expect(log.map((e) => [e.seq, e.type])).toEqual([[1, 'run.created'], [2, 'tab.attached'], [3, 'cost.recorded']]);
    expect(await handlers.runEventsSince({ runId: run.id, since: 2, limit: 100 })).toHaveLength(1);
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
    // Still a CLOSED enum, not a "contains no update/delete" predicate: a new mutation method has to
    // be added here deliberately, which is the point. `runExists`, `runFacts` and `runListLogs` are reads.
    const names = Object.keys(handlers).filter((n) => n.startsWith('run'));
    expect(names.sort()).toEqual(['runAppend', 'runCreate', 'runEventsSince', 'runExists', 'runFacts', 'runGet', 'runList', 'runListLogs']);
  });

  /**
   * The boot page always states what it spent reading itself.
   *
   * The host treats an absent report as "what came back is what was read", which is exact for the
   * in-process fallback store and WRONG for this one — a condensed entry comes back empty and cost a
   * full log read. So the fields being present on every page, including an empty one, is the claim: a
   * page that omitted them would put the host silently back on the charge that never decremented.
   */
  it('states the read it was charged for on every boot page, including an empty one', async () => {
    const empty = await handlers.runListLogs({});
    expect(empty.entries).toEqual([]);
    expect(empty.eventsSpent).toBe(0);
    expect(empty.charsSpent).toBe(0);

    const run = await handlers.runCreate({ input: { task: 'spend' } });
    await handlers.runAppend({ runId: run.id, event: { actor: { kind: 'agent' }, type: 'tab.attached', payload: { tabId: 'tab-1' } } });
    const page = await handlers.runListLogs({});
    expect(page.eventsSpent).toBe(2);
    expect(page.charsSpent).toBeGreaterThan(0);
  });

  /**
   * The size probe is itself a read of every payload byte the run has, and the page pays for it.
   *
   * The charge used to sit INSIDE the branch the probe guards, so a run the probe ITSELF ruled out —
   * few envelopes, large payloads, `SUM(LENGTH(payload))` over the frame budget — was condensed and
   * charged nothing. The scan happened; the page reported zero. And zero is what the hydration's
   * allowance is decremented by, so every one of its pages kept taking the log branch and every one
   * re-ran the same full-payload scan against a freshly reset per-call budget.
   *
   * So the arm is a page whose head run is rejected by the probe alone, and the claim is that the
   * page states what that scan cost and stops reading behind it — the same termination the accepted
   * path already had.
   */
  it('charges the size probe at the read, so a run the probe rejects is not free', async () => {
    const trailing = await handlers.runCreate({ input: { task: 'behind the overrun' } });
    await handlers.runAppend({ runId: trailing.id, event: { actor: { kind: 'agent' }, type: 'tab.attached', payload: { tabId: 'tab-1' } } });
    const oversized = await handlers.runCreate({ input: { task: 'over the frame budget' } });
    // Rejected by the SUM ALONE: 111 envelopes is far under the per-run event bound, and the stored
    // payloads are over the frame budget — so the event bound cannot be what condenses this run.
    seedOversizedRun(getDatabase(), oversized.id, 110, 40_000);

    const page = await handlers.runListLogs({});
    const head = page.entries.find((e) => e.facts.id === oversized.id)!;
    const behind = page.entries.find((e) => e.facts.id === trailing.id)!;

    // The premise: this run really was ruled out by the probe, before a single envelope was read.
    expect(head.events, 'the run fitted, so the probe is not what rejected it').toEqual([]);
    expect(head.projection).toBeDefined();
    expect(page.eventsSpent, 'an envelope was materialized, so this is not the probe-only path').toBe(0);

    // The scan is on the books…
    expect(page.charsSpent, 'the page scanned every stored payload byte and reported spending none')
      .toBeGreaterThan(MAX_BOOT_FRAME_CHARS);
    // …and because it is, the budget is gone and the reads stop for the rest of the page. Without the
    // charge the allowance was still whole here, this run shipped its envelopes, and — the part that
    // multiplies — the next hydration page started from four million again.
    expect(behind.events, 'the overrun left the budget whole, so the page kept reading behind it').toEqual([]);
    expect(behind.projection, 'a run answered with no envelopes must still be answered').toBeDefined();
  });

  it('surfaces a refusal instead of silently dropping a malformed append', async () => {
    const run = await handlers.runCreate({ input: { task: 't' } });
    await expect(handlers.runAppend({ runId: run.id, event: { actor: { kind: 'agent' }, type: 'nope' } })).rejects.toThrow(/type/i);
    await expect(handlers.runAppend({ runId: 'zzzz', event: { actor: { kind: 'agent' }, type: 'a.b' } })).rejects.toThrow(/not found/i);
    // `missing` is not merely absent — `i` is outside the mint alphabet, so it is refused as an id
    // before anything looks it up, and never reaches the path join in the disk projection.
    await expect(handlers.runAppend({ runId: 'missing', event: { actor: { kind: 'agent' }, type: 'a.b' } })).rejects.toThrow(/invalid run id/i);
    expect(await handlers.runEventsSince({ runId: run.id, limit: 100 })).toHaveLength(1);
  });
});
