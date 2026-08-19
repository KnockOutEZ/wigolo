import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { MIGRATIONS, applyMigrations, _resetMigrationGuard } from '../../../src/cache/migrations/runner.js';

const NAME = '013-studio-flows';

function freshDb(): Database.Database {
  _resetMigrationGuard();
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  return db;
}

function columnsOf(db: Database.Database, table: string): Set<string> {
  return new Set((db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name));
}

describe('013-studio-flows migration', () => {
  it('claims a migration name that has never existed (D15 rename-nothing)', () => {
    const names = MIGRATIONS.map((m) => m.name);
    // Name-keyed, NOT number-ordered — duplicate numeric prefixes already exist on disk
    // (008-* and 010-* each appear twice), so a numeric check would pass on a real collision.
    expect(names.filter((n) => n === NAME)).toHaveLength(1);
    expect(new Set(names).size).toBe(names.length);
  });

  it('runs forward on a fresh DB and creates studio_flow_steps', () => {
    const db = freshDb();
    applyMigrations(db, { vecLoaded: false });
    const cols = columnsOf(db, 'studio_flow_steps');
    // Every locator §4.2 requires must have a home; role/name are their OWN columns
    // (§4.4 — a mark artifact concatenates them into `title` and they cannot be split back out).
    for (const c of [
      'flow_id', 'session_id', 'seq', 'audit_seq', 'action', 'page_url',
      'target_role', 'target_name', 'target_fingerprint', 'target_ancestor_path', 'target_attrs',
      'recorded_ref', 'heal_tier_at_record', 'slot', 'direction', 'amount', 'ts',
    ]) {
      expect(cols.has(c), `missing column ${c}`).toBe(true);
    }
  });

  it('has NO column that could carry typed text, risk, or an approval', () => {
    const db = freshDb();
    applyMigrations(db, { vecLoaded: false });
    const cols = columnsOf(db, 'studio_flow_steps');
    // §5.2 — a recording never carries authorization. Making the columns STRUCTURALLY ABSENT is
    // stronger than "the runner must not read them": there is nothing to read. §6 — no typed text.
    for (const forbidden of ['text', 'value', 'risk', 'approval', 'backend_node_id', 'epoch']) {
      expect(cols.has(forbidden), `forbidden column ${forbidden} present`).toBe(false);
    }
  });

  it('runs forward on a DB that already has every OTHER migration applied', () => {
    const db = freshDb();
    // Simulate an existing install: apply everything except 013, then apply the full set.
    // vecLoaded:false below — mirror the runner and skip the sqlite-vec migration.
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
    expect(columnsOf(db, 'studio_flow_steps').size).toBeGreaterThan(0);
    const applied = db.prepare('SELECT name FROM schema_migrations WHERE name = ?').all(NAME);
    expect(applied).toHaveLength(1);
  });

  it('is idempotent — a second pass is a no-op, not an error', () => {
    const db = freshDb();
    applyMigrations(db, { vecLoaded: false });
    _resetMigrationGuard();
    expect(() => applyMigrations(db, { vecLoaded: false })).not.toThrow();
  });

  it('enforces (flow_id, seq) uniqueness and the studio_sessions FK', () => {
    const db = freshDb();
    applyMigrations(db, { vecLoaded: false });
    db.prepare('INSERT INTO studio_sessions (id) VALUES (?)').run('s1');
    const ins = db.prepare(
      `INSERT INTO studio_flow_steps (flow_id, session_id, seq, audit_seq, action, ts) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    ins.run('flw_a', 's1', 1, 1, 'navigate', 1);
    // The ordered sequence is the whole point of a table over a studio_artifacts row — two steps
    // may NOT collapse onto one position.
    expect(() => ins.run('flw_a', 's1', 1, 2, 'click', 2)).toThrow();
    // A step can never outlive / precede its session parent.
    expect(() => ins.run('flw_b', 'nope', 1, 1, 'navigate', 1)).toThrow();
  });

  it('leaves studio_audit byte-identical (T5)', () => {
    const before = freshDb();
    // vecLoaded:false below — mirror the runner and skip the sqlite-vec migration.
    const others = MIGRATIONS.filter((m) => m.name !== NAME && !m.requiresVec);
    before.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
    for (const m of others) {
      before.transaction(() => { before.exec(m.sql); m.postStep?.(before); })();
    }
    const after = freshDb();
    applyMigrations(after, { vecLoaded: false });

    const sqlOf = (db: Database.Database) =>
      (db.prepare(`SELECT name, sql FROM sqlite_master WHERE name LIKE 'studio_audit%' ORDER BY name`).all() as Array<{ name: string; sql: string }>);
    expect(sqlOf(after)).toEqual(sqlOf(before));
  });
});
