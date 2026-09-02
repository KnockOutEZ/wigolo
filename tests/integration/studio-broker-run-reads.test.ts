import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resetConfig } from '../../src/config.js';
import {
  BROKER_ROUTE,
  COMPANION_CONTRACT_VERSION,
  MAX_BROKER_ROWS,
  PAIRING_ROUTE,
} from '../../src/companion-contract/index.js';
import type { BrokerGrant, BrokerRow } from '../../src/companion-contract/index.js';

/**
 * EXTRACT C3 — the run reads a paired companion actually performs, end to end over the wire.
 *
 * The old integration test here asserted the bounds of a domain read the broker no longer does. What
 * replaced it is smaller and lives one layer down: the companion pages the event log itself, using the
 * cursor and the row bound the wire gives it. This proves the whole path — pair, grant, insert, page,
 * bound, unpair — through a REAL daemon on a real socket, because that path crosses HTTP framing, JSON
 * round-tripping and the daemon's own auth gate, none of which a unit test of the executor exercises.
 */
describe('companion broker — paged run reads over a paired daemon', () => {
  const originalEnv = process.env;
  let dataDir: string;
  let daemon: { stop: () => Promise<void> };
  let url: string;
  let grant: BrokerGrant;

  const RUN = 'run-paged';

  async function post(route: string, body: unknown): Promise<any> {
    const resp = await fetch(`${url}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: resp.status, body: await resp.json() };
  }

  async function op(body: Record<string, unknown>): Promise<BrokerRow[]> {
    const { body: answer } = await post(BROKER_ROUTE, { grant: grant.token, ...body });
    if (!answer.ok) throw new Error(`op refused: ${answer.reason}`);
    return answer.rows as BrokerRow[];
  }

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'wigolo-broker-integration-'));
    process.env = { ...originalEnv, WIGOLO_DATA_DIR: dataDir, LOG_LEVEL: 'error' };
    resetConfig();
    const { DaemonHttpServer } = await import('../../src/daemon/http-server.js');
    const server = new DaemonHttpServer({ port: 0, host: '127.0.0.1' });
    url = await server.start();
    daemon = server;

    const paired = await post(PAIRING_ROUTE, {
      contractVersion: COMPANION_CONTRACT_VERSION,
      schemaHead: 0,
      minSchemaHead: 0,
      capabilities: ['broker'],
    });
    grant = paired.body.grant as BrokerGrant;

    await op({
      kind: 'insert',
      table: 'studio_runs',
      row: { id: RUN, task: 'page me', created_at: '2026-09-03T00:00:00.000Z' },
    });
  });

  afterEach(async () => {
    await daemon.stop();
    resetConfig();
    process.env = originalEnv;
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* the OS owns the temp dir */ }
  });

  async function appendEvents(n: number): Promise<void> {
    for (let seq = 1; seq <= n; seq++) {
      await op({
        kind: 'insert',
        table: 'studio_run_events',
        row: { run_id: RUN, seq, ts: 't', actor: 'agent', type: 'step', payload: JSON.stringify({ seq }) },
      });
    }
    await op({ kind: 'update', table: 'studio_runs', row: { last_seq: n }, where: { id: RUN } });
  }

  it('walks a log longer than one page, resuming from the cursor and never repeating a row', async () => {
    await appendEvents(25);

    const seen: number[] = [];
    let cursor: number | undefined;
    for (let page = 0; page < 10; page++) {
      const rows = await op({
        kind: 'read',
        table: 'studio_run_events',
        where: { run_id: RUN },
        limit: 10,
        ...(cursor === undefined ? {} : { since: cursor }),
      });
      if (rows.length === 0) break;
      seen.push(...rows.map((r) => r.seq as number));
      cursor = rows.at(-1)!.seq as number;
    }

    expect(seen).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    expect(new Set(seen).size).toBe(seen.length);
  }, 60_000);

  it('reports the run tail without materialising the log behind it', async () => {
    await appendEvents(25);

    const [run] = await op({ kind: 'read', table: 'studio_runs', where: { id: RUN }, limit: 1 });

    // The tail is a stored column, so learning it costs ONE row — the reason the old boot path's frame
    // budget existed at all is that it answered this question by reading the whole log.
    expect(run).toMatchObject({ id: RUN, last_seq: 25 });
  }, 60_000);

  it('refuses a read that names more rows than the wire allows, over the wire', async () => {
    await appendEvents(3);

    const { status, body } = await post(BROKER_ROUTE, {
      grant: grant.token,
      kind: 'read',
      table: 'studio_run_events',
      limit: MAX_BROKER_ROWS + 1,
    });

    // A refusal is a decision the route made successfully: 200, with the verdict in the body where the
    // companion's own guard reads it.
    expect(status).toBe(200);
    expect(body).toEqual({ ok: false, reason: 'row_limit_exceeded', table: 'studio_run_events' });
  }, 60_000);

  it('leaves the rows behind when the pairing ends, and refuses the reads', async () => {
    await appendEvents(3);
    await daemon.stop();

    const { DaemonHttpServer } = await import('../../src/daemon/http-server.js');
    const restarted = new DaemonHttpServer({ port: 0, host: '127.0.0.1' });
    url = await restarted.start();
    daemon = restarted;

    const refused = await post(BROKER_ROUTE, {
      grant: grant.token,
      kind: 'read',
      table: 'studio_run_events',
      limit: 10,
    });
    expect(refused.body).toEqual({ ok: false, reason: 'no_grant', table: 'studio_run_events' });

    const repaired = await post(PAIRING_ROUTE, {
      contractVersion: COMPANION_CONTRACT_VERSION,
      schemaHead: 0,
      minSchemaHead: 0,
      capabilities: ['broker'],
    });
    grant = repaired.body.grant as BrokerGrant;
    const rows = await op({ kind: 'read', table: 'studio_run_events', where: { run_id: RUN }, limit: 10 });

    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]);
  }, 60_000);
});
