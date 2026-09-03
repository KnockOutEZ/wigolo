import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyMigrations, _resetMigrationGuard } from '../../../src/cache/migrations/runner.js';
import { openMigrationTestDb } from '../../helpers/migration-test-db.js';

/**
 * Migration 020 — the clearance reuse ledger's columns. A NEW migration rather than an
 * edit to 008 or 010: D15's rule is that a released migration name is its identity and
 * renaming one re-runs it on every existing user database.
 */
const NEW_COLS = ['clearance_solved_at', 'reused_count', 'last_reused_at'];

describe('migration 020 — clearance reuse counters', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    _resetMigrationGuard();
    dir = mkdtempSync(join(tmpdir(), 'wigolo-clearance-020-'));
    dbPath = join(dir, 'cache.db');
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('adds the three ledger columns to domain_routing', () => {
    const db = openMigrationTestDb(dbPath);
    applyMigrations(db, { vecLoaded: false });

    const cols = (db.prepare("PRAGMA table_info('domain_routing')").all() as Array<{ name: string }>)
      .map((c) => c.name);
    for (const col of NEW_COLS) expect(cols).toContain(col);

    const applied = (db.prepare('SELECT name FROM schema_migrations').all() as Array<{ name: string }>)
      .map((r) => r.name);
    expect(applied).toContain('020-clearance-reuse-counters');
    db.close();
  });

  /**
   * An existing row predates the columns, so it has to read as "never reused" rather than
   * as an unknown — which is what the NOT NULL DEFAULT 0 buys. A NULL here would make
   * every arithmetic bump on a legacy row a no-op.
   */
  it('backfills existing rows with a zero count, not a NULL', () => {
    const db = openMigrationTestDb(dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS domain_routing (
        domain TEXT PRIMARY KEY,
        prefer_playwright INTEGER DEFAULT 0,
        http_failures INTEGER DEFAULT 0,
        last_updated TEXT
      );
      INSERT INTO domain_routing (domain, last_updated) VALUES ('legacy.example', '2020-01-01 00:00:00');
    `);
    applyMigrations(db, { vecLoaded: false });

    const row = db.prepare(
      'SELECT reused_count, last_reused_at, clearance_solved_at FROM domain_routing WHERE domain = ?',
    ).get('legacy.example') as {
      reused_count: number;
      last_reused_at: string | null;
      clearance_solved_at: string | null;
    };
    expect(row.reused_count).toBe(0);
    expect(row.last_reused_at).toBeNull();
    expect(row.clearance_solved_at).toBeNull();
    db.close();
  });

  it('is idempotent — running twice does not error or duplicate columns', () => {
    const db = openMigrationTestDb(dbPath);
    applyMigrations(db, { vecLoaded: false });
    _resetMigrationGuard();
    expect(() => applyMigrations(db, { vecLoaded: false })).not.toThrow();

    const cols = (db.prepare("PRAGMA table_info('domain_routing')").all() as Array<{ name: string }>)
      .map((c) => c.name);
    for (const col of NEW_COLS) {
      expect(cols.filter((c) => c === col)).toHaveLength(1);
    }
    db.close();
  });
});
