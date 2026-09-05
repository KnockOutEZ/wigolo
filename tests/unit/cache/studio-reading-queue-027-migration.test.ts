import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { MIGRATIONS, applyMigrations, _resetMigrationGuard } from '../../../src/cache/migrations/runner.js';
import { BROKER_TABLES } from '../../../src/companion-contract/broker.js';

/**
 * SD9 §3 (3ag, A-420-4/A-420-5) — the reading queue's schema half.
 *
 * The QUEUE only. Notes are NOT here: "17 snippets, every one keeps its source URL, element and
 * frame" is exactly the merged `clip` artifact, and a second notes store would be the second source
 * of truth law 1 forbids (A-420-5). This suite pins that absence as hard as it pins the columns.
 *
 * This is also the one SD9 table that CAN be paged over the wire, and that is deliberate — see the
 * cursor case below. The grant half is pinned over real broker ops against a real migrated database
 * in `tests/integration/studio-sd9-tables-broker.test.ts`.
 */

const NAME = '027-studio-reading-queue';

const TABLE = 'studio_reading_queue';

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

/** One queued row as 3ag shapes it — an agent-saved item, every column filled. */
const ITEM = Object.freeze({
  url: 'https://sqlite.org/lang_createtable.html',
  title: 'CREATE TABLE',
  added_by: 'run-9k1x',
  summary: 'How SQLite decides a rowid alias.',
  claims_flagged: 2,
  state: 'queued',
  added_at: 1_700_000_000_000,
});

function insert(db: Database.Database, table: string, row: Record<string, unknown>): number {
  const columns = Object.keys(row);
  return Number(
    db
      .prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
      .run(...columns.map((c) => row[c] as never)).lastInsertRowid,
  );
}

function planFor(db: Database.Database, sql: string, ...params: unknown[]): string {
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])) as Array<{ detail: string }>;
  return plan.map((r) => r.detail).join(' | ');
}

describe('027-studio-reading-queue migration', () => {
  let dir: string;

  beforeEach(() => {
    _resetMigrationGuard();
    dir = mkdtempSync(join(tmpdir(), 'wigolo-mig-027-'));
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

  it('creates studio_reading_queue with the 3ag column set, verbatim and in order', () => {
    const db = freshDb();
    expect(shapeOf(db, TABLE)).toEqual([
      { name: 'id', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 1 },
      { name: 'url', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
      { name: 'title', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
      { name: 'added_by', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
      { name: 'summary', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
      { name: 'claims_flagged', type: 'INTEGER', notnull: 1, dflt_value: '0', pk: 0 },
      { name: 'state', type: 'TEXT', notnull: 1, dflt_value: "'queued'", pk: 0 },
      { name: 'added_at', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 },
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

  it('saves a row with no summary, because the local model may simply not be there', () => {
    const db = freshDb();
    // Load-bearing nullability, not an oversight. The summary is produced locally on save and the
    // save must succeed with the port down (SD9-B4) — a NOT NULL here would make "summarise on save"
    // a precondition of saving at all, so an unavailable local model would silently cost the user
    // the item. Which shape the absent-with-reason cell takes is the domain module's to choose.
    const { summary, title, ...required } = ITEM;
    expect(summary).toBeTruthy();
    expect(title).toBeTruthy();
    insert(db, TABLE, required);
    expect(db.prepare(`SELECT summary, title FROM ${TABLE}`).get()).toEqual({ summary: null, title: null });
    db.close();
  });

  it('rejects a row missing any NOT NULL column', () => {
    const db = freshDb();
    // url and added_at are what the row IS — a queued thing and when it was queued. added_by is the
    // attribution the surface reads back as "3 more from run 9k1x", and a nullable one would make an
    // agent-saved row indistinguishable from a human's.
    for (const column of ['url', 'added_by', 'claims_flagged', 'state', 'added_at']) {
      expect(() => insert(db, TABLE, { ...ITEM, [column]: null }), `${TABLE}.${column}`).toThrow(/NOT NULL/);
    }
    expect(db.prepare(`SELECT COUNT(*) AS n FROM ${TABLE}`).get()).toEqual({ n: 0 });
    db.close();
  });

  it('defaults a saved row to queued with nothing flagged', () => {
    const db = freshDb();
    // The row a save writes before any claim check has run. A NULL state would make "what is in my
    // queue" unanswerable on the item nobody has archived, and a NULL count would render as a badge
    // with no number rather than no badge.
    insert(db, TABLE, { url: ITEM.url, added_by: 'human', added_at: ITEM.added_at });
    expect(db.prepare(`SELECT state, claims_flagged FROM ${TABLE}`).get()).toEqual({
      state: 'queued',
      claims_flagged: 0,
    });
    db.close();
  });

  it('accepts a state and an attribution this core has never heard of, because there is no CHECK', () => {
    const db = freshDb();
    // D15/D8, as migrations 023/024 state it. added_by is one TEXT column carrying either the
    // literal human or a run id — unambiguous against each other — and core never learns which run
    // ids exist: law 1 keeps the run in the run store.
    for (const [state, added_by] of [
      ['queued', 'human'],
      ['archived', 'run-9k1x'],
      ['state-from-the-future', 'writer-from-the-future'],
    ]) {
      insert(db, TABLE, { ...ITEM, state, added_by });
    }
    expect(db.prepare(`SELECT COUNT(*) AS n FROM ${TABLE}`).get()).toEqual({ n: 3 });
    db.close();
  });

  it('lets the same url be queued twice, because dedup is a queue semantic core does not own', () => {
    const db = freshDb();
    // Whether re-saving a page a run already queued is the same item resurfacing or a second entry
    // is the domain module's decision (D8). A UNIQUE on url would decide it here for every future
    // build and turn the archived-then-re-added case into a wire error rather than a choice.
    const first = insert(db, TABLE, ITEM);
    const second = insert(db, TABLE, { ...ITEM, added_by: 'human', state: 'archived' });
    expect(second).not.toBe(first);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM ${TABLE} WHERE url = ?`).get(ITEM.url)).toEqual({ n: 2 });
    db.close();
  });

  it('gives the wire a real cursor, unlike the other two SD9 tables', () => {
    const db = freshDb();
    // The broker ranges since/before over `seq`, else an INTEGER `id`, and offers NO cursor to a
    // table without one. A reading queue is the one SD9 store that grows without bound in append
    // order, so paging it by a narrowing `where` plus a client-side slice — the way the TEXT-keyed
    // profile and widget listings page — would eventually ask for a whole reading history in one
    // frame and meet MAX_BROKER_ROWS. An INTEGER PRIMARY KEY is a rowid alias, so the cursor is the
    // insertion order itself and costs no extra column.
    const id = columnsOf(db, TABLE).find((c) => c.name === 'id');
    expect(id?.type).toContain('INT');
    expect(id?.pk).toBe(1);

    const ids = [
      insert(db, TABLE, ITEM),
      insert(db, TABLE, { ...ITEM, url: 'https://example.com/b' }),
      insert(db, TABLE, { ...ITEM, url: 'https://example.com/c' }),
    ];
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(new Set(ids).size).toBe(3);
    db.close();
  });

  it('serves the queue listing from its index with no sort step', () => {
    const db = freshDb();
    // What the reading rail opens with: what is still queued, in the order it arrived. The index
    // ends in added_at, so the listing is the same traversal as the seek.
    const detail = planFor(db, `SELECT * FROM ${TABLE} WHERE state = ? ORDER BY added_at`, 'queued');
    expect(detail).toContain('idx_studio_reading_queue_state');
    expect(detail).not.toContain(`SCAN ${TABLE}`);
    expect(detail).not.toContain('TEMP B-TREE');
    db.close();
  });

  it('serves the run-attribution walk from its own index, which the state index cannot', () => {
    const db = freshDb();
    // "3 more from run 9k1x" — and the question archiving a run's contributions has to ask first.
    // The state index leads on state, and a run's rows are spread across every state, so this
    // direction needs its own or every render of that line scans the whole queue.
    const detail = planFor(db, `SELECT * FROM ${TABLE} WHERE added_by = ? ORDER BY added_at`, 'run-9k1x');
    expect(detail).toContain('idx_studio_reading_queue_added_by');
    expect(detail).not.toContain(`SCAN ${TABLE}`);
    expect(detail).not.toContain('TEMP B-TREE');
    db.close();
  });

  it('holds the queue only — no column is a note, a snippet or page content', () => {
    const db = freshDb();
    // A-420-5 and law 1. Notes ride the merged `clip` artifact, which already keeps each snippet's
    // source URL, element and frame; a note, snippet or body column here would be a second home for
    // them. `summary` is not that: it is a derived line about the queued page, not captured text.
    const names = columnsOf(db, TABLE).map((c) => c.name);
    for (const name of names) {
      expect(name, name).not.toMatch(/note|snippet|clip|excerpt|selection|body|content|markdown|html/i);
      expect(name, name).not.toMatch(
        /cookie|password|passwd|token|secret|credential|clearance|session_?id|bearer/i,
      );
    }
    db.close();
  });

  it('puts the table on the wire, so nothing here is stranded off it', () => {
    expect(BROKER_TABLES as readonly string[]).toContain(TABLE);
  });
});
