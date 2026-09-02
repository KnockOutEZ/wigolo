import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resetConfig } from '../../../src/config.js';
import {
  BROKER_ROUTE,
  COMPANION_CONTRACT_VERSION,
  PAIRING_ROUTE,
} from '../../../src/companion-contract/index.js';
import type { BrokerGrant } from '../../../src/companion-contract/index.js';

/**
 * EXTRACT C3 — what a daemon restart does to a pairing.
 *
 * Two things must be true at once and they pull in opposite directions. The RUN survives: its rows are on
 * disk and a second daemon over the same data dir reads them back, which is law 1 at this seam. The GRANT
 * does not: it lives in the daemon process, so a restart un-pairs, and a companion holding yesterday's
 * token is told so rather than being quietly re-admitted. A grant that outlived the process would be a
 * credential on disk that nothing revokes when either side goes away.
 *
 * (The run store's own restart behaviour moved out with the domain layer; what core still owes is the
 * durability of the tables underneath it and the mortality of the grant on top.)
 */
describe('companion broker — a daemon restart keeps the rows and drops the grant', () => {
  const originalEnv = process.env;
  let dataDir: string;

  async function startDaemon(): Promise<{ url: string; stop: () => Promise<void> }> {
    const { DaemonHttpServer } = await import('../../../src/daemon/http-server.js');
    const daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1' });
    const url = await daemon.start();
    return { url, stop: () => daemon.stop() };
  }

  async function post(url: string, route: string, body: unknown): Promise<any> {
    const resp = await fetch(`${url}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return resp.json();
  }

  async function pair(url: string): Promise<BrokerGrant> {
    const probe = await post(url, PAIRING_ROUTE, {
      contractVersion: COMPANION_CONTRACT_VERSION,
      schemaHead: 0,
      minSchemaHead: 0,
      capabilities: ['broker'],
    });
    return probe.grant as BrokerGrant;
  }

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'wigolo-restart-'));
    process.env = { ...originalEnv, WIGOLO_DATA_DIR: dataDir, LOG_LEVEL: 'error' };
    resetConfig();
  });

  afterEach(() => {
    resetConfig();
    process.env = originalEnv;
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* the OS owns the temp dir */ }
  });

  it('reads back the run a previous daemon wrote, but refuses that daemon’s grant', async () => {
    const first = await startDaemon();
    const oldGrant = await pair(first.url);
    const written = await post(first.url, BROKER_ROUTE, {
      grant: oldGrant.token,
      kind: 'insert',
      table: 'studio_runs',
      row: { id: 'run-restart', task: 'survive a restart', created_at: '2026-09-03T00:00:00.000Z' },
    });
    expect(written.ok).toBe(true);
    await first.stop();

    const second = await startDaemon();
    try {
      const stale = await post(second.url, BROKER_ROUTE, {
        grant: oldGrant.token,
        kind: 'read',
        table: 'studio_runs',
        limit: 10,
      });
      expect(stale).toEqual({ ok: false, reason: 'no_grant', table: 'studio_runs' });

      const freshGrant = await pair(second.url);
      expect(freshGrant.token).not.toBe(oldGrant.token);
      const rows = await post(second.url, BROKER_ROUTE, {
        grant: freshGrant.token,
        kind: 'read',
        table: 'studio_runs',
        limit: 10,
      });
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]).toMatchObject({ id: 'run-restart', task: 'survive a restart' });
    } finally {
      await second.stop();
    }
  }, 60_000);

  it('stops honouring a grant the moment its daemon stops, without waiting for a restart', async () => {
    const daemon = await startDaemon();
    const grant = await pair(daemon.url);
    await daemon.stop();

    const again = await startDaemon();
    try {
      const refused = await post(again.url, BROKER_ROUTE, {
        grant: grant.token,
        kind: 'read',
        table: 'studio_run_events',
        limit: 10,
      });
      expect(refused.ok).toBe(false);
    } finally {
      await again.stop();
    }
  }, 60_000);
});
