import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resetConfig } from '../../src/config.js';
import { applyMigrations, _resetMigrationGuard } from '../../src/cache/migrations/runner.js';
import { BrokerGrantStore, executeBrokerOp, schemaHead } from '../../src/daemon/studio-db-broker.js';
import { sqliteRunsStore, type RunsStore } from '../../src/daemon/rest/runs-store.js';
import { BROKER_TABLES } from '../../src/companion-contract/index.js';
import type { BrokerRow } from '../../src/companion-contract/index.js';

/**
 * One event stream, two readers (law 1), across the seam C3 draws.
 *
 * #334 put this claim at the level of nine RPC delegates: the same run had to answer identically through
 * the daemon's native store and through the broker. D8 removes the delegates — the broker serves tables —
 * so the claim moves DOWN a layer and gets stronger for it: what a paired companion writes through the
 * dumb ops is the same rows the daemon's own `RunsStore` reads, with no translation between them, because
 * there is nothing left in the middle to translate.
 *
 * That is the property the extraction actually depends on. If the two ever disagreed, the app's
 * re-implemented run projection would be a second source of truth for one run, which law 1 forbids, and
 * the disagreement would surface as a panel and a REST answer that quietly differ.
 *
 * The projections themselves stay out of core deliberately — they are the private layer's, and rebuilding
 * one here to compare against would be building the second source of truth this test exists to rule out.
 */
describe('companion broker — the daemon and a paired companion read one run', () => {
  const originalEnv = process.env;
  let dir: string;
  let db: Database.Database;
  let store: RunsStore;
  let grants: BrokerGrantStore;
  let token: string;

  // A real mintable run id: the daemon's store resolves ids through the mint alphabet, so a
  // human-readable stand-in would be rejected before the row was ever looked for — and the test would
  // then be measuring the id format, not the shared stream.
  const RUN = 'shrd9';

  function op(o: Parameters<typeof executeBrokerOp>[2]): BrokerRow[] {
    const result = executeBrokerOp(db, grants, o);
    if (!result.ok) throw new Error(`op refused: ${result.reason}`);
    return result.rows as BrokerRow[];
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wigolo-broker-routes-'));
    process.env = { ...originalEnv, WIGOLO_DATA_DIR: dir, LOG_LEVEL: 'error' };
    resetConfig();
    _resetMigrationGuard();
    db = new Database(join(dir, 'shared.db'));
    applyMigrations(db, { vecLoaded: false });
    store = sqliteRunsStore(db);
    grants = new BrokerGrantStore();
    token = grants.issue({ mode: 'readwrite', tables: BROKER_TABLES, schemaHead: schemaHead(db) }).token;
  });

  afterEach(() => {
    db.close();
    resetConfig();
    process.env = originalEnv;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* the OS owns the temp dir */ }
  });

  it('lets the daemon’s own store see a run the companion created through table ops', async () => {
    op({
      grant: token,
      kind: 'insert',
      table: 'studio_runs',
      row: { id: RUN, task: 'compare two monitors', created_at: '2026-09-03T00:00:00.000Z' },
    });

    await expect(store.exists(RUN)).resolves.toBe(true);
    const run = await store.get(RUN);
    expect(run).toMatchObject({ id: RUN, task: 'compare two monitors' });
  });

  it('reads back the companion’s appended events through the daemon’s paging port, in order', async () => {
    op({
      grant: token,
      kind: 'insert',
      table: 'studio_runs',
      row: { id: RUN, task: 'append then read', created_at: '2026-09-03T00:00:00.000Z' },
    });
    for (const seq of [1, 2, 3]) {
      op({
        grant: token,
        kind: 'insert',
        table: 'studio_run_events',
        // `actor` and `payload` are JSON TEXT in this table. The broker stores the cell and asks no
        // questions about it — which is the design — so it is the writer's job to store what the other
        // reader parses. A test that wrote a bare `agent` here would pass the broker and break the daemon.
        row: {
          run_id: RUN,
          seq,
          ts: `2026-09-03T00:00:0${seq}.000Z`,
          actor: JSON.stringify({ kind: 'agent' }),
          type: 'step',
          payload: JSON.stringify({ seq }),
        },
      });
    }
    op({ grant: token, kind: 'update', table: 'studio_runs', row: { last_seq: 3 }, where: { id: RUN } });

    const viaDaemon = await store.eventsSince(RUN, 0, 50);
    const viaBroker = op({ grant: token, kind: 'read', table: 'studio_run_events', where: { run_id: RUN }, limit: 50 });

    expect(viaDaemon.map((e) => e.seq)).toEqual([1, 2, 3]);
    // Not "both non-empty": the same sequence, in the same order, from both readers.
    expect(viaBroker.map((e) => e.seq)).toEqual(viaDaemon.map((e) => e.seq));
    expect(viaDaemon[1]!.actor).toEqual({ kind: 'agent' });
  });

  it('shows the daemon’s own writes to the companion, in the same rows', async () => {
    const created = await store.create({ task: 'daemon writes first' });

    const rows = op({ grant: token, kind: 'read', table: 'studio_runs', where: { id: created.id }, limit: 5 });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: created.id, task: 'daemon writes first' });

    // `appendEvent` is optional on the port; the daemon's native binding has it, and a binding that
    // did not would fail here rather than silently skip the half of the claim it carries.
    expect(store.appendEvent).toBeDefined();
    await store.appendEvent!(created.id, { actor: { kind: 'agent' }, type: 'agent.step', payload: { n: 1 } });
    const events = op({
      grant: token,
      kind: 'read',
      table: 'studio_run_events',
      where: { run_id: created.id },
      limit: 50,
    });
    // `run.created` is the daemon's own first row: the companion sees the WHOLE stream, not the part
    // it happened to write, which is what makes one shared log a shared log.
    expect(events.map((e) => e.type)).toEqual(['run.created', 'agent.step']);
    // The tail the daemon advanced is the tail the companion reads — one column, not two beliefs.
    const [run] = op({ grant: token, kind: 'read', table: 'studio_runs', where: { id: created.id }, limit: 1 });
    expect(run!.last_seq).toBe(events.length);
  });

  it('cuts the companion off without touching the daemon’s access to the same run', async () => {
    const created = await store.create({ task: 'unpair mid-run' });
    grants.revokeAll('unpaired');

    const refused = executeBrokerOp(db, grants, {
      grant: token,
      kind: 'read',
      table: 'studio_runs',
      limit: 5,
    });

    expect(refused).toEqual({ ok: false, reason: 'grant_revoked', table: 'studio_runs' });
    // The run is the daemon's and outlives the pairing: unpairing ends an access, not a run.
    await expect(store.exists(created.id)).resolves.toBe(true);
  });
});
