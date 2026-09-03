import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { MIGRATIONS, applyMigrations, _resetMigrationGuard } from '../../../src/cache/migrations/runner.js';
import { openMigrationTestDb } from '../../helpers/migration-test-db.js';
import { BROKER_TABLES } from '../../../src/companion-contract/broker.js';

/**
 * A-18-5 — the visits store's schema half.
 *
 * History-with-content is a SEPARATE corpus by construction, not by convention: its own
 * tables, its own FTS5 index, its own triggers, and deliberately absent from
 * `BROKER_TABLES`. Law 4 ("the user's own tabs are a separate group, invisible to every
 * agent") extended to captured content — a partition asserted here at the schema, and at
 * the read paths in `visits-agent-partition.test.ts`.
 */

const NAME = '021-studio-visits';

function columnsOf(db: Database.Database, table: string): Set<string> {
  return new Set((db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name));
}

function freshDb(): Database.Database {
  _resetMigrationGuard();
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyMigrations(db, { vecLoaded: false });
  return db;
}

/**
 * Apply every migration EXCEPT the one under test, recording each as applied — the shape
 * of a user database that has been running since before this migration existed. Copied
 * from the 017 suite's `seedThrough016` for the same reason it exists there: a fresh DB
 * proves the CREATE works, not that it forward-applies.
 */
function seedThroughPrior(db: Database.Database): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  for (const m of MIGRATIONS) {
    if (m.name === NAME || m.requiresVec) continue;
    db.transaction(() => {
      db.exec(m.sql);
      m.postStep?.(db);
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(m.name, 1);
    })();
  }
}

describe('021-studio-visits migration', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    _resetMigrationGuard();
    dir = mkdtempSync(join(tmpdir(), 'wigolo-mig-021-'));
    dbPath = join(dir, 'cache.db');
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

  it('creates studio_visits with the visit facts and nothing else', () => {
    const db = freshDb();
    // An extra column here means someone started keeping page state on the visit row instead
    // of behind the content hash, which is the duplication the hash-deduped body table exists
    // to prevent.
    expect([...columnsOf(db, 'studio_visits')].sort()).toEqual([
      'content_hash',
      'id',
      'normalized_url',
      'run_id',
      'space_id',
      'tab_id',
      'title',
      'ts',
      'url',
    ]);
    db.close();
  });

  it('creates studio_visit_pages keyed on the content hash so one body is stored once', () => {
    const db = freshDb();
    expect([...columnsOf(db, 'studio_visit_pages')].sort()).toEqual([
      'byte_len',
      'content_hash',
      'created_at',
      'markdown',
    ]);
    const ins = db.prepare(
      'INSERT INTO studio_visit_pages (content_hash, markdown, byte_len, created_at) VALUES (?, ?, ?, ?)',
    );
    ins.run('h1', 'body', 4, 'T');
    // Two visits to the same unchanged page share the row rather than duplicating the body.
    expect(() => ins.run('h1', 'body', 4, 'T')).toThrow();
    db.close();
  });

  it('lets a visit keep its own full URL alongside the normalized one', () => {
    const db = freshDb();
    db.prepare(
      `INSERT INTO studio_visits (url, normalized_url, title, ts, tab_id, space_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('https://example.com/a?q=1', 'https://example.com/a?q=1', 'A', '2026-09-03 10:00:00', 'tab-1', 'default');
    const row = db.prepare('SELECT url, run_id, content_hash, space_id FROM studio_visits').get() as {
      url: string;
      run_id: string | null;
      content_hash: string | null;
      space_id: string;
    };
    expect(row.url).toBe('https://example.com/a?q=1');
    // A human visit carries no run; a visit whose body was not captured carries no hash.
    expect(row.run_id).toBeNull();
    expect(row.content_hash).toBeNull();
    expect(row.space_id).toBe('default');
    db.close();
  });

  it('gives visits their OWN fts5 index, synced by trigger on insert, update and delete', () => {
    const db = freshDb();
    const ins = db.prepare(
      'INSERT INTO studio_visit_pages (content_hash, markdown, byte_len, created_at) VALUES (?, ?, ?, ?)',
    );
    ins.run('h1', 'quokka telemetry ledger', 23, 'T');
    const match = (q: string): number =>
      (
        db.prepare('SELECT COUNT(*) AS n FROM studio_visit_pages_fts WHERE studio_visit_pages_fts MATCH ?').get(q) as {
          n: number;
        }
      ).n;
    expect(match('quokka')).toBe(1);

    db.prepare('UPDATE studio_visit_pages SET markdown = ? WHERE content_hash = ?').run('wombat ledger', 'h1');
    expect(match('quokka')).toBe(0);
    expect(match('wombat')).toBe(1);

    db.prepare('DELETE FROM studio_visit_pages WHERE content_hash = ?').run('h1');
    expect(match('wombat')).toBe(0);
    db.close();
  });

  it('creates the per-site capture-off table, defaulting an unknown host to capture-on', () => {
    const db = freshDb();
    expect([...columnsOf(db, 'studio_visit_site_prefs')].sort()).toEqual([
      'capture_enabled',
      'host',
      'updated_at',
    ]);
    db.prepare('INSERT INTO studio_visit_site_prefs (host, updated_at) VALUES (?, ?)').run('example.com', 'T');
    const row = db.prepare('SELECT capture_enabled FROM studio_visit_site_prefs WHERE host = ?').get('example.com') as {
      capture_enabled: number;
    };
    // A row exists to record a DECISION; the default says an absent decision is not an opt-out.
    expect(row.capture_enabled).toBe(1);
    db.close();
  });

  it('indexes the three reads the store makes: newest-first, per-site, and by body hash', () => {
    const db = freshDb();
    const idx = new Set(
      (
        db
          .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'studio_visits'`)
          .all() as Array<{ name: string }>
      ).map((r) => r.name),
    );
    for (const name of ['idx_studio_visits_ts', 'idx_studio_visits_url_ts', 'idx_studio_visits_hash']) {
      expect(idx.has(name), `missing index ${name}`).toBe(true);
    }
    db.close();
  });

  it('is NOT a broker table — the companion cannot read or write visits over the wire', () => {
    // The partition is structural: the broker's table allowlist is a frozen tuple, so a visit
    // table absent from it is unreachable by any broker op, not merely unrequested.
    expect(BROKER_TABLES as readonly string[]).not.toContain('studio_visits');
    expect(BROKER_TABLES as readonly string[]).not.toContain('studio_visit_pages');
    expect(BROKER_TABLES as readonly string[]).not.toContain('studio_visit_pages_fts');
    expect(BROKER_TABLES as readonly string[]).not.toContain('studio_visit_site_prefs');
  });

  it('forward-applies over a POPULATED database that already carries every prior migration', () => {
    const db = openMigrationTestDb(dbPath);
    seedThroughPrior(db);
    // Populated: the tables a real user DB carries at this point, holding rows.
    db.prepare(
      `INSERT INTO url_versions (normalized_url, content_hash, markdown, title, http_status, fetched_at, byte_len)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('https://example.com/a', 'h1', 'old body', 'A', 200, '2026-09-01 10:00:00', 8);
    db.prepare('INSERT INTO studio_runs (id, task, created_at) VALUES (?, ?, ?)').run('r1', 'a task', 'T');
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'studio_visits'`).get(),
    ).toEqual({ n: 0 });

    expect(() => applyMigrations(db, { vecLoaded: false })).not.toThrow();

    expect(db.prepare('SELECT name FROM schema_migrations WHERE name = ?').all(NAME)).toHaveLength(1);
    expect(columnsOf(db, 'studio_visits').has('content_hash')).toBe(true);
    // The rows that were already there are untouched.
    expect(db.prepare('SELECT COUNT(*) AS n FROM url_versions').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM studio_runs').get()).toEqual({ n: 1 });

    // Idempotent: a second pass over the same DB re-runs nothing.
    expect(() => applyMigrations(db, { vecLoaded: false })).not.toThrow();
    expect(db.prepare('SELECT name FROM schema_migrations WHERE name = ?').all(NAME)).toHaveLength(1);
    db.close();
  });
});
