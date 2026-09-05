import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { MIGRATIONS, applyMigrations, _resetMigrationGuard } from '../../../src/cache/migrations/runner.js';
import { BROKER_TABLES } from '../../../src/companion-contract/broker.js';

/**
 * SD4 §4.1 (A-15-4) — the annotation layer's schema half.
 *
 * The column set is the contract, not an implementation detail: §4.1 names it verbatim and the
 * domain module that lands next (#399) writes exactly these cells over a dumb broker that reads
 * the column list off the file. So a dropped, renamed or retyped column here is a silent wire
 * break rather than a local edit, and this suite pins every one of them.
 *
 * The other half — that a grant is the only key to those cells, in both modes — is pinned over
 * real broker ops in `tests/integration/studio-annotations-broker.test.ts`.
 */

const NAME = '023-studio-annotations';

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

function columnsOf(db: Database.Database, table: string): ColumnInfo[] {
  return db.pragma(`table_info(${table})`) as ColumnInfo[];
}

function freshDb(): Database.Database {
  _resetMigrationGuard();
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyMigrations(db, { vecLoaded: false });
  return db;
}

/**
 * Apply every migration EXCEPT the one under test, recording each as applied — the shape of a
 * user database that has been running since before this migration existed. A fresh DB proves the
 * CREATE works, not that it forward-applies onto history.
 */
function seedThroughPrior(db: Database.Database): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  for (const m of MIGRATIONS) {
    if (m.name === NAME) break;
    if (m.requiresVec) continue;
    db.transaction(() => {
      db.exec(m.sql);
      m.postStep?.(db);
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(m.name, 1);
    })();
  }
}

/** One annotation as §4.1 shapes it — every column, so a dropped one shows up as a bind error. */
const ROW = Object.freeze({
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

function insert(db: Database.Database, row: Record<string, unknown>): void {
  const columns = Object.keys(row);
  db.prepare(
    `INSERT INTO studio_annotations (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
  ).run(...columns.map((c) => row[c] as never));
}

function planFor(db: Database.Database, sql: string, ...params: unknown[]): string {
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])) as Array<{ detail: string }>;
  return plan.map((r) => r.detail).join(' | ');
}

describe('023-studio-annotations migration', () => {
  let dir: string;

  beforeEach(() => {
    _resetMigrationGuard();
    dir = mkdtempSync(join(tmpdir(), 'wigolo-mig-023-'));
  });

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('claims a migration name that has never existed (D15 rename-nothing)', () => {
    const names = MIGRATIONS.map((m) => m.name);
    // Name-keyed, NOT number-ordered: duplicate numeric prefixes already exist on disk
    // (008-* and 010-* each appear twice), so a numeric check would pass on a real collision.
    expect(names.filter((n) => n === NAME)).toHaveLength(1);
    expect(new Set(names).size).toBe(names.length);
  });

  it('keeps the .sql mirror byte-identical to the registered constant', () => {
    const entry = MIGRATIONS.find((m) => m.name === NAME);
    expect(entry).toBeDefined();
    const onDisk = readFileSync(new URL(`../../../src/cache/migrations/${NAME}.sql`, import.meta.url), 'utf8');
    // The registry is the executed copy and the .sql file is the reviewable one. Drift between
    // them means a reviewer reads a schema no machine ever applied.
    expect(onDisk.trim()).toBe(entry!.sql.trim());
  });

  it('creates studio_annotations with the §4.1 column set, verbatim and in order', () => {
    const db = freshDb();
    // Types, nullability, the default and the primary key are all asserted, not just the names:
    // #399 writes these cells through a broker that reads the column list off this file, so a
    // retyped column is a wire break that no other test would see.
    expect(
      columnsOf(db, 'studio_annotations').map((c) => ({
        name: c.name,
        type: c.type,
        notnull: c.notnull,
        dflt_value: c.dflt_value,
        pk: c.pk,
      })),
    ).toEqual([
      { name: 'id', type: 'TEXT', notnull: 0, dflt_value: null, pk: 1 },
      { name: 'url_pattern', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
      { name: 'kind', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
      { name: 'target', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
      { name: 'region', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
      { name: 'body', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
      { name: 'author', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
      { name: 'author_driver', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
      { name: 'source_run_id', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
      { name: 'created_at', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 },
      { name: 'supersedes', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
      { name: 'status', type: 'TEXT', notnull: 1, dflt_value: "'active'", pk: 0 },
    ]);
    db.close();
  });

  it('forward-applies onto a database that predates it, without re-running its history', () => {
    const db = new Database(join(dir, 'cache.db'));
    db.pragma('foreign_keys = ON');
    seedThroughPrior(db);
    expect(columnsOf(db, 'studio_annotations')).toHaveLength(0);

    _resetMigrationGuard();
    applyMigrations(db, { vecLoaded: false });

    expect(columnsOf(db, 'studio_annotations').map((c) => c.name)).toContain('supersedes');
    const applied = db
      .prepare('SELECT name FROM schema_migrations WHERE name = ?')
      .all(NAME) as Array<{ name: string }>;
    expect(applied).toHaveLength(1);
    db.close();
  });

  it('defaults status to active, so an omitted status is a live row and never a NULL', () => {
    const db = freshDb();
    const { status: _dropped, ...withoutStatus } = ROW;
    insert(db, withoutStatus);
    expect(
      (db.prepare('SELECT status FROM studio_annotations WHERE id = ?').get('an-1') as { status: string }).status,
    ).toBe('active');
    db.close();
  });

  it('accepts every §4.1 kind, because the closed set lives with the writer and not in a CHECK', () => {
    const db = freshDb();
    // D15 makes a released migration's text history: a CHECK freezing today's eight kinds into
    // the file would make the ninth a table rebuild on every existing database. This asserts the
    // absence is real — all eight land, and so does a kind this core has never heard of, which is
    // what lets an app one migration ahead of the core it paired into write at all.
    const kinds = ['mark', 'note', 'ink', 'label', 'fence', 'redact', 'scope', 'assert', 'kind-from-the-future'];
    for (const [i, kind] of kinds.entries()) insert(db, { ...ROW, id: `an-${i}`, kind });
    expect(db.prepare('SELECT COUNT(*) AS n FROM studio_annotations').get()).toEqual({ n: kinds.length });
    db.close();
  });

  it('rejects a row missing url_pattern, kind, author or created_at', () => {
    const db = freshDb();
    for (const column of ['url_pattern', 'kind', 'author', 'created_at'] as const) {
      expect(() => insert(db, { ...ROW, [column]: null }), `${column} must be NOT NULL`).toThrow(/NOT NULL/);
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM studio_annotations').get()).toEqual({ n: 0 });
    db.close();
  });

  it('serves the whole-layer listing from the url index with no sort step', () => {
    const db = freshDb();
    // The index ends in created_at, so "what is on this page right now, in order" is the same
    // traversal as the seek. A TEMP B-TREE here means every page open pays a full sort.
    const detail = planFor(
      db,
      'SELECT * FROM studio_annotations WHERE status = ? AND url_pattern = ? ORDER BY created_at',
      'active',
      ROW.url_pattern,
    );
    expect(detail).toContain('idx_studio_annotations_url');
    expect(detail).not.toContain('SCAN studio_annotations');
    expect(detail).not.toContain('TEMP B-TREE');
    db.close();
  });

  it('serves the provenance walk from the partial supersedes index', () => {
    const db = freshDb();
    const detail = planFor(db, 'SELECT * FROM studio_annotations WHERE supersedes = ?', 'an-1');
    expect(detail).toContain('idx_studio_annotations_supersedes');
    expect(detail).not.toContain('SCAN studio_annotations');
    db.close();
  });

  it('keeps the supersedes index partial, so an unrevised row never enters it', () => {
    const db = freshDb();
    // Asserted against the index the database actually built, not against rows read back through
    // it: an unrevised row is excluded by `supersedes IS NOT NULL` in the QUERY too, so any
    // row-level check agrees with itself whether the index is partial or full. The predicate in
    // the b-tree's own definition is the only place partialness is visible.
    const ddl = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get('idx_studio_annotations_supersedes') as { sql: string } | undefined;
    expect(ddl?.sql).toMatch(/WHERE\s+supersedes\s+IS\s+NOT\s+NULL/i);

    // And the partial index still answers the walk it exists for — a predicate narrower than the
    // index's own would leave it unusable, which is the way this trade is normally got wrong.
    insert(db, ROW);
    insert(db, { ...ROW, id: 'an-2', supersedes: 'an-1' });
    expect(
      (db.prepare('SELECT id FROM studio_annotations WHERE supersedes = ?').all('an-1') as Array<{ id: string }>).map(
        (r) => r.id,
      ),
    ).toEqual(['an-2']);
    db.close();
  });

  it('is a SHARED table: the wire can name it (unlike the visits corpus)', () => {
    // studio_visits is off the wire by A-18-5 ruling; the annotation layer is the opposite case —
    // it is the shared address space (law 8), so an absence here would strand the surface.
    expect(BROKER_TABLES as readonly string[]).toContain('studio_annotations');
  });
});
