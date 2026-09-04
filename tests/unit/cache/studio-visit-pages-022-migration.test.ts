import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, _resetMigrationGuard, applyMigrations } from '../../../src/cache/migrations/runner.js';

const NAME = '022-studio-visit-pages-byte-len-index';
const INDEX = 'idx_studio_visit_pages_byte_len';

function seedThroughPrior(db: Database.Database): void {
  db.exec('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const record = db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)');
  for (const migration of MIGRATIONS) {
    if (migration.name === NAME) break;
    if (migration.requiresVec) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      migration.postStep?.(db);
      record.run(migration.name, 1);
    })();
  }
}

describe('022 studio visit page byte-length index migration', () => {
  afterEach(() => {
    _resetMigrationGuard();
  });

  it('has one stable name and a byte-identical reviewable SQL mirror', () => {
    const matches = MIGRATIONS.filter((migration) => migration.name === NAME);
    expect(matches).toHaveLength(1);
    const mirror = readFileSync(new URL(`../../../src/cache/migrations/${NAME}.sql`, import.meta.url), 'utf8');
    expect(mirror.trim()).toBe(matches[0].sql.trim());
  });

  it('forward-applies over populated visit pages and makes SUM an index-only scan', () => {
    const db = new Database(':memory:');
    seedThroughPrior(db);
    db.prepare(
      `INSERT INTO studio_visit_pages (content_hash, markdown, byte_len, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run('existing', 'existing body', 13, '2026-09-05 00:00:00');

    applyMigrations(db, { vecLoaded: false });

    expect(db.prepare('SELECT markdown FROM studio_visit_pages').all()).toEqual([{ markdown: 'existing body' }]);
    expect(db.pragma(`index_info(${INDEX})`)).toEqual([{ seqno: 0, cid: 2, name: 'byte_len' }]);
    const plan = db
      .prepare('EXPLAIN QUERY PLAN SELECT COALESCE(SUM(byte_len), 0) FROM studio_visit_pages')
      .all() as Array<{ detail: string }>;
    expect(plan.map((step) => step.detail).join('\n')).toMatch(
      new RegExp(`USING COVERING INDEX ${INDEX}`),
    );
    expect(db.prepare('SELECT name FROM schema_migrations WHERE name = ?').all(NAME)).toHaveLength(1);

    applyMigrations(db, { vecLoaded: false });
    expect(db.prepare('SELECT name FROM schema_migrations WHERE name = ?').all(NAME)).toHaveLength(1);
    db.close();
  });
});
