import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resetConfig } from '../../../src/config.js';
import {
  BROKER_ROUTE,
  COMPANION_CONTRACT_VERSION,
  PAIRING_ROUTE,
} from '../../../src/companion-contract/index.js';
import type { BrokerGrant, CompanionHello } from '../../../src/companion-contract/index.js';

/**
 * SD-409 — a kind this build does not recognise must refuse, never mutate.
 *
 * The dispatch inside `executeBrokerOp` was a chain of `if`s — read, insert, update — whose fall-through
 * was an unconditional DELETE. The route in front of it validates only `typeof op.kind === 'string'`, so
 * every kind that is not one of the first three reached the delete: a forward-version companion sending
 * `upsert` with a `where` filter deleted the rows the filter matched and was told `ok`.
 *
 * That inverts the tolerance the whole B-hybrid split rests on (spec §6). The two sides are ALLOWED to be
 * at different heads; what a head this side does not understand must produce is a refusal, not a
 * different mutation. So the fixture sits in the gap the bug lived in — a kind the ROUTE accepts as a
 * string and the DISPATCH did not match — and the row it would have deleted is one the where-filter
 * really matches, because a filter that matched nothing would pass against the broken code too.
 */
describe('companion broker — closed op-kind set', () => {
  const originalEnv = process.env;
  let dataDir: string;
  let daemon: { start: () => Promise<string>; stop: () => Promise<void> };
  let url: string;

  const RUN_ID = 'run-409';

  async function post(route: string, body: unknown): Promise<{ status: number; body: any }> {
    const resp = await fetch(`${url}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: resp.status, body: await resp.json() };
  }

  /** A live readwrite grant over every shared table, taken from the daemon's own pairing answer. */
  async function pairedGrant(): Promise<BrokerGrant> {
    const probe = await post(PAIRING_ROUTE, {
      contractVersion: COMPANION_CONTRACT_VERSION,
      schemaHead: 0,
      minSchemaHead: 0,
      capabilities: [],
    });
    const head = (probe.body.external as CompanionHello).schemaHead;
    const paired = await post(PAIRING_ROUTE, {
      contractVersion: COMPANION_CONTRACT_VERSION,
      schemaHead: head,
      minSchemaHead: head,
      capabilities: ['broker'],
    });
    expect(paired.body.ok).toBe(true);
    return paired.body.grant as BrokerGrant;
  }

  async function runRows(grant: string): Promise<any[]> {
    const read = await post(BROKER_ROUTE, { grant, kind: 'read', table: 'studio_runs', limit: 50 });
    expect(read.body.ok).toBe(true);
    return read.body.rows as any[];
  }

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'wigolo-broker-kind-'));
    process.env = { ...originalEnv, WIGOLO_DATA_DIR: dataDir, LOG_LEVEL: 'error' };
    resetConfig();
    const { DaemonHttpServer } = await import('../../../src/daemon/http-server.js');
    daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1' });
    url = await daemon.start();
  });

  afterEach(async () => {
    await daemon.stop();
    const { closeDatabase } = await import('../../../src/cache/db.js');
    closeDatabase();
    resetConfig();
    process.env = originalEnv;
  });

  it('answers 400 for a kind off the contract set and changes no row the filter matched', async () => {
    const grant = await pairedGrant();

    const seeded = await post(BROKER_ROUTE, {
      grant: grant.token,
      kind: 'insert',
      table: 'studio_runs',
      row: { id: RUN_ID, task: 'demo task', created_at: '2026-09-05T00:00:00.000Z' },
    });
    expect(seeded.body.ok).toBe(true);
    const before = await runRows(grant.token);
    expect(before.map((r) => r.id)).toContain(RUN_ID);

    const { status, body } = await post(BROKER_ROUTE, {
      grant: grant.token,
      kind: 'upsert',
      table: 'studio_runs',
      row: { status: 'done' },
      where: { id: RUN_ID },
    });

    expect(status).toBe(400);
    expect(body).toEqual({
      ok: false,
      error: 'malformed_op',
      error_reason: 'op.kind must be one of: read, delete, insert, update',
      stage: 'companion',
    });

    // Read back through the broker...
    const after = await runRows(grant.token);
    expect(after).toEqual(before);
    // ...and again straight off the file, because a read that shares its dispatch with the write under
    // test could agree with a bug in both halves at once.
    const { getDatabase } = await import('../../../src/cache/db.js');
    const rows = getDatabase().prepare('SELECT * FROM studio_runs').all();
    expect(rows).toEqual(before);
  });

  it('still dispatches every kind the contract does name', async () => {
    const grant = await pairedGrant();
    await post(BROKER_ROUTE, {
      grant: grant.token,
      kind: 'insert',
      table: 'studio_runs',
      row: { id: RUN_ID, task: 'demo task', created_at: '2026-09-05T00:00:00.000Z' },
    });

    const updated = await post(BROKER_ROUTE, {
      grant: grant.token,
      kind: 'update',
      table: 'studio_runs',
      row: { status: 'done' },
      where: { id: RUN_ID },
    });
    expect(updated.body).toEqual({ ok: true, rows: [{ changes: 1 }] });

    const deleted = await post(BROKER_ROUTE, {
      grant: grant.token,
      kind: 'delete',
      table: 'studio_runs',
      where: { id: RUN_ID },
    });
    expect(deleted.body).toEqual({ ok: true, rows: [{ changes: 1 }] });
    expect(await runRows(grant.token)).toEqual([]);
  });
});
