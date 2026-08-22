import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { MIGRATIONS, applyMigrations, _resetMigrationGuard } from '../../../src/cache/migrations/runner.js';

const NAME = '016-studio-runs';

function freshDb(): Database.Database {
  _resetMigrationGuard();
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  return db;
}

function columnsOf(db: Database.Database, table: string): Set<string> {
  return new Set((db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name));
}

describe('016-studio-runs migration', () => {
  it('claims a migration name that has never existed (D15 rename-nothing)', () => {
    const names = MIGRATIONS.map((m) => m.name);
    // Name-keyed, NOT number-ordered — duplicate numeric prefixes already exist on disk
    // (008-* and 010-* each appear twice), so a numeric check would pass on a real collision.
    expect(names.filter((n) => n === NAME)).toHaveLength(1);
    expect(new Set(names).size).toBe(names.length);
  });

  it('creates studio_runs with the three stored facts and the projection cache', () => {
    const db = freshDb();
    applyMigrations(db, { vecLoaded: false });
    const cols = columnsOf(db, 'studio_runs');
    for (const c of ['id', 'task', 'space_id', 'created_at', 'status', 'last_seq', 'updated_at']) {
      expect(cols.has(c), `missing column ${c}`).toBe(true);
    }
  });

  it('creates studio_run_events with the full envelope and nothing else', () => {
    const db = freshDb();
    applyMigrations(db, { vecLoaded: false });
    const cols = columnsOf(db, 'studio_run_events');
    // The envelope's five fields plus the run key. A column outside this set means someone
    // started keeping event state off the envelope, which is the second-source-of-truth failure.
    expect([...cols].sort()).toEqual(['actor', 'payload', 'run_id', 'seq', 'ts', 'type']);
  });

  it('makes (run_id, seq) the primary key — two events cannot collapse onto one position', () => {
    const db = freshDb();
    applyMigrations(db, { vecLoaded: false });
    db.prepare(`INSERT INTO studio_runs (id, task, created_at) VALUES (?, ?, ?)`).run('7fq2', 'a task', 'T');
    const ins = db.prepare(
      `INSERT INTO studio_run_events (run_id, seq, ts, actor, type, payload) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    ins.run('7fq2', 1, 'T', '{}', 'run.created', '{}');
    expect(() => ins.run('7fq2', 1, 'T', '{}', 'tab.attached', '{}')).toThrow();
    // A different run reuses seq 1 freely — the sequence is per-run (law 1: one log per run).
    db.prepare(`INSERT INTO studio_runs (id, task, created_at) VALUES (?, ?, ?)`).run('a9kw', 'other', 'T');
    expect(() => ins.run('a9kw', 1, 'T', '{}', 'run.created', '{}')).not.toThrow();
  });

  it('refuses an event whose run does not exist (FK to studio_runs)', () => {
    const db = freshDb();
    applyMigrations(db, { vecLoaded: false });
    expect(() =>
      db
        .prepare(`INSERT INTO studio_run_events (run_id, seq, ts, actor, type, payload) VALUES (?, ?, ?, ?, ?, ?)`)
        .run('nope', 1, 'T', '{}', 'run.created', '{}'),
    ).toThrow();
  });

  it('defaults space_id to the SD12-reserved literal and status to running', () => {
    const db = freshDb();
    applyMigrations(db, { vecLoaded: false });
    db.prepare(`INSERT INTO studio_runs (id, task, created_at) VALUES (?, ?, ?)`).run('7fq2', 'a task', 'T');
    const row = db.prepare(`SELECT space_id, status, last_seq FROM studio_runs WHERE id = ?`).get('7fq2') as {
      space_id: string; status: string; last_seq: number;
    };
    expect(row).toEqual({ space_id: 'default', status: 'running', last_seq: 0 });
  });

  it('runs forward on a DB that already has every OTHER migration applied', () => {
    const db = freshDb();
    const others = MIGRATIONS.filter((m) => m.name !== NAME && !m.requiresVec);
    db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
    for (const m of others) {
      db.transaction(() => {
        db.exec(m.sql);
        m.postStep?.(db);
        db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(m.name, 1);
      })();
    }
    expect(() => applyMigrations(db, { vecLoaded: false })).not.toThrow();
    expect(columnsOf(db, 'studio_runs').size).toBeGreaterThan(0);
    expect(db.prepare('SELECT name FROM schema_migrations WHERE name = ?').all(NAME)).toHaveLength(1);
  });

  it('is idempotent — a second pass is a no-op, not an error', () => {
    const db = freshDb();
    applyMigrations(db, { vecLoaded: false });
    _resetMigrationGuard();
    expect(() => applyMigrations(db, { vecLoaded: false })).not.toThrow();
  });

  it('keeps the .sql grep-mirror in step with the TS constant', async () => {
    const { readFile } = await import('node:fs/promises');
    const mirror = await readFile(new URL('../../../src/cache/migrations/016-studio-runs.sql', import.meta.url), 'utf8');
    const entry = MIGRATIONS.find((m) => m.name === NAME);
    // The mirror exists for grep and review; a drifted mirror sends a reviewer to the wrong schema.
    expect(mirror.replace(/^--.*$/gm, '').trim()).toBe(entry!.sql.replace(/^--.*$/gm, '').trim());
  });
});
