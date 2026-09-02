import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { resetConfig } from '../../../src/config.js';
import { initDatabase, getDatabase, closeDatabase } from '../../../src/cache/db.js';
import {
  BrokerGrantStore,
  BrokerOpError,
  executeBrokerOp,
  schemaHead,
} from '../../../src/daemon/studio-db-broker.js';
import {
  BROKER_TABLES,
  MAX_BROKER_ROWS,
  evaluateHandshake,
  isBrokerRefusal,
} from '../../../src/companion-contract/index.js';
import type { BrokerOp, BrokerRefusal, BrokerRow } from '../../../src/companion-contract/index.js';

/**
 * EXTRACT C3 (spec D8) — the broker is DUMB and grant-scoped. These cases exist to pin the three
 * properties the companion depends on and that a domain-shaped broker would quietly lose:
 *
 *  - a grant is the ONLY key: no grant, a revoked one, an expired one, or one that does not name the
 *    table refuses BEFORE any statement runs;
 *  - a refusal leaves no residue — the table is byte-identical afterwards, which is what "in-flight ops
 *    complete or abort atomically" (spec §9) means at this seam;
 *  - the wire never supplies an SQL identifier: tables come from the closed contract set, columns are
 *    checked against the database's own `table_info`.
 *
 * They are written against a REAL migrated database, not a stub, because the schema tolerance the whole
 * design rests on is a property of the file — a stub would agree with whatever this repo believes today.
 */
describe('companion broker — grant-scoped table access', () => {
  const originalEnv = process.env;
  let grants: BrokerGrantStore;
  let clock: number;

  const RUN_ID = 'run-1';

  function db() {
    return getDatabase();
  }

  function seedRun(id = RUN_ID): void {
    db()
      .prepare('INSERT INTO studio_runs (id, task, created_at) VALUES (?, ?, ?)')
      .run(id, 'demo task', '2026-09-03T00:00:00.000Z');
  }

  function runRows(): BrokerRow[] {
    return db().prepare('SELECT * FROM studio_runs').all() as BrokerRow[];
  }

  function eventCount(): number {
    return (db().prepare('SELECT COUNT(*) AS n FROM studio_run_events').get() as { n: number }).n;
  }

  function refusalOf(result: ReturnType<typeof executeBrokerOp>): BrokerRefusal {
    if (result.ok) throw new Error(`expected a refusal, got ${JSON.stringify(result)}`);
    return result;
  }

  beforeEach(() => {
    process.env = { ...originalEnv, LOG_LEVEL: 'error' };
    resetConfig();
    initDatabase(':memory:');
    clock = 1_700_000_000_000;
    grants = new BrokerGrantStore({ now: () => clock, mintToken: () => 'grant-token' });
  });

  afterEach(() => {
    closeDatabase();
    resetConfig();
    process.env = originalEnv;
  });

  describe('grant lifecycle', () => {
    it('issues a grant only once the handshake says ok, carrying the head it was issued against', () => {
      const head = schemaHead(db());
      const handshake = evaluateHandshake(
        { contractVersion: '1.0.0', schemaHead: head, capabilities: [] },
        { contractVersion: '1.0.0', schemaHead: head, minSchemaHead: head, capabilities: [] },
      );
      expect(handshake.ok).toBe(true);

      const grant = grants.issue({ mode: 'readwrite', tables: BROKER_TABLES, schemaHead: head });

      expect(grant.token).toBe('grant-token');
      expect(grant.issuedAt).toBe(clock);
      expect(grant.schemaHead).toBe(head);
      expect([...grant.tables].sort()).toEqual([...BROKER_TABLES].sort());
      expect(grants.get(grant.token)).toEqual(grant);
    });

    it('refuses a schema-too-old pairing, so no grant is ever minted for it', () => {
      const head = schemaHead(db());
      const handshake = evaluateHandshake(
        { contractVersion: '1.0.0', schemaHead: head, capabilities: [] },
        { contractVersion: '1.0.0', schemaHead: head, minSchemaHead: head + 1, capabilities: [] },
      );

      expect(handshake).toEqual({ ok: false, reason: 'schema_too_old', hint: 'update_wigolo' });
      expect(grants.list()).toEqual([]);
    });

    it('counts the applied migrations as the head, and reports zero for a file with no ledger', () => {
      const head = schemaHead(db());
      expect(head).toBeGreaterThan(0);

      db().exec('DROP TABLE schema_migrations');
      expect(schemaHead(db())).toBe(0);
    });

    it('revokes idempotently and keeps the FIRST reason', () => {
      const grant = grants.issue({ mode: 'readwrite', tables: ['studio_runs'], schemaHead: 1 });

      const first = grants.revoke(grant.token, 'unpaired');
      clock += 5_000;
      const second = grants.revoke(grant.token, 'superseded');

      expect(first).toEqual({ token: grant.token, revokedAt: 1_700_000_000_000, reason: 'unpaired' });
      expect(second).toEqual(first);
      expect(grants.list()).toEqual([]);
    });

    it('revokeAll withdraws every live grant on unpair', () => {
      let n = 0;
      const store = new BrokerGrantStore({ now: () => clock, mintToken: () => `t${++n}` });
      store.issue({ mode: 'read', tables: ['studio_runs'], schemaHead: 1 });
      store.issue({ mode: 'readwrite', tables: ['studio_audit'], schemaHead: 1 });

      const revocations = store.revokeAll('unpaired');

      expect(revocations.map((r) => r.token).sort()).toEqual(['t1', 't2']);
      expect(store.list()).toEqual([]);
    });
  });

  describe('an op without a live grant never reaches the storage', () => {
    beforeEach(() => {
      seedRun();
    });

    it('refuses no_grant for an absent token and writes nothing', () => {
      const before = runRows();

      const result = executeBrokerOp(db(), grants, {
        grant: '',
        kind: 'insert',
        table: 'studio_runs',
        row: { id: 'run-2', task: 'sneak', created_at: 'now' },
      });

      expect(isBrokerRefusal(result)).toBe(true);
      expect(refusalOf(result)).toEqual({ ok: false, reason: 'no_grant', table: 'studio_runs' });
      expect(runRows()).toEqual(before);
    });

    it('refuses no_grant for a token this daemon never issued', () => {
      grants.issue({ mode: 'readwrite', tables: BROKER_TABLES, schemaHead: 1 });

      const result = executeBrokerOp(db(), grants, {
        grant: 'someone-elses-token',
        kind: 'read',
        table: 'studio_runs',
        limit: 10,
      });

      expect(refusalOf(result).reason).toBe('no_grant');
    });

    it('refuses grant_revoked after the pairing ends, even for a table the grant did name', () => {
      const grant = grants.issue({ mode: 'readwrite', tables: BROKER_TABLES, schemaHead: 1 });
      const before = runRows();
      grants.revoke(grant.token, 'unpaired');

      const result = executeBrokerOp(db(), grants, {
        grant: grant.token,
        kind: 'delete',
        table: 'studio_runs',
        where: { id: RUN_ID },
      });

      expect(refusalOf(result)).toEqual({ ok: false, reason: 'grant_revoked', table: 'studio_runs' });
      expect(runRows()).toEqual(before);
    });

    it('refuses grant_expired on the expiry boundary and retires the grant there and then', () => {
      const store = new BrokerGrantStore({ now: () => clock, ttlMs: 60_000, mintToken: () => 'ttl-token' });
      const grant = store.issue({ mode: 'readwrite', tables: BROKER_TABLES, schemaHead: 1 });
      expect(grant.expiresAt).toBe(clock + 60_000);

      clock += 60_000;
      const result = executeBrokerOp(db(), store, {
        grant: grant.token,
        kind: 'read',
        table: 'studio_runs',
        limit: 10,
      });

      expect(refusalOf(result).reason).toBe('grant_expired');
      // Retired, not merely refused: it must not answer `list()` as live for the rest of the daemon's life.
      expect(store.list()).toEqual([]);
      expect(store.revocationOf(grant.token)?.reason).toBe('expired');
    });

    it('refuses table_not_granted for a real table outside the grant scope', () => {
      const grant = grants.issue({ mode: 'readwrite', tables: ['studio_audit'], schemaHead: 1 });

      const result = executeBrokerOp(db(), grants, {
        grant: grant.token,
        kind: 'read',
        table: 'studio_runs',
        limit: 10,
      });

      expect(refusalOf(result)).toEqual({ ok: false, reason: 'table_not_granted', table: 'studio_runs' });
    });

    it('refuses unknown_table for a name off the closed contract set', () => {
      const grant = grants.issue({ mode: 'readwrite', tables: BROKER_TABLES, schemaHead: 1 });

      const result = executeBrokerOp(db(), grants, {
        grant: grant.token,
        kind: 'read',
        table: 'url_cache',
        limit: 10,
      } as unknown as BrokerOp);

      expect(refusalOf(result)).toEqual({ ok: false, reason: 'unknown_table' });
    });

    it('refuses write_not_granted for a read grant and leaves the table untouched', () => {
      const grant = grants.issue({ mode: 'read', tables: BROKER_TABLES, schemaHead: 1 });
      const before = runRows();

      const result = executeBrokerOp(db(), grants, {
        grant: grant.token,
        kind: 'update',
        table: 'studio_runs',
        row: { status: 'done' },
        where: { id: RUN_ID },
      });

      expect(refusalOf(result)).toEqual({ ok: false, reason: 'write_not_granted', table: 'studio_runs' });
      expect(runRows()).toEqual(before);
      expect(runRows()[0]!.status).toBe('running');
    });

    it('refuses row_limit_exceeded above the wire ceiling without running the read', () => {
      const grant = grants.issue({ mode: 'read', tables: BROKER_TABLES, schemaHead: 1 });

      const ok = executeBrokerOp(db(), grants, {
        grant: grant.token,
        kind: 'read',
        table: 'studio_runs',
        limit: MAX_BROKER_ROWS,
      });
      const refused = executeBrokerOp(db(), grants, {
        grant: grant.token,
        kind: 'read',
        table: 'studio_runs',
        limit: MAX_BROKER_ROWS + 1,
      });

      expect(ok.ok).toBe(true);
      expect(refusalOf(refused)).toEqual({ ok: false, reason: 'row_limit_exceeded', table: 'studio_runs' });
    });
  });

  describe('table ops the companion re-implements its domain on top of', () => {
    beforeEach(() => {
      seedRun();
    });

    function grant() {
      return grants.issue({ mode: 'readwrite', tables: BROKER_TABLES, schemaHead: 1 }).token;
    }

    it('round-trips insert → read → update → delete on the run projection tables', () => {
      const token = grant();

      const inserted = executeBrokerOp(db(), grants, {
        grant: token,
        kind: 'insert',
        table: 'studio_run_events',
        row: { run_id: RUN_ID, seq: 1, ts: '2026-09-03T00:00:01.000Z', actor: 'agent', type: 'step', payload: '{}' },
      });
      expect(inserted).toMatchObject({ ok: true });

      const read = executeBrokerOp(db(), grants, {
        grant: token,
        kind: 'read',
        table: 'studio_run_events',
        where: { run_id: RUN_ID },
        limit: 10,
      });
      expect(read.ok && read.rows).toHaveLength(1);
      expect(read.ok && read.rows[0]).toMatchObject({ run_id: RUN_ID, seq: 1, type: 'step' });

      const updated = executeBrokerOp(db(), grants, {
        grant: token,
        kind: 'update',
        table: 'studio_runs',
        row: { status: 'done' },
        where: { id: RUN_ID },
      });
      expect(updated.ok && updated.rows[0]).toEqual({ changes: 1 });
      expect(runRows()[0]!.status).toBe('done');

      const deleted = executeBrokerOp(db(), grants, {
        grant: token,
        kind: 'delete',
        table: 'studio_run_events',
        where: { run_id: RUN_ID },
      });
      expect(deleted.ok && deleted.rows[0]).toEqual({ changes: 1 });
      expect(eventCount()).toBe(0);
    });

    it('pages a table by its cursor column rather than re-reading page one', () => {
      const token = grant();
      for (const seq of [1, 2, 3]) {
        executeBrokerOp(db(), grants, {
          grant: token,
          kind: 'insert',
          table: 'studio_run_events',
          row: { run_id: RUN_ID, seq, ts: 't', actor: 'agent', type: 'step', payload: '{}' },
        });
      }

      const page = executeBrokerOp(db(), grants, {
        grant: token,
        kind: 'read',
        table: 'studio_run_events',
        since: 1,
        limit: 10,
      });

      expect(page.ok && page.rows.map((r) => r.seq)).toEqual([2, 3]);
    });

    it('filters on a NULL cell without an expression language on the wire', () => {
      const token = grant();

      const rows = executeBrokerOp(db(), grants, {
        grant: token,
        kind: 'read',
        table: 'studio_runs',
        where: { updated_at: null },
        limit: 10,
      });

      expect(rows.ok && rows.rows.map((r) => r.id)).toEqual([RUN_ID]);
    });
  });

  describe('the wire never supplies an SQL identifier', () => {
    beforeEach(() => {
      seedRun();
    });

    it('rejects a column the table does not have as a malformed op, not a refusal', () => {
      const token = grants.issue({ mode: 'readwrite', tables: BROKER_TABLES, schemaHead: 1 }).token;
      const before = runRows();

      expect(() =>
        executeBrokerOp(db(), grants, {
          grant: token,
          kind: 'insert',
          table: 'studio_runs',
          // A protocol error: reporting it through the CLOSED refusal enum would either invent a reason
          // both sides must learn, or send the operator looking for a grant to fix a typo.
          row: { id: 'run-3', task: 't', created_at: 'now', "id) VALUES ('x'); DROP TABLE studio_runs; --": 1 },
        }),
      ).toThrow(BrokerOpError);

      expect(runRows()).toEqual(before);
      expect(db().prepare("SELECT name FROM sqlite_master WHERE name = 'studio_runs'").get()).toBeTruthy();
    });

    it('binds a value that looks like SQL rather than interpolating it', () => {
      const token = grants.issue({ mode: 'readwrite', tables: BROKER_TABLES, schemaHead: 1 }).token;

      executeBrokerOp(db(), grants, {
        grant: token,
        kind: 'insert',
        table: 'studio_runs',
        row: { id: "'; DROP TABLE studio_runs; --", task: 'injection', created_at: 'now' },
      });

      expect(db().prepare("SELECT name FROM sqlite_master WHERE name = 'studio_runs'").get()).toBeTruthy();
      expect(runRows()).toHaveLength(2);
    });

    it('refuses an unfiltered update or delete — a whole-table mutation asked for by omission', () => {
      const token = grants.issue({ mode: 'readwrite', tables: BROKER_TABLES, schemaHead: 1 }).token;

      expect(() =>
        executeBrokerOp(db(), grants, { grant: token, kind: 'update', table: 'studio_runs', row: { status: 'x' } }),
      ).toThrow(BrokerOpError);
      expect(() =>
        executeBrokerOp(db(), grants, { grant: token, kind: 'delete', table: 'studio_runs' }),
      ).toThrow(BrokerOpError);

      expect(runRows()).toHaveLength(1);
      expect(runRows()[0]!.status).toBe('running');
    });
  });

  describe('in-flight atomicity', () => {
    it('leaves the table byte-identical when a write violates a constraint mid-op', () => {
      seedRun();
      const token = grants.issue({ mode: 'readwrite', tables: BROKER_TABLES, schemaHead: 1 }).token;
      const before = runRows();

      // Same primary key as the seeded run: SQLite aborts inside the transaction.
      expect(() =>
        executeBrokerOp(db(), grants, {
          grant: token,
          kind: 'insert',
          table: 'studio_runs',
          row: { id: RUN_ID, task: 'duplicate', created_at: 'now' },
        }),
      ).toThrow();

      expect(runRows()).toEqual(before);
    });

    it('does not roll back an op that already completed when a later one is refused', () => {
      seedRun();
      const grantRecord = grants.issue({ mode: 'readwrite', tables: BROKER_TABLES, schemaHead: 1 });

      const first = executeBrokerOp(db(), grants, {
        grant: grantRecord.token,
        kind: 'insert',
        table: 'studio_run_events',
        row: { run_id: RUN_ID, seq: 1, ts: 't', actor: 'agent', type: 'step', payload: '{}' },
      });
      expect(first.ok).toBe(true);

      grants.revoke(grantRecord.token, 'unpaired');
      const second = executeBrokerOp(db(), grants, {
        grant: grantRecord.token,
        kind: 'insert',
        table: 'studio_run_events',
        row: { run_id: RUN_ID, seq: 2, ts: 't', actor: 'agent', type: 'step', payload: '{}' },
      });

      expect(refusalOf(second).reason).toBe('grant_revoked');
      expect(eventCount()).toBe(1);
    });
  });
});
