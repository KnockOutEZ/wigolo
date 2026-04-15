import { describe, it, expect, afterEach } from 'vitest';
import { initDatabase, closeDatabase } from '../../../src/cache/db.js';
import Database from 'better-sqlite3';

describe('database', () => {
  let db: Database.Database;

  afterEach(() => {
    closeDatabase();
  });

  it('creates all tables in-memory', () => {
    db = initDatabase(':memory:');
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as { name: string }[];
    const names = tables.map(t => t.name);
    expect(names).toContain('url_cache');
    expect(names).toContain('search_cache');
    expect(names).toContain('domain_routing');
    expect(names).toContain('domain_boilerplate');
  });

  it('creates FTS5 virtual table', () => {
    db = initDatabase(':memory:');
    const vtables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='url_cache_fts'"
    ).all();
    expect(vtables.length).toBe(1);
  });

  it('creates triggers for FTS sync', () => {
    db = initDatabase(':memory:');
    const triggers = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='trigger'"
    ).all() as { name: string }[];
    const names = triggers.map(t => t.name);
    expect(names).toContain('url_cache_ai');
    expect(names).toContain('url_cache_ad');
    expect(names).toContain('url_cache_au');
  });

  it('is idempotent (can init twice)', () => {
    db = initDatabase(':memory:');
    expect(() => initDatabase(':memory:')).not.toThrow();
  });

  describe('lightpanda_routing table', () => {
    it('creates lightpanda_routing table on init', () => {
      db = initDatabase(':memory:');
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='lightpanda_routing'"
      ).all();
      expect(tables).toHaveLength(1);
    });

    it('allows inserting domain routing records', () => {
      db = initDatabase(':memory:');
      db.prepare(
        'INSERT INTO lightpanda_routing (domain, success_count, failure_count) VALUES (?, ?, ?)'
      ).run('example.com', 5, 1);

      const row = db.prepare('SELECT * FROM lightpanda_routing WHERE domain = ?').get('example.com') as any;
      expect(row.success_count).toBe(5);
      expect(row.failure_count).toBe(1);
      expect(row.prefer_chromium).toBe(0);
    });

    it('enforces domain uniqueness', () => {
      db = initDatabase(':memory:');
      db.prepare(
        'INSERT INTO lightpanda_routing (domain, success_count) VALUES (?, ?)'
      ).run('unique.com', 1);

      expect(() => {
        db.prepare(
          'INSERT INTO lightpanda_routing (domain, success_count) VALUES (?, ?)'
        ).run('unique.com', 2);
      }).toThrow();
    });
  });
});
