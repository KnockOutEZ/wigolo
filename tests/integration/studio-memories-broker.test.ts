import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { resetConfig } from '../../src/config.js';
import { initDatabase, getDatabase, closeDatabase } from '../../src/cache/db.js';
import {
  BrokerGrantStore,
  BrokerOpError,
  executeBrokerOp,
} from '../../src/daemon/studio-db-broker.js';
import { BROKER_TABLES } from '../../src/companion-contract/index.js';
import type { BrokerOp, BrokerRefusal, BrokerRow } from '../../src/companion-contract/index.js';

/**
 * SD5 §6.1 — the memories store, at the seam the companion actually reaches it through.
 *
 * The memories SEMANTICS (revise writes a new row and archives the old, expired rows drop out of
 * active listings) belong to the companion after the domain extraction: the broker is dumb by
 * design (spec D8) and there is no core module left to hold them. What core owes, and what these
 * cases pin, is that the table it ships can CARRY those semantics and that the grant is the only
 * key to them — a store the companion can read but not write would ship the memories screen with
 * its `edit` and `archive` affordances dead, and nothing but a test says which modes are live.
 *
 * Written against a REAL migrated database rather than a stub, for the reason the broker's own
 * suite is: schema tolerance is a property of the file, and a stub agrees with whatever this repo
 * believes today.
 */
describe('studio_memories over the companion broker', () => {
  const originalEnv = process.env;
  let grants: BrokerGrantStore;

  /** A memory as the companion writes one — every pinned column, so a dropped one shows up here. */
  const FIRST = Object.freeze({
    id: 'mem-1',
    text: 'expensify wants the receipt total without currency symbols',
    scope: 'site',
    scope_key: 'https://www.expensify.com',
    provenance: 'correction',
    source_run_id: 'run-7fq2',
    source_detail: 'replay step 9',
    created_at: 1_700_000_000_000,
    expires_at: null,
    status: 'active',
  });

  function db() {
    return getDatabase();
  }

  function token(mode: 'read' | 'readwrite', tables: readonly string[] = BROKER_TABLES): string {
    return grants.issue({
      mode,
      tables: tables as Parameters<BrokerGrantStore['issue']>[0]['tables'],
      schemaHead: 1,
    }).token;
  }

  function run(op: BrokerOp): ReturnType<typeof executeBrokerOp> {
    return executeBrokerOp(db(), grants, op);
  }

  function rowsOf(result: ReturnType<typeof executeBrokerOp>): readonly BrokerRow[] {
    if (!result.ok) throw new Error(`expected rows, got a refusal: ${JSON.stringify(result)}`);
    return result.rows ?? [];
  }

  function refusalOf(result: ReturnType<typeof executeBrokerOp>): BrokerRefusal {
    if (result.ok) throw new Error(`expected a refusal, got ${JSON.stringify(result)}`);
    return result;
  }

  /** What the storage really holds, read past the broker so a broker bug cannot hide one. */
  function stored(): BrokerRow[] {
    return db()
      .prepare('SELECT * FROM studio_memories ORDER BY created_at, id')
      .all() as BrokerRow[];
  }

  beforeEach(() => {
    process.env = { ...originalEnv, LOG_LEVEL: 'error' };
    resetConfig();
    initDatabase(':memory:');
    grants = new BrokerGrantStore();
  });

  afterEach(() => {
    closeDatabase();
    resetConfig();
    process.env = originalEnv;
  });

  describe('grant scoping — read AND write', () => {
    it('serves a read and a write to a grant that names the table', () => {
      const grant = token('readwrite');

      expect(run({ grant, kind: 'insert', table: 'studio_memories', row: { ...FIRST } }).ok).toBe(true);
      expect(rowsOf(run({ grant, kind: 'read', table: 'studio_memories', limit: 10 }))).toHaveLength(1);
    });

    it('refuses both a read and a write with no grant, before the table is touched', () => {
      for (const op of [
        { grant: 'nobody', kind: 'read', table: 'studio_memories', limit: 10 },
        { grant: 'nobody', kind: 'insert', table: 'studio_memories', row: { ...FIRST } },
      ] as const) {
        expect(refusalOf(run(op))).toEqual({ ok: false, reason: 'no_grant', table: 'studio_memories' });
      }
      expect(stored()).toEqual([]);
    });

    it('refuses a grant that names other tables but not this one', () => {
      const grant = token('readwrite', ['studio_runs']);

      expect(refusalOf(run({ grant, kind: 'read', table: 'studio_memories', limit: 10 }))).toEqual({
        ok: false,
        reason: 'table_not_granted',
        table: 'studio_memories',
      });
      expect(
        refusalOf(run({ grant, kind: 'insert', table: 'studio_memories', row: { ...FIRST } })),
      ).toEqual({ ok: false, reason: 'table_not_granted', table: 'studio_memories' });
      expect(stored()).toEqual([]);
    });

    it('lets a read-only grant read but not write — and the refusal leaves no residue', () => {
      run({ grant: token('readwrite'), kind: 'insert', table: 'studio_memories', row: { ...FIRST } });
      const before = stored();

      const readOnly = token('read');
      expect(rowsOf(run({ grant: readOnly, kind: 'read', table: 'studio_memories', limit: 10 }))).toHaveLength(1);

      for (const op of [
        { grant: readOnly, kind: 'insert', table: 'studio_memories', row: { ...FIRST, id: 'mem-2' } },
        {
          grant: readOnly,
          kind: 'update',
          table: 'studio_memories',
          row: { status: 'archived' },
          where: { id: FIRST.id },
        },
        { grant: readOnly, kind: 'delete', table: 'studio_memories', where: { id: FIRST.id } },
      ] as const) {
        expect(refusalOf(run(op))).toEqual({
          ok: false,
          reason: 'write_not_granted',
          table: 'studio_memories',
        });
      }

      expect(stored()).toEqual(before);
    });

    it('is in the closed table set, so a grant over every shared table reaches it', () => {
      // Named rather than counted: a table dropping out of the contract has to be noticed here,
      // not silently stop being reachable by an app that still has a screen for it.
      expect(BROKER_TABLES).toContain('studio_memories');
    });
  });

  describe('provenance chain (A-16-8) — revise writes a new row and archives the old', () => {
    it('preserves the superseded memory, its provenance and its origin run', () => {
      const grant = token('readwrite');
      const REVISED = {
        ...FIRST,
        id: 'mem-2',
        text: 'expensify wants the receipt total as a bare number, no currency symbol',
        provenance: 'told',
        source_detail: 'revised mem-1 · panel',
        created_at: FIRST.created_at + 60_000,
      };

      // 1. insert — the memory as the correction card saved it.
      expect(run({ grant, kind: 'insert', table: 'studio_memories', row: { ...FIRST } }).ok).toBe(true);

      // 2. revise — a NEW row, then the old one archived. Never an in-place edit of `text`: "nothing
      //    is remembered silently" includes silent rewrites, so the superseded wording has to survive.
      expect(run({ grant, kind: 'insert', table: 'studio_memories', row: REVISED }).ok).toBe(true);
      expect(
        run({
          grant,
          kind: 'update',
          table: 'studio_memories',
          row: { status: 'archived' },
          where: { id: FIRST.id },
        }).ok,
      ).toBe(true);

      // 3. the chain: both rows are still there, and the old one kept ITS provenance, not the new
      //    one's — an UPDATE that rewrote the row in place would have collapsed them into one.
      const chain = stored();
      expect(chain).toHaveLength(2);
      expect(chain[0]).toMatchObject({
        id: 'mem-1',
        text: FIRST.text,
        provenance: 'correction',
        source_run_id: 'run-7fq2',
        source_detail: 'replay step 9',
        status: 'archived',
      });
      expect(chain[1]).toMatchObject({
        id: 'mem-2',
        text: REVISED.text,
        provenance: 'told',
        source_detail: 'revised mem-1 · panel',
        status: 'active',
      });

      // 4. archive — the surviving memory goes the same way, and the store still holds both.
      expect(
        run({
          grant,
          kind: 'update',
          table: 'studio_memories',
          row: { status: 'archived' },
          where: { id: 'mem-2' },
        }).ok,
      ).toBe(true);

      // 5. list — the active listing is now empty while the history is intact, which is the whole
      //    point of append-plus-status: the surface goes quiet, the record does not.
      const active = rowsOf(
        run({ grant, kind: 'read', table: 'studio_memories', where: { status: 'active' }, limit: 100 }),
      );
      expect(active).toEqual([]);
      expect(stored()).toHaveLength(2);
    });

    it('scopes a listing by scope and scope_key without a range filter on the wire', () => {
      const grant = token('readwrite');
      const rows = [
        { ...FIRST, id: 'site-1', scope: 'site', scope_key: 'https://www.expensify.com' },
        { ...FIRST, id: 'site-2', scope: 'site', scope_key: 'https://mail.google.com' },
        { ...FIRST, id: 'space-1', scope: 'space', scope_key: 'space-finance' },
        { ...FIRST, id: 'global-1', scope: 'global', scope_key: null },
      ];
      for (const row of rows) run({ grant, kind: 'insert', table: 'studio_memories', row });

      const site = rowsOf(
        run({
          grant,
          kind: 'read',
          table: 'studio_memories',
          where: { status: 'active', scope: 'site', scope_key: 'https://www.expensify.com' },
          limit: 100,
        }),
      );
      expect(site.map((r) => r.id)).toEqual(['site-1']);

      // `scope_key IS NULL` is the global scope's real predicate, and the wire spells it as a null
      // cell rather than an expression — pinned because a client that sent `''` instead would get
      // silence, not an error.
      const global = rowsOf(
        run({
          grant,
          kind: 'read',
          table: 'studio_memories',
          where: { scope: 'global', scope_key: null },
          limit: 100,
        }),
      );
      expect(global.map((r) => r.id)).toEqual(['global-1']);
    });

    it('takes no cursor: the id is opaque TEXT, so paging is limit + where, never since/before', () => {
      const grant = token('readwrite');
      run({ grant, kind: 'insert', table: 'studio_memories', row: { ...FIRST } });

      // A protocol error, not a refusal, and deliberately not a silently ignored bound — a bound the
      // broker dropped would re-serve page one forever. The companion pages this table by narrowing
      // `where`, exactly as it does the other TEXT-keyed shared tables.
      expect(() =>
        run({ grant, kind: 'read', table: 'studio_memories', limit: 10, since: 0 }),
      ).toThrow(BrokerOpError);
    });

    it('rejects a column the table does not have as a malformed op, not an access decision', () => {
      const grant = token('readwrite');
      expect(() =>
        run({
          grant,
          kind: 'insert',
          table: 'studio_memories',
          row: { ...FIRST, supersedes: 'mem-0' },
        }),
      ).toThrow(BrokerOpError);
      expect(stored()).toEqual([]);
    });
  });

  describe('expiry — what migration 019 makes servable', () => {
    /**
     * The expiry PREDICATE (`expires_at < now`) is not expressible on the broker wire, which carries
     * equality cells only, so read-time exclusion is the companion's filter and the prune pass is a
     * core-side statement. Both stand or fall on migration 019 having created an index the predicate
     * can seek. That is a property of the MIGRATION, so it is asserted about the migrated database's
     * own query plan rather than about SQL this test wrote.
     */
    it('serves the prune predicate from the partial expiry index', () => {
      const plan = db()
        .prepare('EXPLAIN QUERY PLAN DELETE FROM studio_memories WHERE expires_at < ?')
        .all(FIRST.created_at) as Array<{ detail: string }>;
      const detail = plan.map((r) => r.detail).join(' | ');

      expect(detail).toContain('idx_studio_memories_expiry');
      expect(detail).not.toContain('SCAN studio_memories');
    });

    it('serves the active scope listing from the scope index', () => {
      const plan = db()
        .prepare(
          'EXPLAIN QUERY PLAN SELECT * FROM studio_memories WHERE status = ? AND scope = ? AND scope_key = ? ORDER BY created_at',
        )
        .all('active', 'site', 'https://www.expensify.com') as Array<{ detail: string }>;
      const detail = plan.map((r) => r.detail).join(' | ');

      expect(detail).toContain('idx_studio_memories_scope');
      // The index ends in created_at, so the newest-first order is the same traversal and no sort
      // step survives. A TEMP B-TREE here would mean the listing pays a full sort per open.
      expect(detail).not.toContain('TEMP B-TREE');
    });

    it('stores a null expiry and a set one as distinguishable cells through the wire', () => {
      const grant = token('readwrite');
      run({ grant, kind: 'insert', table: 'studio_memories', row: { ...FIRST, id: 'forever' } });
      run({
        grant,
        kind: 'insert',
        table: 'studio_memories',
        row: { ...FIRST, id: 'until-friday', expires_at: FIRST.created_at + 86_400_000 },
      });

      const rows = rowsOf(run({ grant, kind: 'read', table: 'studio_memories', limit: 100 }));
      const byId = new Map(rows.map((r) => [r.id, r.expires_at]));
      expect(byId.get('forever')).toBeNull();
      expect(byId.get('until-friday')).toBe(FIRST.created_at + 86_400_000);
    });
  });
});
