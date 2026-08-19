import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { initDatabase, closeDatabase } from '../../../src/cache/db.js';
import { applyMigrations, _resetMigrationGuard } from '../../../src/cache/migrations/runner.js';

describe('migration 011-url-cache-namespace-tags', () => {
  let dir: string;

  beforeEach(() => {
    _resetMigrationGuard();
    dir = mkdtempSync(join(tmpdir(), 'wigolo-mig-011-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('adds namespace and tags columns to url_cache', () => {
    initDatabase(join(dir, 'wigolo.db'));
    const db = new Database(join(dir, 'wigolo.db'));
    const cols = db.prepare("PRAGMA table_info('url_cache')").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain('namespace');
    expect(names).toContain('tags');
    db.close();
    closeDatabase();
  });

  it('is idempotent on re-run', () => {
    const dbPath = join(dir, 'cache.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE url_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT UNIQUE NOT NULL,
        normalized_url TEXT NOT NULL,
        title TEXT,
        markdown TEXT,
        fetched_at TEXT NOT NULL
      );
    `);
    applyMigrations(db, { vecLoaded: false });
    applyMigrations(db, { vecLoaded: false });
    const applied = (db.prepare('SELECT name FROM schema_migrations WHERE name = ?').get(
      '011-url-cache-namespace-tags',
    ));
    expect(applied).toBeTruthy();
    db.close();
  });
});
