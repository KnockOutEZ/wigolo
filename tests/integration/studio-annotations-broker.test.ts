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
 * SD4 §4.1 (A-15-4) — the annotation layer, at the seam the companion actually reaches it through.
 *
 * The annotation SEMANTICS (a revise writes a new row carrying `supersedes` and archives the old;
 * policy-kind rows may be archived only by a human) belong to the domain module that consumes this
 * table (#399): the broker is dumb by design (D8) and will never grow a domain method. What core
 * owes, and what these cases pin, is that the table it ships can CARRY those semantics and that the
 * grant is the only key to them — a store the companion could read but not write would ship the
 * annotation layer as a display of rows nothing can add to, and nothing but a test says which modes
 * are live.
 *
 * Written against a REAL migrated database rather than a stub, for the reason the memories suite is:
 * schema tolerance is a property of the file, and a stub agrees with whatever this repo believes today.
 */
describe('studio_annotations over the companion broker', () => {
  const originalEnv = process.env;
  let grants: BrokerGrantStore;

  /** A human's note on an element, as the panel composer writes one — every pinned column. */
  const NOTE = Object.freeze({
    id: 'an-1',
    url_pattern: 'https://www.expensify.com/reports',
    kind: 'note',
    target: JSON.stringify({ role: 'button', name: 'Export', attrs: { type: 'submit' } }),
    region: null,
    body: 'this is the export button, not the print one',
    author: 'human',
    author_driver: null,
    source_run_id: 'run-7fq2',
    created_at: 1_700_000_000_000,
    supersedes: null,
    status: 'active',
  });

  /** An agent-authored restrictive row — law 12's safe direction, and the one that carries a driver. */
  const FENCE = Object.freeze({
    ...NOTE,
    id: 'an-fence',
    kind: 'fence',
    body: null,
    author: 'agent',
    author_driver: 'sdk',
    created_at: NOTE.created_at + 1_000,
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
      .prepare('SELECT * FROM studio_annotations ORDER BY created_at, id')
      .all() as BrokerRow[];
  }

  /** The layer as a surface reads it: active rows for one page, oldest first. */
  function listActive(grant: string, urlPattern: string = NOTE.url_pattern): readonly BrokerRow[] {
    return rowsOf(
      run({
        grant,
        kind: 'read',
        table: 'studio_annotations',
        where: { status: 'active', url_pattern: urlPattern },
        limit: 100,
      }),
    );
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

      expect(run({ grant, kind: 'insert', table: 'studio_annotations', row: { ...NOTE } }).ok).toBe(true);
      expect(rowsOf(run({ grant, kind: 'read', table: 'studio_annotations', limit: 10 }))).toHaveLength(1);
    });

    it('refuses both a read and a write with no grant, before the table is touched', () => {
      for (const op of [
        { grant: 'nobody', kind: 'read', table: 'studio_annotations', limit: 10 },
        { grant: 'nobody', kind: 'insert', table: 'studio_annotations', row: { ...NOTE } },
      ] as const) {
        expect(refusalOf(run(op))).toEqual({ ok: false, reason: 'no_grant', table: 'studio_annotations' });
      }
      expect(stored()).toEqual([]);
    });

    it('refuses a grant that names other tables but not this one', () => {
      const grant = token('readwrite', ['studio_runs']);

      expect(refusalOf(run({ grant, kind: 'read', table: 'studio_annotations', limit: 10 }))).toEqual({
        ok: false,
        reason: 'table_not_granted',
        table: 'studio_annotations',
      });
      expect(
        refusalOf(run({ grant, kind: 'insert', table: 'studio_annotations', row: { ...NOTE } })),
      ).toEqual({ ok: false, reason: 'table_not_granted', table: 'studio_annotations' });
      expect(stored()).toEqual([]);
    });

    it('lets a read-only grant read but not write — and the refusal leaves no residue', () => {
      run({ grant: token('readwrite'), kind: 'insert', table: 'studio_annotations', row: { ...NOTE } });
      const before = stored();

      const readOnly = token('read');
      expect(rowsOf(run({ grant: readOnly, kind: 'read', table: 'studio_annotations', limit: 10 }))).toHaveLength(1);

      // All three write kinds, because the annotation surface uses all three: adding a row,
      // archiving one, and a panel deleting a draft it never committed.
      for (const op of [
        { grant: readOnly, kind: 'insert', table: 'studio_annotations', row: { ...NOTE, id: 'an-2' } },
        {
          grant: readOnly,
          kind: 'update',
          table: 'studio_annotations',
          row: { status: 'archived' },
          where: { id: NOTE.id },
        },
        { grant: readOnly, kind: 'delete', table: 'studio_annotations', where: { id: NOTE.id } },
      ] as const) {
        expect(refusalOf(run(op))).toEqual({
          ok: false,
          reason: 'write_not_granted',
          table: 'studio_annotations',
        });
      }

      expect(stored()).toEqual(before);
    });

    it('refuses a revoked grant, so unpairing closes the layer in both directions', () => {
      const grant = token('readwrite');
      run({ grant, kind: 'insert', table: 'studio_annotations', row: { ...NOTE } });
      grants.revoke(grant, 'unpaired');

      for (const op of [
        { grant, kind: 'read', table: 'studio_annotations', limit: 10 },
        { grant, kind: 'insert', table: 'studio_annotations', row: { ...NOTE, id: 'an-2' } },
      ] as const) {
        expect(refusalOf(run(op))).toEqual({
          ok: false,
          reason: 'grant_revoked',
          table: 'studio_annotations',
        });
      }
      expect(stored()).toHaveLength(1);
    });

    it('is in the closed table set, so a grant over every shared table reaches it', () => {
      // Named rather than counted: a table dropping out of the contract has to be noticed here,
      // not silently stop being reachable by an app that still has a screen for it.
      expect(BROKER_TABLES).toContain('studio_annotations');
    });
  });

  describe('revise chain (§4.1) — a new row carrying supersedes, and the old one archived', () => {
    it('grant → insert → revise → list, the whole layer lifecycle over real ops', () => {
      // 1. GRANT — one readwrite token over the shared tables. Everything below is refused without it.
      const grant = token('readwrite');

      // 2. INSERT — the note as the panel composer saved it, plus an agent-authored fence on the
      //    same page: two authors, one layer, distinguished by `author` + `author_driver`.
      expect(run({ grant, kind: 'insert', table: 'studio_annotations', row: { ...NOTE } }).ok).toBe(true);
      expect(run({ grant, kind: 'insert', table: 'studio_annotations', row: { ...FENCE } }).ok).toBe(true);
      expect(listActive(grant).map((r) => r.id)).toEqual(['an-1', 'an-fence']);

      // 3. REVISE — a NEW row citing what it supersedes, then the old one archived. Never an
      //    in-place edit of `body`: the superseded wording is the record of what a person once
      //    meant, and an UPDATE that rewrote it would collapse the chain into an unverifiable claim.
      const REVISED = {
        ...NOTE,
        id: 'an-2',
        body: 'export is the LEFT button; the right one prints',
        created_at: NOTE.created_at + 60_000,
        supersedes: NOTE.id,
      };
      expect(run({ grant, kind: 'insert', table: 'studio_annotations', row: REVISED }).ok).toBe(true);
      expect(
        run({
          grant,
          kind: 'update',
          table: 'studio_annotations',
          row: { status: 'archived' },
          where: { id: NOTE.id },
        }).ok,
      ).toBe(true);

      // 4. THE CHAIN — both rows survive, the archived one kept ITS body and provenance, and the
      //    live one points back at what it replaced.
      const chain = stored();
      expect(chain).toHaveLength(3);
      expect(chain.find((r) => r.id === 'an-1')).toMatchObject({
        body: NOTE.body,
        author: 'human',
        source_run_id: 'run-7fq2',
        supersedes: null,
        status: 'archived',
      });
      expect(chain.find((r) => r.id === 'an-2')).toMatchObject({
        body: REVISED.body,
        supersedes: 'an-1',
        status: 'active',
      });

      // 5. LIST — the layer a surface now draws: the revision and the fence, never the superseded
      //    note. The surface goes quiet about it; the record does not.
      expect(listActive(grant).map((r) => r.id)).toEqual(['an-fence', 'an-2']);

      // 6. ARCHIVE the rest — the active layer empties while the whole history stays addressable,
      //    which is the entire point of append-plus-status.
      for (const id of ['an-fence', 'an-2']) {
        expect(
          run({ grant, kind: 'update', table: 'studio_annotations', row: { status: 'archived' }, where: { id } }).ok,
        ).toBe(true);
      }
      expect(listActive(grant)).toEqual([]);
      expect(stored()).toHaveLength(3);
    });

    it('walks a three-deep chain back to its origin by supersedes alone', () => {
      const grant = token('readwrite');
      const ids = ['v1', 'v2', 'v3'];
      for (const [i, id] of ids.entries()) {
        run({
          grant,
          kind: 'insert',
          table: 'studio_annotations',
          row: {
            ...NOTE,
            id,
            body: `version ${i + 1}`,
            created_at: NOTE.created_at + i * 1_000,
            supersedes: i === 0 ? null : ids[i - 1]!,
            status: i === ids.length - 1 ? 'active' : 'archived',
          },
        });
      }

      // The walk a provenance view makes: one equality read per hop, which is exactly what the
      // wire carries. No expression language, no recursive CTE over the broker.
      const walked: string[] = [];
      let cursor: string | null = 'v3';
      while (cursor) {
        const [row] = rowsOf(
          run({ grant, kind: 'read', table: 'studio_annotations', where: { id: cursor }, limit: 1 }),
        );
        expect(row).toBeDefined();
        walked.push(row!.id as string);
        cursor = (row!.supersedes as string | null) ?? null;
      }
      expect(walked).toEqual(['v3', 'v2', 'v1']);
    });

    it('scopes a listing to one page without a range filter on the wire', () => {
      const grant = token('readwrite');
      const rows = [
        { ...NOTE, id: 'reports-1', url_pattern: 'https://www.expensify.com/reports' },
        { ...NOTE, id: 'reports-2', url_pattern: 'https://www.expensify.com/reports', status: 'archived' },
        { ...NOTE, id: 'inbox-1', url_pattern: 'https://www.expensify.com/inbox' },
        { ...NOTE, id: 'other-1', url_pattern: 'https://mail.google.com/mail/u/0' },
      ];
      for (const row of rows) run({ grant, kind: 'insert', table: 'studio_annotations', row });

      expect(listActive(grant, 'https://www.expensify.com/reports').map((r) => r.id)).toEqual(['reports-1']);
      expect(listActive(grant, 'https://mail.google.com/mail/u/0').map((r) => r.id)).toEqual(['other-1']);
      // A pattern nobody has annotated is an empty layer, not an error — the ordinary case on
      // every page a person has never marked.
      expect(listActive(grant, 'https://example.com/')).toEqual([]);
    });

    it('carries a region row and an element row as distinguishable cells through the wire', () => {
      const grant = token('readwrite');
      const INK = {
        ...NOTE,
        id: 'an-ink',
        kind: 'ink',
        target: null,
        region: JSON.stringify({ strokes: [[12, 40], [96, 41]] }),
        body: null,
      };
      run({ grant, kind: 'insert', table: 'studio_annotations', row: { ...NOTE } });
      run({ grant, kind: 'insert', table: 'studio_annotations', row: INK });

      const byId = new Map(
        rowsOf(run({ grant, kind: 'read', table: 'studio_annotations', limit: 100 })).map((r) => [r.id, r]),
      );
      // Two nullable payload columns, not one blob: a reader tells an unanchored region row from an
      // element-anchored one without parsing either.
      expect(byId.get('an-1')).toMatchObject({ region: null, target: NOTE.target });
      expect(byId.get('an-ink')).toMatchObject({ target: null, region: INK.region });
    });

    it('takes no cursor: the id is opaque TEXT, so paging is limit + where, never since/before', () => {
      const grant = token('readwrite');
      run({ grant, kind: 'insert', table: 'studio_annotations', row: { ...NOTE } });

      // A protocol error, not a refusal, and deliberately not a silently ignored bound — a bound the
      // broker dropped would re-serve page one forever.
      expect(() =>
        run({ grant, kind: 'read', table: 'studio_annotations', limit: 10, since: 0 }),
      ).toThrow(BrokerOpError);
    });

    it('rejects a column the table does not have as a malformed op, not an access decision', () => {
      const grant = token('readwrite');
      // `expires_at` is a studio_memories column. Naming it here is the shape of a companion that
      // pasted the wrong table's row builder, and it must not read as an access refusal.
      expect(() =>
        run({
          grant,
          kind: 'insert',
          table: 'studio_annotations',
          row: { ...NOTE, expires_at: NOTE.created_at + 86_400_000 },
        }),
      ).toThrow(BrokerOpError);
      expect(stored()).toEqual([]);
    });
  });

  describe('what this wire deliberately does NOT decide', () => {
    it('cannot enforce the human-only archival of a policy row, because it cannot see an actor', () => {
      // §6's authorship asymmetry — agents may CREATE fence/redact/scope rows but only a human may
      // remove one — is a law-12 control, and it is NOT here. A broker op names a table and carries
      // cells; there is no actor on the wire to test, so any check written here would be decided by
      // whatever the caller claimed. Asserted as an explicit absence so the asymmetry is not
      // mistaken for shipped: it lands in the domain module (#399), above this seam, where the
      // driver is known.
      const grant = token('readwrite');
      run({ grant, kind: 'insert', table: 'studio_annotations', row: { ...FENCE } });

      expect(
        run({
          grant,
          kind: 'update',
          table: 'studio_annotations',
          row: { status: 'archived' },
          where: { id: FENCE.id },
        }).ok,
      ).toBe(true);
      expect(stored()[0]).toMatchObject({ id: FENCE.id, status: 'archived' });
    });

    it('serves the active-layer listing from migration 023’s index, sort-free', () => {
      // The read every page open pays. A TEMP B-TREE here means the layer sorts on every open, and
      // that is a property of the MIGRATION, so it is asserted about the migrated database's own
      // query plan rather than about SQL this test wrote.
      const plan = db()
        .prepare(
          'EXPLAIN QUERY PLAN SELECT * FROM studio_annotations WHERE status = ? AND url_pattern = ? ORDER BY created_at',
        )
        .all('active', NOTE.url_pattern) as Array<{ detail: string }>;
      const detail = plan.map((r) => r.detail).join(' | ');

      expect(detail).toContain('idx_studio_annotations_url');
      expect(detail).not.toContain('SCAN studio_annotations');
      expect(detail).not.toContain('TEMP B-TREE');
    });
  });
});
