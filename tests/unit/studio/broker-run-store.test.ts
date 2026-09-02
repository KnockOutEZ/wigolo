import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { resetConfig } from '../../../src/config.js';
import { initDatabase, getDatabase, closeDatabase } from '../../../src/cache/db.js';
import { BrokerGrantStore, executeBrokerOp } from '../../../src/daemon/studio-db-broker.js';
import { BROKER_TABLES } from '../../../src/companion-contract/index.js';
import type { BrokerRow } from '../../../src/companion-contract/index.js';

/**
 * EXTRACT C3 — the run projection is rebuildable from table ops alone.
 *
 * The run store itself moved out with the domain layer; what core still owes the companion is the two
 * tables it folds a run out of. `studio_runs` + `studio_run_events` are in the closed table set for
 * exactly this reason, and the plan says so in as many words: omit either and paired-mode runs are
 * stranded. So this walks the whole lifecycle a run has — created, appended to, tail advanced, listed,
 * paged, finished — using nothing but the dumb ops, and would go red the moment one of those tables
 * stopped being reachable or the cursor stopped ordering.
 */
describe('companion broker — the run projection survives on table ops alone', () => {
  const originalEnv = process.env;
  let grants: BrokerGrantStore;
  let token: string;

  const RUN = 'run-projection';

  function db() {
    return getDatabase();
  }

  function op(o: Parameters<typeof executeBrokerOp>[2]) {
    const result = executeBrokerOp(db(), grants, o);
    if (!result.ok) throw new Error(`op refused: ${result.reason}`);
    return result.rows as BrokerRow[];
  }

  beforeEach(() => {
    process.env = { ...originalEnv, LOG_LEVEL: 'error' };
    resetConfig();
    initDatabase(':memory:');
    grants = new BrokerGrantStore();
    token = grants.issue({ mode: 'readwrite', tables: BROKER_TABLES, schemaHead: 1 }).token;
  });

  afterEach(() => {
    closeDatabase();
    resetConfig();
    process.env = originalEnv;
  });

  it('creates, appends, advances the tail and finishes a run through the wire ops', () => {
    op({
      grant: token,
      kind: 'insert',
      table: 'studio_runs',
      row: { id: RUN, task: 'buy the thing', created_at: '2026-09-03T00:00:00.000Z' },
    });

    for (const seq of [1, 2, 3]) {
      op({
        grant: token,
        kind: 'insert',
        table: 'studio_run_events',
        row: {
          run_id: RUN,
          seq,
          ts: `2026-09-03T00:00:0${seq}.000Z`,
          actor: seq === 2 ? 'human' : 'agent',
          type: 'step',
          payload: JSON.stringify({ n: seq }),
        },
      });
      op({
        grant: token,
        kind: 'update',
        table: 'studio_runs',
        row: { last_seq: seq, updated_at: `2026-09-03T00:00:0${seq}.000Z` },
        where: { id: RUN },
      });
    }

    const [run] = op({ grant: token, kind: 'read', table: 'studio_runs', where: { id: RUN }, limit: 1 });
    expect(run).toMatchObject({ id: RUN, status: 'running', last_seq: 3 });

    const events = op({ grant: token, kind: 'read', table: 'studio_run_events', where: { run_id: RUN }, limit: 100 });
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
    // The driver of each step is a column, not a projection: the companion folds it, core stores it.
    expect(events.map((e) => e.actor)).toEqual(['agent', 'human', 'agent']);

    op({ grant: token, kind: 'update', table: 'studio_runs', row: { status: 'done' }, where: { id: RUN } });
    const [finished] = op({ grant: token, kind: 'read', table: 'studio_runs', where: { id: RUN }, limit: 1 });
    expect(finished!.status).toBe('done');
  });

  it('resumes an event log from a cursor rather than re-reading it whole', () => {
    op({
      grant: token,
      kind: 'insert',
      table: 'studio_runs',
      row: { id: RUN, task: 't', created_at: '2026-09-03T00:00:00.000Z' },
    });
    for (let seq = 1; seq <= 10; seq++) {
      op({
        grant: token,
        kind: 'insert',
        table: 'studio_run_events',
        row: { run_id: RUN, seq, ts: 't', actor: 'agent', type: 'step', payload: '{}' },
      });
    }

    const firstPage = op({
      grant: token,
      kind: 'read',
      table: 'studio_run_events',
      where: { run_id: RUN },
      limit: 4,
    });
    const cursor = firstPage.at(-1)!.seq as number;
    const secondPage = op({
      grant: token,
      kind: 'read',
      table: 'studio_run_events',
      where: { run_id: RUN },
      since: cursor,
      limit: 4,
    });

    expect(firstPage.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(secondPage.map((e) => e.seq)).toEqual([5, 6, 7, 8]);
    // The bound is the LIMIT, not the table: a page never quietly returns the rest of the log.
    expect(secondPage).toHaveLength(4);
  });

  it('reads only the run it was asked for when several are live', () => {
    for (const id of ['run-a', 'run-b']) {
      op({
        grant: token,
        kind: 'insert',
        table: 'studio_runs',
        row: { id, task: id, created_at: '2026-09-03T00:00:00.000Z' },
      });
      op({
        grant: token,
        kind: 'insert',
        table: 'studio_run_events',
        row: { run_id: id, seq: 1, ts: 't', actor: 'agent', type: 'step', payload: `"${id}"` },
      });
    }

    const onlyB = op({ grant: token, kind: 'read', table: 'studio_run_events', where: { run_id: 'run-b' }, limit: 10 });

    expect(onlyB).toHaveLength(1);
    expect(onlyB[0]!.payload).toBe('"run-b"');
  });
});
