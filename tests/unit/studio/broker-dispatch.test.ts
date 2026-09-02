import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { resetConfig } from '../../../src/config.js';
import { initDatabase, getDatabase, closeDatabase } from '../../../src/cache/db.js';
import * as broker from '../../../src/daemon/studio-db-broker.js';
import { BROKER_TABLES } from '../../../src/companion-contract/index.js';

/**
 * EXTRACT C3 (spec D8) — what the broker's dispatch is now, and what it must never grow back into.
 *
 * The broker used to dispatch domain methods: capture a mark, synthesise a session, create a run. All of
 * that is the companion's, re-implemented on top of the table ops below. These cases pin the shape of the
 * replacement — dispatch is on the op KIND, over a table named from a closed set — and pin the absence of
 * the old surface, because a re-grown domain method would compile, pass every other test in this repo, and
 * silently put the extracted layer back.
 */
describe('companion broker — dispatch is by op kind, never by domain method', () => {
  const originalEnv = process.env;
  let grants: broker.BrokerGrantStore;
  let token: string;

  beforeEach(() => {
    process.env = { ...originalEnv, LOG_LEVEL: 'error' };
    resetConfig();
    initDatabase(':memory:');
    grants = new broker.BrokerGrantStore();
    token = grants.issue({ mode: 'readwrite', tables: BROKER_TABLES, schemaHead: 1 }).token;
    getDatabase()
      .prepare('INSERT INTO studio_sessions (id, created_at) VALUES (?, ?)')
      .run('sess-1', '2026-09-03T00:00:00.000Z');
  });

  afterEach(() => {
    closeDatabase();
    resetConfig();
    process.env = originalEnv;
  });

  it('exports no domain handler surface at all', () => {
    const exported = Object.keys(broker);

    expect(exported).not.toContain('createBrokerHandlers');
    for (const domainName of ['capture', 'synthesize', 'runCreate', 'findSimilar', 'listArtifacts', 'audit']) {
      expect(
        exported.filter((name) => name.toLowerCase().includes(domainName.toLowerCase())),
        `the broker must export nothing named for the domain method ${domainName}`,
      ).toEqual([]);
    }
  });

  it('routes each op kind to its own statement against the named table', () => {
    const db = getDatabase();
    const row = {
      session_id: 'sess-1',
      artifact_type: 'clip',
      url: 'https://example.com/a',
      content_hash: 'hash-1',
      fetched_at: '2026-09-03T00:00:00.000Z',
    };

    expect(broker.executeBrokerOp(db, grants, { grant: token, kind: 'insert', table: 'studio_artifacts', row }).ok).toBe(true);

    const read = broker.executeBrokerOp(db, grants, {
      grant: token,
      kind: 'read',
      table: 'studio_artifacts',
      where: { content_hash: 'hash-1' },
      limit: 10,
    });
    expect(read.ok && read.rows).toHaveLength(1);

    const updated = broker.executeBrokerOp(db, grants, {
      grant: token,
      kind: 'update',
      table: 'studio_artifacts',
      row: { curated_by_human: 1 },
      where: { content_hash: 'hash-1' },
    });
    expect(updated.ok && updated.rows[0]).toEqual({ changes: 1 });
    expect(
      (db.prepare('SELECT curated_by_human AS c FROM studio_artifacts').get() as { c: number }).c,
    ).toBe(1);

    const deleted = broker.executeBrokerOp(db, grants, {
      grant: token,
      kind: 'delete',
      table: 'studio_artifacts',
      where: { content_hash: 'hash-1' },
    });
    expect(deleted.ok && deleted.rows[0]).toEqual({ changes: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM studio_artifacts').get()).toEqual({ n: 0 });
  });

  it('accepts every table in the closed contract set and nothing else', () => {
    const db = getDatabase();

    for (const table of BROKER_TABLES) {
      const result = broker.executeBrokerOp(db, grants, { grant: token, kind: 'read', table, limit: 1 });
      expect(result.ok, `granted table ${table} must be readable`).toBe(true);
    }

    for (const table of ['url_cache', 'schema_migrations', 'sqlite_master']) {
      const result = broker.executeBrokerOp(db, grants, {
        grant: token,
        kind: 'read',
        table,
        limit: 1,
      } as unknown as Parameters<typeof broker.executeBrokerOp>[2]);
      expect(result, `${table} is not a shared studio table`).toEqual({ ok: false, reason: 'unknown_table' });
    }
  });
});
