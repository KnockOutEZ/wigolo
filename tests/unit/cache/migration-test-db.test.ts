import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openMigrationTestDb } from '../../helpers/migration-test-db.js';

/**
 * K27's fix is a claim about a test HELPER, so it has to be checkable the same way
 * any other claim is. Two properties carry the whole thing:
 *
 *   1. the cost the helper removes is actually removed (no on-disk journal churn),
 *   2. the semantics it promises to leave alone are actually left alone (per-
 *      transaction rollback, independent between transactions).
 *
 * (1) is asserted against a CONTROL — a bare `new Database()` on the same path in
 * the same directory. Without the control, "no sidecar was found" is satisfied by
 * looking in the wrong place, or by a SQLite version that stopped writing one, and
 * the assertion would pass while the helper did nothing at all.
 *
 * Read the limit of (2) correctly: these rollback tests pin that rollback WORKS
 * under the shipped pragmas. They do NOT discriminate `journal_mode=MEMORY` from
 * `journal_mode=OFF` — measured, both were rolled back here, which is consistent
 * with SQLite documenting OFF's rollback as *undefined* rather than as broken. The
 * assertion that stops OFF being substituted is the reported-pragma one below.
 */
describe('openMigrationTestDb', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wigolo-migdb-'));
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  /** Sidecars visible while a write transaction is open — the journal is deleted at commit. */
  function sidecarsDuringWrite(db: Database.Database, name: string): string[] {
    db.exec('BEGIN');
    db.exec('CREATE TABLE probe (x)');
    const files = readdirSync(dir).filter((f) => f !== name);
    db.exec('ROLLBACK');
    return files;
  }

  it('writes no rollback-journal sidecar, where a bare handle on the same path writes one', () => {
    // CONTROL first: prove the probe can see a sidecar at all in this directory.
    const bare = new Database(join(dir, 'control.db'));
    expect(sidecarsDuringWrite(bare, 'control.db')).toEqual(['control.db-journal']);
    bare.close();
    rmSync(join(dir, 'control.db'));

    const db = openMigrationTestDb(join(dir, 'cache.db'));
    expect(sidecarsDuringWrite(db, 'cache.db')).toEqual([]);
    db.close();
  });

  it('reports the durability pragmas it claims to set', () => {
    const db = openMigrationTestDb(join(dir, 'cache.db'));
    expect(db.pragma('journal_mode', { simple: true })).toBe('memory');
    expect(db.pragma('synchronous', { simple: true })).toBe(0);
    db.close();
  });

  it('still rolls back an aborted transaction — DDL and DML both', () => {
    const db = openMigrationTestDb(join(dir, 'cache.db'));
    db.exec('CREATE TABLE kept (x TEXT)');

    expect(() => db.transaction(() => {
      db.exec('CREATE TABLE doomed (x TEXT)');
      db.prepare('INSERT INTO kept (x) VALUES (?)').run('doomed-row');
      throw new Error('boom');
    })()).toThrow('boom');

    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
      .map((t) => t.name);
    expect(tables).not.toContain('doomed');
    expect((db.prepare('SELECT COUNT(*) AS n FROM kept').get() as { n: number }).n).toBe(0);
    db.close();
  });

  /**
   * This is the property an outer transaction would destroy, and the reason K27's
   * fix is a pragma rather than batching: `applyMigrations` commits once PER
   * migration, so a migration that throws must roll back only itself and leave the
   * ones before it applied.
   */
  it('keeps successive transactions independent — an aborted one does not undo an earlier commit', () => {
    const db = openMigrationTestDb(join(dir, 'cache.db'));
    db.exec('CREATE TABLE log (name TEXT)');
    const record = db.prepare('INSERT INTO log (name) VALUES (?)');

    db.transaction(() => { record.run('first'); })();
    expect(() => db.transaction(() => { record.run('second'); throw new Error('boom'); })()).toThrow('boom');
    db.transaction(() => { record.run('third'); })();

    const names = (db.prepare('SELECT name FROM log ORDER BY rowid').all() as Array<{ name: string }>)
      .map((r) => r.name);
    expect(names).toEqual(['first', 'third']);
    db.close();
  });

  it('leaves the file readable by a plain handle — both pragmas are connection-level', () => {
    const path = join(dir, 'cache.db');
    const db = openMigrationTestDb(path);
    db.exec('CREATE TABLE t (x TEXT)');
    db.prepare('INSERT INTO t (x) VALUES (?)').run('committed');
    db.close();

    // The read-only fail-soft tests reopen the seeded path with a bare handle; a
    // file-level journal mode (WAL) would break exactly that.
    const reopened = new Database(path, { readonly: true });
    expect((reopened.prepare('SELECT x FROM t').get() as { x: string }).x).toBe('committed');
    expect(reopened.pragma('journal_mode', { simple: true })).toBe('delete');
    reopened.close();
  });
});
