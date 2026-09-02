import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { resetConfig } from '../../../src/config.js';
import { initDatabase, getDatabase, closeDatabase } from '../../../src/cache/db.js';
import { BrokerGrantStore, BrokerOpError, executeBrokerOp } from '../../../src/daemon/studio-db-broker.js';
import { BROKER_TABLES, MAX_BROKER_ROWS } from '../../../src/companion-contract/index.js';

/**
 * EXTRACT C3 — the ONE bound the dumb broker has, and why it is stated in rows.
 *
 * The old broker bounded a boot frame in events AND characters, because it shipped domain projections it
 * could price. This one cannot: it does not own the column set, so it cannot know what a row weighs before
 * it reads one. What it can bound is how many rows an op may name, and that bound is on the contract
 * (`MAX_BROKER_ROWS`) so both sides enforce the same number rather than each guessing.
 *
 * The bound must be decided BEFORE the read, or it is not a bound — it is a large read followed by an
 * apology. That is what the residue assertions below are for.
 */
describe('companion broker — the row bound', () => {
  const originalEnv = process.env;
  let grants: BrokerGrantStore;
  let token: string;

  function db() {
    return getDatabase();
  }

  function seedEvents(n: number): void {
    db()
      .prepare('INSERT INTO studio_runs (id, task, created_at) VALUES (?, ?, ?)')
      .run('run-b', 'bounds', '2026-09-03T00:00:00.000Z');
    const insert = db().prepare(
      'INSERT INTO studio_run_events (run_id, seq, ts, actor, type, payload) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (let seq = 1; seq <= n; seq++) insert.run('run-b', seq, 't', 'agent', 'step', '{}');
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

  it('answers at most the rows the op named, never the rest of the table', () => {
    seedEvents(25);

    const page = executeBrokerOp(db(), grants, {
      grant: token,
      kind: 'read',
      table: 'studio_run_events',
      limit: 10,
    });

    expect(page.ok && page.rows).toHaveLength(10);
  });

  it('takes the ceiling exactly and refuses one past it', () => {
    seedEvents(3);

    const atCeiling = executeBrokerOp(db(), grants, {
      grant: token,
      kind: 'read',
      table: 'studio_run_events',
      limit: MAX_BROKER_ROWS,
    });
    const overCeiling = executeBrokerOp(db(), grants, {
      grant: token,
      kind: 'read',
      table: 'studio_run_events',
      limit: MAX_BROKER_ROWS + 1,
    });

    expect(atCeiling.ok && atCeiling.rows).toHaveLength(3);
    expect(overCeiling).toEqual({ ok: false, reason: 'row_limit_exceeded', table: 'studio_run_events' });
  });

  it('refuses an over-large read on the GRANT check first, so an unpaired caller learns nothing about the table', () => {
    seedEvents(3);
    grants.revoke(token, 'unpaired');

    const result = executeBrokerOp(db(), grants, {
      grant: token,
      kind: 'read',
      table: 'studio_run_events',
      limit: MAX_BROKER_ROWS + 1,
    });

    // Not `row_limit_exceeded`: an op from a dead pairing is refused for being from a dead pairing, and
    // the shape of the op it carried is not something the caller gets to learn.
    expect(result).toEqual({ ok: false, reason: 'grant_revoked', table: 'studio_run_events' });
  });

  it('treats an absent, zero, negative or fractional limit as a malformed op rather than a default', () => {
    seedEvents(3);

    for (const limit of [0, -1, 2.5, Number.NaN]) {
      expect(() =>
        executeBrokerOp(db(), grants, { grant: token, kind: 'read', table: 'studio_run_events', limit }),
      ).toThrow(BrokerOpError);
    }
    expect(() =>
      executeBrokerOp(db(), grants, {
        grant: token,
        kind: 'read',
        table: 'studio_run_events',
      } as unknown as Parameters<typeof executeBrokerOp>[2]),
    ).toThrow(BrokerOpError);
  });

  it('refuses a cursor on a table that has no ordering column, instead of silently ignoring it', () => {
    // studio_sessions is keyed by an opaque TEXT id — there is nothing to range over, and a caller that
    // believed otherwise would page forever over the same first page.
    expect(() =>
      executeBrokerOp(db(), grants, {
        grant: token,
        kind: 'read',
        table: 'studio_sessions',
        since: 5,
        limit: 10,
      }),
    ).toThrow(BrokerOpError);
  });
});
