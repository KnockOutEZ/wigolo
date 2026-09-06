import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import { applyMigrations, MIGRATIONS, _resetMigrationGuard } from '../../../src/cache/migrations/runner.js';

const MIGRATION_NAMES = [
  '028-studio-shortcuts',
  '029-studio-schedules',
  '030-studio-workflows',
  '031-studio-watchers',
  '032-studio-collections',
  '033-studio-collection-rows',
] as const;

const TABLES = [
  'studio_shortcuts',
  'studio_schedules',
  'studio_workflows',
  'studio_watchers',
  'studio_collections',
  'studio_collection_rows',
] as const;

const TABLE_COLUMNS = {
  studio_shortcuts: ['id', 'slug', 'name', 'body', 'source', 'used_count', 'created_at', 'updated_at'],
  studio_schedules: [
    'id', 'name', 'cadence', 'wake', 'target', 'approval_required', 'status', 'next_due_at', 'last_run_id', 'created_at',
    'updated_at',
  ],
  studio_workflows: ['slug', 'version', 'definition', 'status', 'published_at'],
  studio_watchers: [
    'id', 'kind', 'target', 'cadence_seconds', 'alert_rules', 'status', 'run_id', 'last_check_at', 'last_state',
    'created_at', 'updated_at',
  ],
  studio_collections: ['id', 'name', 'criteria', 'recipe_id', 'watcher_id', 'export_prefs', 'created_at', 'updated_at'],
  studio_collection_rows: [
    'collection_id', 'entity_key', 'fields', 'content_hash', 'first_seen_at', 'last_seen_at', 'changed_at', 'status',
  ],
} as const;

const TIMESTAMP_COLUMNS = {
  studio_shortcuts: ['created_at', 'updated_at'],
  studio_schedules: ['next_due_at', 'created_at', 'updated_at'],
  studio_workflows: ['published_at'],
  studio_watchers: ['last_check_at', 'created_at', 'updated_at'],
  studio_collections: ['created_at', 'updated_at'],
  studio_collection_rows: ['first_seen_at', 'last_seen_at', 'changed_at'],
} as const;

describe('SD10 broker-table migrations', () => {
  it('adds all six tables to a fresh database and records each migration once on re-run', () => {
    _resetMigrationGuard();
    const db = new Database(':memory:');

    applyMigrations(db, { vecLoaded: false });
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?, ?, ?, ?, ?) ORDER BY name")
        .all(...TABLES)
        .map((row) => (row as { name: string }).name),
    ).toEqual([...TABLES].sort());
    expect(
      db.prepare('SELECT name FROM schema_migrations WHERE name IN (?, ?, ?, ?, ?, ?) ORDER BY name')
        .all(...MIGRATION_NAMES)
        .map((row) => (row as { name: string }).name),
    ).toEqual([...MIGRATION_NAMES]);

    applyMigrations(db, { vecLoaded: false });
    expect(
      db.prepare('SELECT name FROM schema_migrations WHERE name IN (?, ?, ?, ?, ?, ?)').all(...MIGRATION_NAMES),
    ).toHaveLength(MIGRATION_NAMES.length);
    db.close();
  });

  it('keeps unique keys at the storage boundary for collection-row upserts and workflow versions', () => {
    _resetMigrationGuard();
    const db = new Database(':memory:');
    applyMigrations(db, { vecLoaded: false });

    db.prepare(
      'INSERT INTO studio_collection_rows (collection_id, entity_key, fields, content_hash, first_seen_at, last_seen_at, changed_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('collection-1', 'https://example.com/a', '{"title":"first"}', 'hash-1', 1, 1, 1, 'active');
    db.prepare(
      'INSERT INTO studio_collection_rows (collection_id, entity_key, fields, content_hash, first_seen_at, last_seen_at, changed_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(collection_id, entity_key) DO UPDATE SET fields = excluded.fields, content_hash = excluded.content_hash, last_seen_at = excluded.last_seen_at, changed_at = excluded.changed_at, status = excluded.status',
    ).run('collection-1', 'https://example.com/a', '{"title":"updated"}', 'hash-2', 1, 2, 2, 'changed');
    expect(db.prepare('SELECT fields, content_hash, first_seen_at, last_seen_at, changed_at, status FROM studio_collection_rows').get())
      .toEqual({ fields: '{"title":"updated"}', content_hash: 'hash-2', first_seen_at: 1, last_seen_at: 2, changed_at: 2, status: 'changed' });

    const workflow = {
      slug: 'daily-digest',
      version: 1,
      definition: '{"steps":[]}',
      status: 'published',
      published_at: 1,
    };
    db.prepare(
      'INSERT INTO studio_workflows (slug, version, definition, status, published_at) VALUES (@slug, @version, @definition, @status, @published_at)',
    ).run(workflow);
    expect(() => db.prepare(
      'INSERT INTO studio_workflows (slug, version, definition, status, published_at) VALUES (@slug, @version, @definition, @status, @published_at)',
    ).run(workflow)).toThrow(/UNIQUE|PRIMARY KEY/i);
    expect(() => db.prepare('UPDATE studio_workflows SET status = ? WHERE slug = ? AND version = ?')
      .run('archived', workflow.slug, workflow.version)).toThrow(/append-only/i);
    expect(() => db.prepare('DELETE FROM studio_workflows WHERE slug = ? AND version = ?')
      .run(workflow.slug, workflow.version)).toThrow(/append-only/i);
    expect(db.prepare('SELECT * FROM studio_workflows').get()).toMatchObject(workflow);
    db.close();
  });

  it('keeps every SD10 table column and timestamp affinity exact', () => {
    _resetMigrationGuard();
    const db = new Database(':memory:');
    applyMigrations(db, { vecLoaded: false });

    for (const table of TABLES) {
      const columns = db.pragma(`table_info(${table})`) as Array<{ name: string; type: string }>;
      expect(columns.map((column) => column.name), table).toEqual(TABLE_COLUMNS[table]);
      for (const timestamp of TIMESTAMP_COLUMNS[table]) {
        expect(columns.find((column) => column.name === timestamp)?.type, `${table}.${timestamp}`).toBe('INTEGER');
      }
    }
    db.close();
  });

  it('registers the six new migration names without changing existing duplicate-number lanes', () => {
    const names = MIGRATIONS.map((migration) => migration.name);
    expect(names.slice(-MIGRATION_NAMES.length)).toEqual(MIGRATION_NAMES);
    expect(names.filter((name) => name.startsWith('008-'))).toHaveLength(2);
    expect(names.filter((name) => name.startsWith('009-'))).toHaveLength(2);
    expect(names.filter((name) => name.startsWith('010-'))).toHaveLength(2);
    expect(names.filter((name) => name.startsWith('013-'))).toHaveLength(2);
  });
});
