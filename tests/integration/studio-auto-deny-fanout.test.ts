import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { resetConfig } from '../../src/config.js';
import { initDatabase, getDatabase, closeDatabase } from '../../src/cache/db.js';
import { AUTO_DENY_MS, appendEvent, createRun, eventsSince, listRuns, runEventsFile, type Run } from '../../src/studio/run-store.js';

/**
 * §7's "auto-deny after 2m" where only a real store can show it: the cached `studio_runs.status`
 * column that `GET /v1/runs?status=` filters on.
 *
 * That column is recomputed on APPEND and never on the clock, while the BODY of the same response is
 * projected with the clock. So an expiry that produces no event splits one request against itself —
 * the run is missing from `?status=running` and present in `?status=needs_you` carrying a body that
 * says `running`, with an empty card list. Two answers, one log, which is the class law 1 exists to
 * remove.
 *
 * The app half — that the auto-deny timer WRITES the resolving envelope, on the clock that has
 * actually reached the deadline — is pinned in `apps/studio/tests/unit/run-decisions.test.ts`, which
 * is where the timer lives. What is pinned here is the consequence: the append path is the whole fix
 * for K1, and the store needs no change of its own to close it.
 */
describe('the auto-deny, as the REST list filter sees it', () => {
  let dataDir: string;
  let db: Database.Database;
  let nowMs: number;
  let originalEnv: NodeJS.ProcessEnv;

  const now = (): Date => new Date(nowMs);

  beforeEach(() => {
    originalEnv = process.env;
    dataDir = mkdtempSync(join(tmpdir(), 'wigolo-auto-deny-'));
    process.env = { ...originalEnv, LOG_LEVEL: 'error', WIGOLO_DATA_DIR: dataDir };
    resetConfig();
    initDatabase(':memory:');
    db = getDatabase();
    nowMs = Date.now();
  });

  afterEach(() => {
    closeDatabase();
    process.env = originalEnv;
    resetConfig();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** A run holding one parked card, written the way the app's decision mirror writes it. */
  function parkACard(): string {
    const run = createRun(db, { task: 'pay the invoice', sessionId: 'sess-1' }, { dataDir, now });
    appendEvent(db, run.id, {
      actor: { kind: 'agent', driver: 'studio' },
      type: 'decision.requested',
      payload: { decisionId: 'ap-1', kind: 'money', prompt: 'pay $40' },
    }, { dataDir, now });
    return run.id;
  }

  const listed = (status: Run['status']): Run[] => listRuns(db, { status: [status], now }).runs;

  it('reproduces the split: an expiry with no event leaves the filter and the body disagreeing', async () => {
    const runId = parkACard();
    expect(listed('needs_you').map((r) => r.id)).toEqual([runId]);

    // Two minutes pass, and nothing else does — no answer, no timer, no append.
    nowMs += AUTO_DENY_MS + 1_000;

    const stillFiled = listed('needs_you');
    expect(stillFiled.map((r) => r.id), 'the cached column moved without an append, so this arm proves nothing').toEqual([runId]);
    // The row the filter matched denies being the thing the filter matched on.
    expect(stillFiled[0]!.status).toBe('running');
    expect(stillFiled[0]!.pendingDecisions).toEqual([]);
    expect(listed('running'), 'a run that projects as running was reachable by that filter').toEqual([]);
  });

  it('closes it when the auto-deny lands as an event, with no change in the store to do it', async () => {
    const runId = parkACard();

    nowMs += AUTO_DENY_MS + 1_000;
    // The one thing the fix adds: the resolution the timer owes the log.
    appendEvent(db, runId, {
      actor: { kind: 'system' },
      type: 'decision.resolved',
      payload: { decisionId: 'ap-1', outcome: 'auto_denied', by: 'system' },
    }, { dataDir, now });

    const resolved = eventsSince(db, runId, 0, 100).filter((e) => e.type === 'decision.resolved');
    expect(resolved).toHaveLength(1);
    // …on disk as well, which is what law 11 means by inspectable.
    expect(readFileSync(runEventsFile(runId, dataDir), 'utf-8')).toContain('"outcome":"auto_denied"');

    // The K1 row: filter and payload now say the same thing.
    expect(listed('needs_you')).toEqual([]);
    const running = listed('running');
    expect(running.map((r) => r.id)).toEqual([runId]);
    expect(running[0]!.status).toBe('running');
    expect(running[0]!.pendingDecisions).toEqual([]);
  });
});
