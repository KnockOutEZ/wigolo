import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { resetConfig } from '../../../src/config.js';
import { initDatabase, getDatabase, closeDatabase } from '../../../src/cache/db.js';
import { BrokerGrantStore, executeBrokerOp } from '../../../src/daemon/studio-db-broker.js';
import { BROKER_TABLES } from '../../../src/companion-contract/index.js';
import type { BrokerRow } from '../../../src/companion-contract/index.js';

/**
 * #334's question, re-asked of the broker C3 left behind.
 *
 * #334 measured a real gap: with the app as host, `POST /v1/runs/:id/driver` and both `/messages` routes
 * answered `503 store_unavailable`, because the broker had no door for six of the nine members
 * `RunsStore` names. Its answer was to put six domain delegates on the broker. C3 (spec D8) takes the
 * opposite half of the same trade — the broker serves TABLES, and the app re-implements the nine members
 * on top of them — so the delegates are gone and the gap has to be closed a different way.
 *
 * What core can still be held to is the SUFFICIENCY claim underneath #334: everything those nine members
 * read or write is reachable through the dumb ops with an ordinary grant. If that holds, an app-side
 * binding has what it needs; if a table ever left the grant set, this reds here rather than in another
 * repo, which is exactly where #334 wanted the failure to land.
 *
 * The grammars themselves — which events a gesture is worth, when `queued` becomes `delivered at step N`
 * — are NOT re-derived here. They moved with the domain layer, and re-deriving them in a core test would
 * build the second source of truth law 1 forbids.
 */
describe('companion broker — the run-log surface is reachable as table ops', () => {
  const originalEnv = process.env;
  let grants: BrokerGrantStore;
  let token: string;

  const RUN = 'run-334';

  function db() {
    return getDatabase();
  }

  function op(o: Parameters<typeof executeBrokerOp>[2]): BrokerRow[] {
    const result = executeBrokerOp(db(), grants, o);
    if (!result.ok) throw new Error(`op refused: ${result.reason}`);
    return result.rows as BrokerRow[];
  }

  function append(seq: number, type: string, payload: unknown, actor = 'agent'): void {
    op({
      grant: token,
      kind: 'insert',
      table: 'studio_run_events',
      row: { run_id: RUN, seq, ts: `2026-09-03T00:00:0${seq}.000Z`, actor, type, payload: JSON.stringify(payload) },
    });
    op({ grant: token, kind: 'update', table: 'studio_runs', row: { last_seq: seq }, where: { id: RUN } });
  }

  beforeEach(() => {
    process.env = { ...originalEnv, LOG_LEVEL: 'error' };
    resetConfig();
    initDatabase(':memory:');
    grants = new BrokerGrantStore();
    token = grants.issue({ mode: 'readwrite', tables: BROKER_TABLES, schemaHead: 1 }).token;
    op({
      grant: token,
      kind: 'insert',
      table: 'studio_runs',
      row: { id: RUN, task: 'the nine members', created_at: '2026-09-03T00:00:00.000Z' },
    });
  });

  afterEach(() => {
    closeDatabase();
    resetConfig();
    process.env = originalEnv;
  });

  it('serves both tables the nine members read, with a grant that names them', () => {
    // Named rather than counted, for #334's own reason: a table dropping out of the grant set has to be
    // noticed here, not silently stop being reachable.
    for (const table of ['studio_runs', 'studio_run_events'] as const) {
      expect(BROKER_TABLES).toContain(table);
      expect(executeBrokerOp(db(), grants, { grant: token, kind: 'read', table, limit: 1 }).ok).toBe(true);
    }
  });

  it('answers existence and the stored facts without reading the log', () => {
    append(1, 'step', { n: 1 });
    append(2, 'step', { n: 2 });

    const [run] = op({ grant: token, kind: 'read', table: 'studio_runs', where: { id: RUN }, limit: 1 });
    const missing = op({ grant: token, kind: 'read', table: 'studio_runs', where: { id: 'nope' }, limit: 1 });

    // `runExists` and `runFacts` reduce to one row of `studio_runs`: the tail is a stored column, so
    // neither question costs the log — the property #334's boot-frame budget existed to protect.
    expect(run).toMatchObject({ id: RUN, task: 'the nine members', last_seq: 2, status: 'running' });
    expect(missing).toEqual([]);
  });

  it('selects one event type without materialising the rest of the log', () => {
    append(1, 'step', { n: 1 });
    append(2, 'driver.changed', { to: 'human' }, 'human');
    append(3, 'message', { text: 'do the thing' }, 'human');
    append(4, 'step', { n: 4 });

    const drivers = op({
      grant: token,
      kind: 'read',
      table: 'studio_run_events',
      where: { run_id: RUN, type: 'driver.changed' },
      limit: 50,
    });
    const messages = op({
      grant: token,
      kind: 'read',
      table: 'studio_run_events',
      where: { run_id: RUN, type: 'message' },
      limit: 50,
    });

    // `runTypedEvents`, `runMessages`, `runUnansweredEvents` and `runInterruptTrigger` are all this
    // shape: an equality filter on a stored column, which the wire has, and a fold, which the app owns.
    expect(drivers.map((e) => e.seq)).toEqual([2]);
    expect(messages.map((e) => e.seq)).toEqual([3]);
    expect(messages[0]!.actor).toBe('human');
  });

  it('appends a gesture’s rows without a path that rewrites or drops one', () => {
    append(1, 'step', { n: 1 });
    append(2, 'driver.changed', { to: 'human' }, 'human');

    // The append-only guarantee is now a property of what the WIRE can express, not of a handler list:
    // an update names cells and a filter, and nothing addresses an event row's identity, so a caller can
    // add a driver row but cannot revise the one before it into a different history.
    const before = op({ grant: token, kind: 'read', table: 'studio_run_events', where: { run_id: RUN }, limit: 50 });
    append(3, 'driver.changed', { to: 'agent' });
    const after = op({ grant: token, kind: 'read', table: 'studio_run_events', where: { run_id: RUN }, limit: 50 });

    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('refuses the whole surface on a read grant, so an observer cannot move the baton', () => {
    const readOnly = grants.issue({ mode: 'read', tables: BROKER_TABLES, schemaHead: 1 }).token;
    append(1, 'step', { n: 1 });

    const refused = executeBrokerOp(db(), grants, {
      grant: readOnly,
      kind: 'insert',
      table: 'studio_run_events',
      row: { run_id: RUN, seq: 2, ts: 't', actor: 'agent', type: 'driver.changed', payload: '{}' },
    });

    expect(refused).toEqual({ ok: false, reason: 'write_not_granted', table: 'studio_run_events' });
    expect(op({ grant: token, kind: 'read', table: 'studio_run_events', where: { run_id: RUN }, limit: 50 })).toHaveLength(1);
  });
});
