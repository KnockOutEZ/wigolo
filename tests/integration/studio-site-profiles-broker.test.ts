import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { resetConfig } from '../../src/config.js';
import { initDatabase, getDatabase, closeDatabase } from '../../src/cache/db.js';
import {
  BrokerGrantStore,
  BrokerOpError,
  executeBrokerOp,
} from '../../src/daemon/studio-db-broker.js';
import { BROKER_TABLES } from '../../src/companion-contract/index.js';
import type { BrokerOp, BrokerRefusal, BrokerRow, BrokerTable } from '../../src/companion-contract/index.js';

/**
 * SD6 §3 (A-17-3) — the site-profile store, at the seam the companion actually reaches it through.
 *
 * The profile SEMANTICS (the closed visibility set, the human-only grant writer, the serialised
 * read-modify-write of `run_count`, export/import) belong to the domain module app-side: the broker
 * is dumb by design (D8) and will never grow a domain method. What core owes, and what these cases
 * pin, is that the three tables it ships can CARRY those semantics and that a grant is the only key
 * to them — a store the companion could read but not write would ship the profile card as a display
 * of rows nothing can populate, and nothing but a test says which modes are live.
 *
 * Written against a REAL migrated database rather than a stub, for the reason the memories and
 * annotations suites are: schema tolerance is a property of the file, and a stub agrees with
 * whatever this repo believes today.
 */
describe('the studio_site_* tables over the companion broker', () => {
  const originalEnv = process.env;
  let grants: BrokerGrantStore;

  const SITE_TABLES = ['studio_site_profiles', 'studio_site_grants', 'studio_site_memories'] as const;

  /** The profile row as the profile card saves one — every pinned column. */
  const PROFILE = Object.freeze({
    domain: 'expensify.com',
    created_at: 1_700_000_000_000,
    run_count: 4,
    visibility: 'text_only',
    view_rules: JSON.stringify({ hide: ['.promo'] }),
    flags: JSON.stringify({ injection_reported: true }),
  });

  /** The persistent "remember for this site" row the grant card writes. */
  const GRANT_ROW = Object.freeze({
    id: 'sg-1',
    domain: 'expensify.com',
    scope: 'read_page',
    granted_at: 1_700_000_001_000,
    writer: 'human',
  });

  /** The junction row: a profile REFERENCES a memory by id, embedding it only at export (A-16-9). */
  const LINK = Object.freeze({
    domain: 'expensify.com',
    memory_id: 'mem-7fq2',
    linked_at: 1_700_000_002_000,
  });

  /** Each table with the row that exercises it, its key column, and a cell an update may change. */
  interface RoundTrip {
    table: BrokerTable;
    row: BrokerRow;
    where: BrokerRow;
    update: BrokerRow;
  }

  const ROUND_TRIPS: readonly RoundTrip[] = [
    {
      table: 'studio_site_profiles' as const,
      row: PROFILE,
      where: { domain: PROFILE.domain },
      update: { visibility: 'hidden', run_count: 5 },
    },
    {
      table: 'studio_site_grants' as const,
      row: GRANT_ROW,
      where: { id: GRANT_ROW.id },
      update: { scope: 'read_page,fill_form' },
    },
    {
      table: 'studio_site_memories' as const,
      row: LINK,
      where: { domain: LINK.domain, memory_id: LINK.memory_id },
      update: { linked_at: LINK.linked_at + 60_000 },
    },
  ];

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
  function stored(table: BrokerTable): BrokerRow[] {
    return db().prepare(`SELECT * FROM ${table}`).all() as BrokerRow[];
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

  describe('grant scoping — read AND write, on all three', () => {
    it('serves a read and a write to a grant that names the table', () => {
      const grant = token('readwrite');
      for (const { table, row } of ROUND_TRIPS) {
        expect(run({ grant, kind: 'insert', table, row: { ...row } }).ok, table).toBe(true);
        expect(rowsOf(run({ grant, kind: 'read', table, limit: 10 })), table).toHaveLength(1);
      }
    });

    it('refuses both a read and a write with no grant, before the table is touched', () => {
      for (const { table, row } of ROUND_TRIPS) {
        const ops: readonly BrokerOp[] = [
          { grant: 'nobody', kind: 'read', table, limit: 10 },
          { grant: 'nobody', kind: 'insert', table, row: { ...row } },
        ];
        for (const op of ops) {
          expect(refusalOf(run(op))).toEqual({ ok: false, reason: 'no_grant', table });
        }
        expect(stored(table), table).toEqual([]);
      }
    });

    it('refuses a grant that names other tables but not this one', () => {
      // The acceptance shape §3 names: an op outside the grant is refused `table_not_granted`, and
      // the grant covering a SIBLING site table is the sharpest version of it — three names that
      // arrived together are still three separate keys.
      for (const { table, row } of ROUND_TRIPS) {
        const others = SITE_TABLES.filter((t) => t !== table);
        const grant = token('readwrite', [...others, 'studio_runs']);
        expect(refusalOf(run({ grant, kind: 'read', table, limit: 10 }))).toEqual({
          ok: false,
          reason: 'table_not_granted',
          table,
        });
        expect(refusalOf(run({ grant, kind: 'insert', table, row: { ...row } }))).toEqual({
          ok: false,
          reason: 'table_not_granted',
          table,
        });
        expect(stored(table), table).toEqual([]);
      }
    });

    it('lets a read-only grant read but not write — and the refusal leaves no residue', () => {
      const writer = token('readwrite');
      for (const { table, row } of ROUND_TRIPS) {
        run({ grant: writer, kind: 'insert', table, row: { ...row } });
      }
      const readOnly = token('read');

      for (const { table, row, where, update } of ROUND_TRIPS) {
        const before = stored(table);
        expect(rowsOf(run({ grant: readOnly, kind: 'read', table, limit: 10 })), table).toHaveLength(1);

        // All three write kinds, because the profile surface uses all three: adding a row, editing
        // visibility or a scope, and a person deleting any of it from the privacy dashboard.
        const writes: readonly BrokerOp[] = [
          { grant: readOnly, kind: 'insert', table, row: { ...row, ...nextKey(table) } },
          { grant: readOnly, kind: 'update', table, row: update, where },
          { grant: readOnly, kind: 'delete', table, where },
        ];
        for (const op of writes) {
          expect(refusalOf(run(op)), `${table}/${op.kind}`).toEqual({
            ok: false,
            reason: 'write_not_granted',
            table,
          });
        }
        expect(stored(table), table).toEqual(before);
      }
    });

    it('refuses a revoked grant, so unpairing closes the profile layer in both directions', () => {
      const grant = token('readwrite');
      for (const { table, row } of ROUND_TRIPS) run({ grant, kind: 'insert', table, row: { ...row } });
      grants.revoke(grant, 'unpaired');

      for (const { table, row } of ROUND_TRIPS) {
        const ops: readonly BrokerOp[] = [
          { grant, kind: 'read', table, limit: 10 },
          { grant, kind: 'insert', table, row: { ...row, ...nextKey(table) } },
        ];
        for (const op of ops) {
          expect(refusalOf(run(op)), table).toEqual({ ok: false, reason: 'grant_revoked', table });
        }
        expect(stored(table), table).toHaveLength(1);
      }
    });

    it('is in the closed table set, so a grant over every shared table reaches all three', () => {
      // Named rather than counted: a table dropping out of the contract has to be noticed here, not
      // silently stop being reachable by an app that still has a screen for it.
      for (const table of SITE_TABLES) expect(BROKER_TABLES).toContain(table);
    });
  });

  describe('round trip — insert, select, update, delete, on a real migrated database', () => {
    for (const { table, row, where, update } of ROUND_TRIPS) {
      it(`round-trips ${table}`, () => {
        const grant = token('readwrite');

        // 1. INSERT — every pinned column, so a dropped one is a bind error rather than a NULL.
        expect(run({ grant, kind: 'insert', table, row: { ...row } }).ok).toBe(true);

        // 2. SELECT — the cells come back as written, past no domain layer that could reshape them.
        const [read] = rowsOf(run({ grant, kind: 'read', table, where, limit: 10 }));
        expect(read).toMatchObject(row);

        // 3. UPDATE — the edits the profile card makes: a visibility change, a widened scope, a
        //    re-link's instant. In place, because none of these three tables is revise-chained —
        //    the record of what a person once meant lives in the annotation and memory layers.
        expect(run({ grant, kind: 'update', table, row: update, where }).ok).toBe(true);
        expect(rowsOf(run({ grant, kind: 'read', table, where, limit: 10 }))[0]).toMatchObject(update);

        // 4. DELETE — "one button deletes any of it" (3aq footer, law 11) reaches the storage.
        expect(run({ grant, kind: 'delete', table, where }).ok).toBe(true);
        expect(rowsOf(run({ grant, kind: 'read', table, limit: 10 }))).toEqual([]);
        expect(stored(table)).toEqual([]);
      });
    }

    it('keeps a profile, its grants and its memory links independently deletable', () => {
      // The junction is a reference, not an ownership edge: there is no FK and no cascade, so
      // deleting a profile row leaves the links and grants for the domain layer to reconcile. Pinned
      // because the opposite — a cascade nobody declared — would silently destroy a person's grants.
      const grant = token('readwrite');
      for (const { table, row } of ROUND_TRIPS) run({ grant, kind: 'insert', table, row: { ...row } });

      expect(run({ grant, kind: 'delete', table: 'studio_site_profiles', where: { domain: PROFILE.domain } }).ok).toBe(
        true,
      );
      expect(stored('studio_site_profiles')).toEqual([]);
      expect(stored('studio_site_grants')).toHaveLength(1);
      expect(stored('studio_site_memories')).toHaveLength(1);
    });

    it('scopes a grant listing to one domain, newest last, without a range filter on the wire', () => {
      const grant = token('readwrite');
      const rows = [
        { ...GRANT_ROW, id: 'sg-a', granted_at: GRANT_ROW.granted_at + 2_000 },
        { ...GRANT_ROW, id: 'sg-b', granted_at: GRANT_ROW.granted_at + 1_000 },
        { ...GRANT_ROW, id: 'sg-other', domain: 'mail.google.com' },
      ];
      for (const row of rows) run({ grant, kind: 'insert', table: 'studio_site_grants', row });

      expect(
        rowsOf(
          run({ grant, kind: 'read', table: 'studio_site_grants', where: { domain: 'expensify.com' }, limit: 100 }),
        ).map((r) => r.id),
      ).toEqual(['sg-b', 'sg-a']);
      // A domain nobody has granted is an empty layer, not an error — the ordinary case on every
      // site a person has never opened a grant card for.
      expect(
        rowsOf(run({ grant, kind: 'read', table: 'studio_site_grants', where: { domain: 'example.com' }, limit: 100 })),
      ).toEqual([]);
    });

    it('walks the junction in both directions with equality reads alone', () => {
      const grant = token('readwrite');
      for (const row of [
        LINK,
        { ...LINK, memory_id: 'mem-other' },
        { ...LINK, domain: 'mail.google.com' },
      ]) {
        run({ grant, kind: 'insert', table: 'studio_site_memories', row });
      }

      // Forward: what this site remembers. Reverse: which sites reference this memory — the question
      // deleting a memory has to ask. Both are ordinary `where` reads; there is no join on the wire.
      expect(
        rowsOf(
          run({ grant, kind: 'read', table: 'studio_site_memories', where: { domain: LINK.domain }, limit: 100 }),
        ).map((r) => r.memory_id),
      ).toEqual(['mem-7fq2', 'mem-other']);
      expect(
        rowsOf(
          run({
            grant,
            kind: 'read',
            table: 'studio_site_memories',
            where: { memory_id: LINK.memory_id },
            limit: 100,
          }),
        ).map((r) => r.domain),
      ).toEqual(['expensify.com', 'mail.google.com']);
    });
  });

  describe('what this wire deliberately does NOT decide', () => {
    it('takes no cursor on the profile table: the key is opaque TEXT, so paging is limit + where', () => {
      const grant = token('readwrite');
      run({ grant, kind: 'insert', table: 'studio_site_profiles', row: { ...PROFILE } });

      // A protocol error, not a refusal, and deliberately not a silently ignored bound — a bound the
      // broker dropped would re-serve page one forever. §3 pins that the profile listing narrows with
      // `where` and slices client-side instead, exactly as the memories layer does.
      for (const table of ['studio_site_profiles', 'studio_site_memories', 'studio_site_grants'] as const) {
        expect(() => run({ grant, kind: 'read', table, limit: 10, since: 0 }), table).toThrow(BrokerOpError);
      }
    });

    it('rejects a column the table does not have as a malformed op, not an access decision', () => {
      const grant = token('readwrite');
      // `expires_at` is a studio_memories column. Naming it here is the shape of a companion that
      // pasted the wrong table's row builder, and it must not read as an access refusal. It is also
      // why the column set is pinned so tightly one file over: drift is a throw on the wire.
      expect(() =>
        run({
          grant,
          kind: 'insert',
          table: 'studio_site_profiles',
          row: { ...PROFILE, expires_at: PROFILE.created_at + 86_400_000 },
        }),
      ).toThrow(BrokerOpError);
      expect(stored('studio_site_profiles')).toEqual([]);
    });

    it('cannot enforce the human-only grant writer, because it cannot see an actor', () => {
      // §3's grant posture — a person writes "remember for this site", the same AgentWriteRefusedError
      // shape the auth-origin ledger holds — is a law-12 control, and it is NOT here. A broker op
      // names a table and carries cells; there is no actor on the wire to test, so any check written
      // here would be decided by whatever the caller claimed. Asserted as an explicit absence so the
      // posture is not mistaken for shipped: it lands in the domain module, where the driver is known.
      const grant = token('readwrite');
      expect(
        run({ grant, kind: 'insert', table: 'studio_site_grants', row: { ...GRANT_ROW, writer: 'agent' } }).ok,
      ).toBe(true);
      expect(stored('studio_site_grants')[0]).toMatchObject({ writer: 'agent' });
    });

    it('cannot increment run_count atomically, so the fold stays a serialised read-modify-write', () => {
      // BrokerWriteOp.row binds literal cells and has no expression language, so there is no
      // `run_count = run_count + 1` on this wire and none is wanted here. Pinned as an absence
      // because the alternative — a domain method on the broker — is what D8 forbids.
      const grant = token('readwrite');
      run({ grant, kind: 'insert', table: 'studio_site_profiles', row: { ...PROFILE } });

      const current = rowsOf(
        run({ grant, kind: 'read', table: 'studio_site_profiles', where: { domain: PROFILE.domain }, limit: 1 }),
      )[0]!.run_count as number;
      expect(
        run({
          grant,
          kind: 'update',
          table: 'studio_site_profiles',
          row: { run_count: current + 1 },
          where: { domain: PROFILE.domain },
        }).ok,
      ).toBe(true);
      expect(stored('studio_site_profiles')[0]).toMatchObject({ run_count: PROFILE.run_count + 1 });
    });

    it('carries no cell that could hold a credential on any of the three tables', () => {
      // Structural rather than conventional, and asserted at the SEAM as well as at the schema: a
      // profile is portable, so a column able to hold a cookie or a clearance value would make an
      // exported profile a portable auth artifact.
      const grant = token('readwrite');
      for (const { table, row } of ROUND_TRIPS) run({ grant, kind: 'insert', table, row: { ...row } });

      for (const table of SITE_TABLES) {
        for (const key of Object.keys(rowsOf(run({ grant, kind: 'read', table, limit: 10 }))[0] ?? {})) {
          expect(key, `${table}.${key}`).not.toMatch(
            /cookie|password|passwd|token|secret|credential|clearance|session_?id|bearer/i,
          );
        }
      }
    });
  });

  /** A second row for a table, differing only in its key — used where a write must be attempted twice. */
  function nextKey(table: BrokerTable): Record<string, string> {
    if (table === 'studio_site_profiles') return { domain: 'second.example' };
    if (table === 'studio_site_grants') return { id: 'sg-2' };
    return { memory_id: 'mem-second' };
  }
});
