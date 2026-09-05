import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, initDatabase, readSchemaHead } from '../../../src/cache/db.js';

/**
 * The extraction design pins: only the external core runs migrations on the shared
 * cache; an app that PAIRED INTO a database never migrates it. `initDatabase` ran
 * `applyMigrations` unconditionally, so every embedded-core consumer broke that pin
 * by construction — the option under test is the only way to honour it.
 *
 * The assertion is a byte hash of the file, not the absence of an error. A schema
 * write that succeeds quietly is exactly the failure this guards, and "it did not
 * throw" cannot see it. The last case is the control: the SAME fixture opened the
 * SAME way but with migrations on DOES change the hash, so a green no-migrate case
 * is evidence rather than an artefact of a fixture nothing would have written to.
 */

// Rolled back so the fixture sits at a genuinely older head than this build's
// registry. Chosen as the newest migration, so a default open has real work to do.
// Its tables are listed because rolling a migration back means undoing everything it
// created: leaving one behind would let a default open find its work already done.
const ROLLED_BACK = '024-studio-site-profiles';
const ROLLED_BACK_TABLES = ['studio_site_profiles', 'studio_site_grants', 'studio_site_memories'];

function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

describe('initDatabase({ migrate: false }) — non-owning open', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wigolo-no-migrate-'));
    dbPath = join(dir, 'cache.db');

    // Build a current-head DB the normal way, then walk it back one migration.
    const db: Database.Database = initDatabase(dbPath);
    for (const table of ROLLED_BACK_TABLES) db.exec(`DROP TABLE IF EXISTS ${table}`);
    db.prepare('DELETE FROM schema_migrations WHERE name = ?').run(ROLLED_BACK);
    // Fold the WAL into the main file so the hash covers the whole database and
    // a later close cannot move bytes that were already committed.
    db.pragma('wal_checkpoint(TRUNCATE)');
    closeDatabase();
  });

  afterEach(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });

  it('leaves an older-head database byte-identical', () => {
    const before = hashFile(dbPath);

    const db = initDatabase(dbPath, { migrate: false });
    // A usable connection, not a stub: the paired core still reads cache data.
    expect(db.prepare('SELECT count(*) AS n FROM url_cache').get()).toEqual({ n: 0 });
    // The rolled-back migration is still absent — nothing repaired it behind us.
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('studio_site_profiles', 'studio_site_grants', 'studio_site_memories')")
      .all();
    expect(table).toEqual([]);
    const row = db.prepare('SELECT name FROM schema_migrations WHERE name = ?').get(ROLLED_BACK);
    expect(row).toBeUndefined();
    closeDatabase();

    expect(hashFile(dbPath)).toBe(before);
  });

  it('does not flip the journal mode of a database it does not own', () => {
    // `journal_mode = WAL` rewrites the file header, so an unconditional pragma is
    // itself a structural write to someone else's file. Park the fixture in the
    // other mode and check we leave it there.
    const raw = new Database(dbPath);
    raw.pragma('journal_mode = DELETE');
    raw.close();
    const before = hashFile(dbPath);

    const db = initDatabase(dbPath, { migrate: false });
    expect(String(db.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('delete');
    closeDatabase();

    expect(hashFile(dbPath)).toBe(before);
  });

  it('reads the schema head without opening for write', () => {
    const before = hashFile(dbPath);

    const head = readSchemaHead(dbPath);

    expect(head.uninitialized).toBe(false);
    // Behind this build by exactly the migration we rolled back.
    expect(head.pending).toContain(ROLLED_BACK);
    expect(head.applied).not.toContain(ROLLED_BACK);
    // Nothing in the file is newer than the registry, so pairing skew is one-directional.
    expect(head.unknown).toEqual([]);
    expect(head.head).toBeTruthy();

    expect(hashFile(dbPath)).toBe(before);
  });

  it('reports an unmigrated database as uninitialized rather than up to date', () => {
    const fresh = join(dir, 'fresh.db');
    const db = initDatabase(fresh, { migrate: false });
    closeDatabase();
    expect(db).toBeTruthy();

    const head = readSchemaHead(fresh);
    expect(head.uninitialized).toBe(true);
    expect(head.head).toBeNull();
    expect(head.applied).toEqual([]);
    expect(head.pending).toContain(ROLLED_BACK);
  });

  it('refuses to probe a database that is not there', () => {
    expect(() => readSchemaHead(join(dir, 'absent.db'))).toThrow(/no cache database at/);
  });

  // Control. Without this, the hash equality above could hold simply because the
  // fixture was already at head and nothing would have been written either way.
  it('control: the same fixture DOES change when migrations are allowed to run', () => {
    const before = hashFile(dbPath);

    const db = initDatabase(dbPath);
    const row = db.prepare('SELECT name FROM schema_migrations WHERE name = ?').get(ROLLED_BACK);
    expect(row).toEqual({ name: ROLLED_BACK });
    closeDatabase();

    expect(hashFile(dbPath)).not.toBe(before);
  });
});
