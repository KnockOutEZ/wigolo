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
 * SD9 §4 (A-420-4) — the three new SD9 stores at the seam the companion actually reaches them
 * through: voice profiles (3ac), site widgets (3af) and the reading queue (3ag).
 *
 * Their SEMANTICS belong to studio-core, which owns CRUD over this wire (SD9-B3/B4/P1): the broker
 * is dumb by design (D8) and will never grow a domain method for any of them. What core owes, and
 * what these cases pin, is that the three tables it ships can CARRY those semantics and that a grant
 * is the only key to them in both modes — a store the companion could read but not write would ship
 * the compose surface, the widget authoring card and the reading rail as displays of rows nothing
 * can populate, and nothing but a test says which modes are live.
 *
 * Written against a REAL migrated database rather than a stub, for the reason the memories,
 * annotations and site-profile suites are: schema tolerance is a property of the migration file, and
 * a stub agrees with whatever this repo believes today.
 */
describe('the SD9 tables over the companion broker', () => {
  const originalEnv = process.env;
  let grants: BrokerGrantStore;

  const SD9_TABLES = ['studio_voice_profiles', 'studio_site_widgets', 'studio_reading_queue'] as const;

  /** A writing-tone profile as the compose surface learns one (3ac) — every pinned column. */
  const VOICE = Object.freeze({
    domain: 'linkedin.com',
    surface: 'post_composer',
    name: 'measured',
    exemplars: JSON.stringify(['Shipped the migration layer today.', 'Happy to walk anyone through it.']),
    learned_at: 1_700_000_000_000,
  });

  /** A declarative widget as the authoring card stores one (3af). */
  const WIDGET = Object.freeze({
    domain: 'tesco.com',
    name: 'unit price per kg',
    binds: 'li.product-tile',
    fields: JSON.stringify([{ name: 'price', expression: 'text(.price)' }]),
    template: '{{ price }} per kg',
    enabled: 1,
    created_at: 1_700_000_001_000,
  });

  /** An agent-saved queue row, attributed to the run that saved it (3ag). */
  const ITEM = Object.freeze({
    url: 'https://sqlite.org/lang_createtable.html',
    title: 'CREATE TABLE',
    added_by: 'run-9k1x',
    summary: 'How SQLite decides a rowid alias.',
    claims_flagged: 2,
    state: 'queued',
    added_at: 1_700_000_002_000,
  });

  /** Each table with the row that exercises it, its key columns, and a cell an update may change. */
  interface RoundTrip {
    table: BrokerTable;
    row: BrokerRow;
    where: BrokerRow;
    update: BrokerRow;
  }

  const ROUND_TRIPS: readonly RoundTrip[] = [
    {
      table: 'studio_voice_profiles' as const,
      row: VOICE,
      where: { domain: VOICE.domain, surface: VOICE.surface, name: VOICE.name },
      update: { exemplars: JSON.stringify(['One more thing I actually wrote here.']) },
    },
    {
      table: 'studio_site_widgets' as const,
      row: WIDGET,
      where: { domain: WIDGET.domain, name: WIDGET.name },
      update: { enabled: 0 },
    },
    {
      table: 'studio_reading_queue' as const,
      row: ITEM,
      where: { url: ITEM.url },
      update: { state: 'archived', claims_flagged: 3 },
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

  /** A second row for a table, differing only in its key — used where a write must be attempted twice. */
  function nextKey(table: BrokerTable): Record<string, string> {
    if (table === 'studio_voice_profiles') return { name: 'warm' };
    if (table === 'studio_site_widgets') return { name: 'price history' };
    return { url: 'https://example.com/second' };
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

  describe('the two arms of putting a table on this wire', () => {
    it('serves table-scoped reads and writes on all three, now that they are in the contract', () => {
      const grant = token('readwrite');
      for (const { table, row } of ROUND_TRIPS) {
        expect(run({ grant, kind: 'insert', table, row: { ...row } }).ok, table).toBe(true);
        expect(rowsOf(run({ grant, kind: 'read', table, limit: 10 })), table).toHaveLength(1);
      }
    });

    it('refuses a MIGRATED table that is not in the contract as unknown_table', () => {
      // The arm the three tables were in before this change, demonstrated on a table that is still
      // in it. studio_visits exists in this very database — 021 created it — and is deliberately
      // off the wire (A-18-5: history-with-content is what a HUMAN read, and law 4 keeps that
      // invisible to every agent). So the refusal is decided by CONTRACT MEMBERSHIP, not by whether
      // the storage has the table: dropping one of the three names from BROKER_TABLES puts it
      // straight back here, which is what makes the arm above a real change rather than a migration
      // that happened to be reachable already.
      const grant = token('readwrite');
      for (const table of ['studio_visits', 'studio_not_a_table'] as unknown as BrokerTable[]) {
        expect(refusalOf(run({ grant, kind: 'read', table, limit: 10 })), table).toEqual({
          ok: false,
          reason: 'unknown_table',
        });
        expect(refusalOf(run({ grant, kind: 'insert', table, row: { url: 'https://example.com' } })), table).toEqual({
          ok: false,
          reason: 'unknown_table',
        });
      }
      // The control really is a table this database has, so the case above is about the contract.
      expect(db().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='studio_visits'").get())
        .toBeDefined();
      expect(BROKER_TABLES as readonly string[]).not.toContain('studio_visits');
    });

    it('is in the closed table set, so a grant over every shared table reaches all three', () => {
      // Named rather than counted: a table dropping out of the contract has to be noticed here, not
      // silently stop being reachable by an app that still has a screen for it.
      for (const table of SD9_TABLES) expect(BROKER_TABLES).toContain(table);
    });
  });

  describe('grant scoping — read AND write, on all three', () => {
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
      // Three names that arrived in one slice are still three separate keys — the sharpest version
      // of `table_not_granted` is a grant covering the two SIBLING SD9 tables.
      for (const { table, row } of ROUND_TRIPS) {
        const others = SD9_TABLES.filter((t) => t !== table);
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

        // All three write kinds, because each surface uses all three: learning a profile, toggling a
        // widget, archiving a queue row, and a person deleting any of it from the privacy dashboard.
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

    it('refuses a revoked grant, so unpairing closes all three layers in both directions', () => {
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

        // 3. UPDATE — the edits each surface makes: learning one more exemplar, disabling a widget,
        //    archiving a queue row. In place, because none of these three is revise-chained — the
        //    record of what a person once meant lives in the annotation and memory layers.
        expect(run({ grant, kind: 'update', table, row: update, where }).ok).toBe(true);
        expect(rowsOf(run({ grant, kind: 'read', table, where, limit: 10 }))[0]).toMatchObject(update);

        // 4. DELETE — "one button deletes any of it" (3aq footer, law 11) reaches the storage. Voice
        //    profiles are privacy-dashboard class data, so this is the affordance, not a nicety.
        expect(run({ grant, kind: 'delete', table, where }).ok).toBe(true);
        expect(rowsOf(run({ grant, kind: 'read', table, limit: 10 }))).toEqual([]);
        expect(stored(table)).toEqual([]);
      });
    }

    it('keeps a site\'s voice profiles enumerable and individually deletable', () => {
      // A-17-5 posture: profiles are user-visible, enumerable and deletable. Enumerable per SITE is
      // what the picker and the privacy dashboard both need, and deleting one must not take the
      // surface's other tones with it.
      const grant = token('readwrite');
      for (const row of [VOICE, { ...VOICE, name: 'warm' }, { ...VOICE, domain: 'slack.com', name: 'terse' }]) {
        run({ grant, kind: 'insert', table: 'studio_voice_profiles', row });
      }
      expect(
        rowsOf(
          run({ grant, kind: 'read', table: 'studio_voice_profiles', where: { domain: VOICE.domain }, limit: 100 }),
        ).map((r) => r.name),
      ).toEqual(['measured', 'warm']);

      expect(
        run({
          grant,
          kind: 'delete',
          table: 'studio_voice_profiles',
          where: { domain: VOICE.domain, surface: VOICE.surface, name: 'warm' },
        }).ok,
      ).toBe(true);
      expect(stored('studio_voice_profiles').map((r) => r.name)).toEqual(['measured', 'terse']);
    });

    it('reads a site\'s enabled widgets, which is the whole of the on-load query', () => {
      // U4a runs widgets locally on load with zero network: the read is one equality pair, and the
      // broker's `where` is exactly that. A disabled widget staying stored rather than deleted is
      // why `enabled` is a column and not an absence.
      const grant = token('readwrite');
      for (const row of [
        WIDGET,
        { ...WIDGET, name: 'price history', enabled: 0 },
        { ...WIDGET, domain: 'sainsburys.co.uk', name: 'unit price per kg' },
      ]) {
        run({ grant, kind: 'insert', table: 'studio_site_widgets', row });
      }
      expect(
        rowsOf(
          run({
            grant,
            kind: 'read',
            table: 'studio_site_widgets',
            where: { domain: WIDGET.domain, enabled: 1 },
            limit: 100,
          }),
        ).map((r) => r.name),
      ).toEqual(['unit price per kg']);
    });

    it('attributes agent-saved queue rows to their run, and human saves to no run', () => {
      // Law 1 read back at the wire: "3 more from run 9k1x" is an equality read on added_by, and a
      // human save carries the literal `human` rather than an invented run id.
      const grant = token('readwrite');
      for (const row of [
        ITEM,
        { ...ITEM, url: 'https://example.com/b' },
        { ...ITEM, url: 'https://example.com/c', added_by: 'human' },
      ]) {
        run({ grant, kind: 'insert', table: 'studio_reading_queue', row });
      }
      expect(
        rowsOf(
          run({ grant, kind: 'read', table: 'studio_reading_queue', where: { added_by: 'run-9k1x' }, limit: 100 }),
        ),
      ).toHaveLength(2);
      expect(
        rowsOf(
          run({ grant, kind: 'read', table: 'studio_reading_queue', where: { added_by: 'human' }, limit: 100 }),
        ).map((r) => r.url),
      ).toEqual(['https://example.com/c']);
    });

    it('saves a queue row with the local model absent, so an unavailable summariser costs no item', () => {
      // SD9-B4's acceptance shape at the seam core owns: the save is an ordinary insert that omits
      // `summary`, and it must succeed. A NOT NULL column would have made summarise-on-save a
      // precondition of saving at all.
      const grant = token('readwrite');
      const { summary, ...withoutSummary } = ITEM;
      expect(summary).toBeTruthy();
      expect(run({ grant, kind: 'insert', table: 'studio_reading_queue', row: withoutSummary }).ok).toBe(true);
      expect(stored('studio_reading_queue')[0]).toMatchObject({ summary: null, state: 'queued' });
    });
  });

  describe('what this wire deliberately does NOT decide', () => {
    it('pages the reading queue by cursor, and refuses one on the other two', () => {
      // The one SD9 table that grows without bound in append order gets a real cursor; the two
      // TEXT-keyed stores get a protocol error rather than a silently ignored bound, because a
      // bound the broker dropped would re-serve page one forever.
      const grant = token('readwrite');
      const urls = ['a', 'b', 'c'].map((s) => `https://example.com/${s}`);
      for (const url of urls) run({ grant, kind: 'insert', table: 'studio_reading_queue', row: { ...ITEM, url } });

      const all = rowsOf(run({ grant, kind: 'read', table: 'studio_reading_queue', limit: 100 }));
      expect(all.map((r) => r.url)).toEqual(urls);
      expect(
        rowsOf(
          run({
            grant,
            kind: 'read',
            table: 'studio_reading_queue',
            limit: 100,
            since: all[0]!.id as number,
          }),
        ).map((r) => r.url),
      ).toEqual(urls.slice(1));

      for (const table of ['studio_voice_profiles', 'studio_site_widgets'] as const) {
        expect(() => run({ grant, kind: 'read', table, limit: 10, since: 0 }), table).toThrow(BrokerOpError);
      }
    });

    it('rejects a column the table does not have as a malformed op, not an access decision', () => {
      const grant = token('readwrite');
      // `expires_at` is a studio_memories column. Naming it here is the shape of a companion that
      // pasted the wrong table's row builder, and it must not read as an access refusal. It is also
      // why the column sets are pinned so tightly in the migration suites: drift is a throw on the wire.
      for (const { table, row } of ROUND_TRIPS) {
        expect(() => run({ grant, kind: 'insert', table, row: { ...row, expires_at: 1 } }), table).toThrow(
          BrokerOpError,
        );
        expect(stored(table), table).toEqual([]);
      }
    });

    it('cannot enforce that a voice profile was learned by a human, because it sees no actor', () => {
      // 3ac's law — nothing is learned silently; `+ learn from this field` is an explicit human act
      // — is a law-12 control, and it is NOT here. A broker op names a table and carries cells;
      // there is no actor on the wire to test, so any check written here would be decided by
      // whatever the caller claimed. Asserted as an explicit absence so the posture is not mistaken
      // for shipped: it lands in the domain module (SD9-B3), where the driver is known.
      const grant = token('readwrite');
      expect(run({ grant, kind: 'insert', table: 'studio_voice_profiles', row: { ...VOICE } }).ok).toBe(true);
      expect(stored('studio_voice_profiles')).toHaveLength(1);
    });

    it('carries no cell that could hold a credential on any of the three tables', () => {
      // Structural rather than conventional, and asserted at the SEAM as well as at the schema: a
      // widget is exportable and a profile is privacy-dashboard class data, so a column able to hold
      // a cookie or a clearance value would make either a portable auth artifact.
      const grant = token('readwrite');
      for (const { table, row } of ROUND_TRIPS) run({ grant, kind: 'insert', table, row: { ...row } });

      for (const table of SD9_TABLES) {
        for (const key of Object.keys(rowsOf(run({ grant, kind: 'read', table, limit: 10 }))[0] ?? {})) {
          expect(key, `${table}.${key}`).not.toMatch(
            /cookie|password|passwd|token|secret|credential|clearance|session_?id|bearer/i,
          );
        }
      }
    });
  });
});
