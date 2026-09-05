import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { MIGRATIONS, applyMigrations, _resetMigrationGuard } from '../../../src/cache/migrations/runner.js';
import { BROKER_TABLES } from '../../../src/companion-contract/broker.js';

/**
 * SD9 §3 (3af, A-420-3/A-420-4) — the site-widget store's schema half.
 *
 * A widget is DECLARATIVE, never script: a selector to bind to, a set of extract-expressions, and a
 * template that renders the computed values as overlay chips. The law that matters here is 12 — a
 * widget computes from page data and renders chrome-side, so it can neither click, type, navigate
 * nor grant — and it holds structurally, because no column here can carry anything else.
 *
 * The column set is the contract: the domain module that lands app-side (SD9-P1) writes CLOSED row
 * literals of exactly these columns over a broker that reads the column list off this file and
 * throws `BrokerOpError` on a name it does not find. The grant half is pinned over real broker ops
 * in `tests/integration/studio-sd9-tables-broker.test.ts`.
 */

const NAME = '026-studio-site-widgets';

const TABLE = 'studio_site_widgets';

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

function shapeOf(db: Database.Database, table: string): ColumnInfo[] {
  return columnsOf(db, table).map((c) => ({
    name: c.name,
    type: c.type,
    notnull: c.notnull,
    dflt_value: c.dflt_value,
    pk: c.pk,
  }));
}

function freshDb(): Database.Database {
  _resetMigrationGuard();
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyMigrations(db, { vecLoaded: false });
  return db;
}

/**
 * Apply every migration EXCEPT the one under test, recording each as applied — the shape of a user
 * database that has been running since before this migration existed. A fresh DB proves the CREATE
 * works, not that it forward-applies onto history.
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

/** One widget as 3af shapes it — the unit-price chip, every column filled. */
const WIDGET = Object.freeze({
  domain: 'tesco.com',
  name: 'unit price per kg',
  binds: 'li.product-tile',
  fields: JSON.stringify([
    { name: 'price', expression: 'text(.price)' },
    { name: 'grams', expression: 'text(.weight)' },
  ]),
  template: '{{ price / (grams / 1000) }} per kg',
  enabled: 1,
  created_at: 1_700_000_000_000,
});

function insert(db: Database.Database, table: string, row: Record<string, unknown>): void {
  const columns = Object.keys(row);
  db.prepare(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
  ).run(...columns.map((c) => row[c] as never));
}

function planFor(db: Database.Database, sql: string, ...params: unknown[]): string {
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])) as Array<{ detail: string }>;
  return plan.map((r) => r.detail).join(' | ');
}

describe('026-studio-site-widgets migration', () => {
  let dir: string;

  beforeEach(() => {
    _resetMigrationGuard();
    dir = mkdtempSync(join(tmpdir(), 'wigolo-mig-026-'));
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
    // The registry is the executed copy and the .sql file is the reviewable one. Drift between them
    // means a reviewer reads a schema no machine ever applied.
    expect(onDisk.trim()).toBe(entry!.sql.trim());
  });

  it('creates studio_site_widgets with the 3af column set, verbatim and in order', () => {
    const db = freshDb();
    expect(shapeOf(db, TABLE)).toEqual([
      { name: 'domain', type: 'TEXT', notnull: 1, dflt_value: null, pk: 1 },
      { name: 'name', type: 'TEXT', notnull: 1, dflt_value: null, pk: 2 },
      { name: 'binds', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
      { name: 'fields', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
      { name: 'template', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
      { name: 'enabled', type: 'INTEGER', notnull: 1, dflt_value: '1', pk: 0 },
      { name: 'created_at', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 },
    ]);
    db.close();
  });

  it('forward-applies onto a database that predates it, without re-running its history', () => {
    const db = new Database(join(dir, 'cache.db'));
    db.pragma('foreign_keys = ON');
    seedThroughPrior(db);
    expect(columnsOf(db, TABLE)).toHaveLength(0);

    _resetMigrationGuard();
    applyMigrations(db, { vecLoaded: false });

    expect(columnsOf(db, TABLE)).not.toHaveLength(0);
    expect(
      db.prepare('SELECT name FROM schema_migrations WHERE name = ?').all(NAME) as Array<{ name: string }>,
    ).toHaveLength(1);
    db.close();
  });

  it('defaults a stored widget to enabled, because authoring already passed an approval card', () => {
    const db = freshDb();
    // A widget only reaches this table through an element-anchored approval (§7 approvals row), so a
    // row that arrived without an explicit flag is a live widget, not a dormant one. A NULL default
    // would additionally make "is this widget on" unanswerable on the row nobody has toggled.
    const { enabled, ...withoutFlag } = WIDGET;
    expect(enabled).toBe(1);
    insert(db, TABLE, withoutFlag);
    expect(db.prepare(`SELECT enabled FROM ${TABLE} WHERE domain = ?`).get(WIDGET.domain)).toEqual({ enabled: 1 });
    db.close();
  });

  it('rejects a row missing any NOT NULL column', () => {
    const db = freshDb();
    // Every one of these is load-bearing at render time: a widget with no binds selects nothing, one
    // with no fields computes nothing, one with no template renders nothing. A nullable column here
    // would let a half-authored widget reach the overlay and fail there instead of at the write.
    for (const column of ['domain', 'name', 'binds', 'fields', 'template', 'enabled', 'created_at']) {
      expect(() => insert(db, TABLE, { ...WIDGET, [column]: null }), `${TABLE}.${column}`).toThrow(/NOT NULL/);
    }
    expect(db.prepare(`SELECT COUNT(*) AS n FROM ${TABLE}`).get()).toEqual({ n: 0 });
    db.close();
  });

  it('makes re-authoring a widget name an edit of that widget, not a second one beside it', () => {
    const db = freshDb();
    insert(db, TABLE, WIDGET);
    // "Authored once" then edited: the same name on the same site is the SAME widget. A surrogate id
    // would let a re-author silently double the chips on every bound element.
    expect(() => insert(db, TABLE, { ...WIDGET, template: 'other' })).toThrow(/UNIQUE|PRIMARY KEY/i);
    // A different name here, and the same name on another site, are both genuinely new widgets.
    insert(db, TABLE, { ...WIDGET, name: 'price history' });
    insert(db, TABLE, { ...WIDGET, domain: 'sainsburys.co.uk' });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM ${TABLE}`).get()).toEqual({ n: 3 });
    db.close();
  });

  it('serves the on-load read from the key index, without an index bought for the enabled filter', () => {
    const db = freshDb();
    // The read every page load pays is "the enabled widgets for this domain". The primary key's own
    // index already makes the domain half a seek, and enabled is a residual over a range holding one
    // site's widgets — a handful of rows. A second index for that filter would be paid for by every
    // authoring write to save a scan nobody runs, so its ABSENCE is the design and is asserted here.
    const detail = planFor(db, `SELECT * FROM ${TABLE} WHERE domain = ? AND enabled = 1`, WIDGET.domain);
    expect(detail).toContain('USING INDEX');
    expect(detail).not.toContain(`SCAN ${TABLE}`);
    const indexes = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?").all(TABLE) as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    expect(indexes.filter((n) => !n.startsWith('sqlite_autoindex_'))).toEqual([]);
    db.close();
  });

  it('accepts an enabled value and an expression grammar this core has never heard of', () => {
    const db = freshDb();
    // No CHECK, for migration 023/024's D15/D8 reason, and core deliberately does not parse binds or
    // fields: the extract-expression grammar is the recipe class and belongs to the domain module. A
    // core that validated it here would owe a new migration every time that grammar gained a form.
    insert(db, TABLE, { ...WIDGET, domain: 'a.example', enabled: 2 });
    insert(db, TABLE, {
      ...WIDGET,
      domain: 'b.example',
      fields: JSON.stringify([{ name: 'x', expression: 'grammar-from-the-future(.y)' }]),
    });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM ${TABLE}`).get()).toEqual({ n: 2 });
    db.close();
  });

  it('has no column a widget could act, navigate or grant through', () => {
    const db = freshDb();
    // Law 12 held structurally rather than by convention. A widget is declarative: it computes from
    // page data and renders chrome-side. A column naming a script, a URL to open, an event to fire
    // or a permission would make the stored row itself the thing that acts, which is the failure
    // A-420-3 exists to prevent — and a stored widget is exportable (A-17-4), so it would travel.
    for (const column of columnsOf(db, TABLE)) {
      expect(column.name, column.name).not.toMatch(
        /script|javascript|eval|exec|command|onclick|handler|href|url|navigate|grant|permission/i,
      );
      expect(column.name, column.name).not.toMatch(
        /cookie|password|passwd|token|secret|credential|clearance|session_?id|bearer/i,
      );
    }
    db.close();
  });

  it('gives the table no integer key, so the wire can offer it no cursor', () => {
    const db = freshDb();
    // The broker ranges since/before over an INTEGER seq or id. A site's widget set is small and
    // read whole on load, so it needs no cursor, and a TEXT key would make > a string comparison
    // over an order nothing wrote in. The refusal that produces is pinned in the integration suite.
    const names = columnsOf(db, TABLE).map((c) => c.name);
    expect(names).not.toContain('seq');
    expect(names).not.toContain('id');
    db.close();
  });

  it('puts the table on the wire, so nothing here is stranded off it', () => {
    expect(BROKER_TABLES as readonly string[]).toContain(TABLE);
  });
});
