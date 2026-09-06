import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetConfig } from '../../src/config.js';
import { closeDatabase, getDatabase, initDatabase } from '../../src/cache/db.js';
import { BrokerGrantStore, executeBrokerOp } from '../../src/daemon/studio-db-broker.js';
import { BROKER_TABLES } from '../../src/companion-contract/index.js';
import type { BrokerOp, BrokerRefusal, BrokerRow, BrokerTable } from '../../src/companion-contract/index.js';

const SD10_TABLES = [
  'studio_shortcuts',
  'studio_schedules',
  'studio_workflows',
  'studio_watchers',
  'studio_collections',
  'studio_collection_rows',
] as const;

interface RoundTrip {
  table: BrokerTable;
  row: BrokerRow;
  where: BrokerRow;
  update: BrokerRow;
}

describe('the SD10 tables over the companion broker', () => {
  const originalEnv = process.env;
  let grants: BrokerGrantStore;

  const ROUND_TRIPS: readonly RoundTrip[] = [
    {
      table: 'studio_shortcuts' as BrokerTable,
      row: { slug: 'daily-brief', name: 'Daily brief', body: '{"kind":"brief"}', source: 'human', used_count: 0, created_at: 1, updated_at: 1 },
      where: { slug: 'daily-brief' },
      update: { used_count: 1, updated_at: 2 },
    },
    {
      table: 'studio_schedules' as BrokerTable,
      row: { id: 'schedule-1', name: 'Morning brief', cadence: '{"kind":"daily"}', wake: '{"at":"09:00"}', target: '{"shortcut":"daily-brief"}', approval_required: 1, status: 'active', next_due_at: 2, last_run_id: null, created_at: 1, updated_at: 1 },
      where: { id: 'schedule-1' },
      update: { status: 'paused', updated_at: 2 },
    },
    {
      table: 'studio_workflows' as BrokerTable,
      row: { slug: 'daily-digest', version: 1, definition: '{"steps":[]}', status: 'published', published_at: 1 },
      where: { slug: 'daily-digest', version: 1 },
      update: { status: 'archived' },
    },
    {
      table: 'studio_watchers' as BrokerTable,
      row: { id: 'watcher-1', kind: 'page', target: '{"url":"https://example.com"}', cadence_seconds: 60, alert_rules: '{"changes":true}', status: 'active', run_id: 'run-1', last_check_at: 1, last_state: '{"hash":"one"}', created_at: 1, updated_at: 1 },
      where: { id: 'watcher-1' },
      update: { status: 'paused', updated_at: 2 },
    },
    {
      table: 'studio_collections' as BrokerTable,
      row: { id: 'collection-1', name: 'Saved pages', criteria: '{"domain":"example.com"}', recipe_id: 'recipe-1', watcher_id: 'watcher-1', export_prefs: '{"format":"csv"}', created_at: 1, updated_at: 1 },
      where: { id: 'collection-1' },
      update: { name: 'Updated pages', updated_at: 2 },
    },
    {
      table: 'studio_collection_rows' as BrokerTable,
      row: { collection_id: 'collection-1', entity_key: 'https://example.com/a', fields: '{"title":"A"}', content_hash: 'hash-1', first_seen_at: 1, last_seen_at: 1, changed_at: 1, status: 'active' },
      where: { collection_id: 'collection-1', entity_key: 'https://example.com/a' },
      update: { fields: '{"title":"Updated"}', last_seen_at: 2, changed_at: 2 },
    },
  ];

  beforeEach(() => {
    process.env = { ...originalEnv, LOG_LEVEL: 'error' };
    resetConfig();
    initDatabase(':memory:');
    grants = new BrokerGrantStore();
  });

  afterEach(() => {
    closeDatabase();
    resetConfig();
    process.env = originalEnv;
  });

  function token(tables: readonly BrokerTable[]): string {
    return grants.issue({ mode: 'readwrite', tables, schemaHead: 1 }).token;
  }

  function run(op: BrokerOp): ReturnType<typeof executeBrokerOp> {
    return executeBrokerOp(getDatabase(), grants, op);
  }

  function rowsOf(result: ReturnType<typeof executeBrokerOp>): readonly BrokerRow[] {
    if (!result.ok) throw new Error(`expected rows, got ${JSON.stringify(result)}`);
    return result.rows ?? [];
  }

  function refusalOf(result: ReturnType<typeof executeBrokerOp>): BrokerRefusal {
    if (result.ok) throw new Error(`expected refusal, got ${JSON.stringify(result)}`);
    return result;
  }

  it('round-trips every SD10 table under a grant scoped to that table', () => {
    for (const { table, row, where, update } of ROUND_TRIPS) {
      const grant = token([table]);
      expect(run({ grant, kind: 'insert', table, row }).ok, table).toBe(true);
      expect(rowsOf(run({ grant, kind: 'read', table, where, limit: 10 }))[0], table).toMatchObject(row);
      expect(run({ grant, kind: 'update', table, row: update, where }).ok, table).toBe(true);
      expect(rowsOf(run({ grant, kind: 'read', table, where, limit: 10 }))[0], table).toMatchObject(update);
      expect(run({ grant, kind: 'delete', table, where }).ok, table).toBe(true);
      expect(rowsOf(run({ grant, kind: 'read', table, limit: 10 })), table).toEqual([]);
    }
  });

  it('keeps an uncontracted table as a typed unknown_table refusal', () => {
    const grant = token(SD10_TABLES as readonly BrokerTable[]);
    const table = 'studio_visits' as BrokerTable;
    expect(refusalOf(run({ grant, kind: 'read', table, limit: 10 }))).toEqual({ ok: false, reason: 'unknown_table' });
  });

  it('keeps all six names in the frozen broker table contract', () => {
    for (const table of SD10_TABLES) expect(BROKER_TABLES).toContain(table);
  });
});
