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
 * EXTRACT C3 — the daemon's half of pairing (spec §2.1 seam 2, §6) and the broker route it hands out a
 * grant for (D8), against a REAL daemon on a real socket.
 *
 * The claims that matter here are the ones a unit test of the store cannot make: that the schema heads
 * actually cross the wire and are judged by the contract's own rule; that a refusal mints nothing; that a
 * relaunched companion supersedes its predecessor rather than running beside it; and that a table op
 * reaching this route without a live grant is refused by the same closed enum the app already knows.
 */
describe('companion pairing + broker routes', () => {
  const originalEnv = process.env;
  let dataDir: string;
  let daemon: { start: () => Promise<string>; stop: () => Promise<void> };
  let url: string;

  async function post(route: string, body: unknown): Promise<{ status: number; body: any }> {
    const resp = await fetch(`${url}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: resp.status, body: await resp.json() };
  }

  async function pair(overrides: Record<string, unknown> = {}) {
    const head = await externalHead();
    return post(PAIRING_ROUTE, {
      contractVersion: COMPANION_CONTRACT_VERSION,
      schemaHead: head,
      minSchemaHead: head,
      capabilities: ['broker'],
      ...overrides,
    });
  }

  /**
   * The head the daemon itself reports — read from its own answer, never recomputed here. Recomputing it
   * from the migrations list would make every assertion below agree with the code under test by
   * construction; asking the daemon makes the head an OUTSIDE fact the test can be wrong about.
   */
  async function probePairing(): Promise<{ head: number; grant: BrokerGrant }> {
    const probe = await post(PAIRING_ROUTE, {
      contractVersion: COMPANION_CONTRACT_VERSION,
      schemaHead: 0,
      minSchemaHead: 0,
      capabilities: [],
    });
    return { head: (probe.body.external as CompanionHello).schemaHead, grant: probe.body.grant as BrokerGrant };
  }

  async function externalHead(): Promise<number> {
    return (await probePairing()).head;
  }

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'wigolo-pairing-'));
    process.env = { ...originalEnv, WIGOLO_DATA_DIR: dataDir, LOG_LEVEL: 'error' };
    resetConfig();
    const { DaemonHttpServer } = await import('../../../src/daemon/http-server.js');
    daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1' });
    url = await daemon.start();
  });

  afterEach(async () => {
    await daemon.stop();
    resetConfig();
    process.env = originalEnv;
  });

  it('answers a matching hello with its own hello and a readwrite grant over every shared table', async () => {
    const { status, body } = await pair();

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.external.contractVersion).toBe(COMPANION_CONTRACT_VERSION);
    expect(body.external.capabilities).toContain('broker');
    const grant = body.grant as BrokerGrant;
    expect(grant.mode).toBe('readwrite');
    expect(grant.schemaHead).toBe(body.external.schemaHead);
    expect(grant.tables).toContain('studio_runs');
    expect(grant.tables).toContain('studio_run_events');
  });

  it('refuses a companion whose minimum head is ahead of this daemon, minting nothing and superseding nothing', async () => {
    const live = await probePairing();

    // Posted directly rather than through `pair()`: that helper probes first, and a probe is itself a
    // pairing that would supersede `live` before the refusal under test ever ran.
    const { status, body } = await post(PAIRING_ROUTE, {
      contractVersion: COMPANION_CONTRACT_VERSION,
      schemaHead: live.head,
      minSchemaHead: live.head + 1,
      capabilities: ['broker'],
    });

    expect(status).toBe(409);
    expect(body).toEqual({ ok: false, reason: 'schema_too_old', hint: 'update_wigolo' });
    expect(body.grant).toBeUndefined();
    // A refused pairing mints no token of its own...
    const invented = await post(BROKER_ROUTE, { grant: 'invented', kind: 'read', table: 'studio_runs', limit: 5 });
    expect(invented.body).toEqual({ ok: false, reason: 'no_grant', table: 'studio_runs' });
    // ...and does not disturb the companion that IS paired, which a supersede-then-check order would.
    const stillLive = await post(BROKER_ROUTE, {
      grant: live.grant.token,
      kind: 'read',
      table: 'studio_runs',
      limit: 5,
    });
    expect(stillLive.body.ok).toBe(true);
  });

  it('refuses a contract MAJOR mismatch and names the side that must update', async () => {
    const older = await pair({ contractVersion: '99.0.0' });
    expect(older.status).toBe(409);
    expect(older.body).toEqual({ ok: false, reason: 'contract_major_mismatch', hint: 'update_wigolo' });

    const newer = await pair({ contractVersion: '0.9.0' });
    expect(newer.body).toEqual({ ok: false, reason: 'contract_major_mismatch', hint: 'update_studio' });
  });

  it('rejects a hello that is not one', async () => {
    const { status, body } = await post(PAIRING_ROUTE, { contractVersion: COMPANION_CONTRACT_VERSION });

    expect(status).toBe(400);
    expect(body.error).toBe('malformed_hello');
  });

  it('runs a granted table op end to end and refuses the same op once the grant is superseded', async () => {
    const first = (await pair()).body.grant as BrokerGrant;

    const inserted = await post(BROKER_ROUTE, {
      grant: first.token,
      kind: 'insert',
      table: 'studio_runs',
      row: { id: 'run-w', task: 'over the wire', created_at: '2026-09-03T00:00:00.000Z' },
    });
    expect(inserted.body.ok).toBe(true);

    const read = await post(BROKER_ROUTE, {
      grant: first.token,
      kind: 'read',
      table: 'studio_runs',
      where: { id: 'run-w' },
      limit: 5,
    });
    expect(read.body.rows).toHaveLength(1);
    expect(read.body.rows[0].task).toBe('over the wire');

    // A relaunched companion pairs again. The first token must die rather than keep writing to a
    // database nobody is watching through it.
    const second = (await pair()).body.grant as BrokerGrant;
    expect(second.token).not.toBe(first.token);

    const stale = await post(BROKER_ROUTE, {
      grant: first.token,
      kind: 'read',
      table: 'studio_runs',
      limit: 5,
    });
    expect(stale.status).toBe(200);
    expect(stale.body).toEqual({ ok: false, reason: 'grant_revoked', table: 'studio_runs' });

    const fresh = await post(BROKER_ROUTE, {
      grant: second.token,
      kind: 'read',
      table: 'studio_runs',
      limit: 5,
    });
    expect(fresh.body.rows).toHaveLength(1);
  });

  it('answers a malformed op with 400 and a typed refusal with 200 — a protocol bug is not an access decision', async () => {
    const grant = (await pair()).body.grant as BrokerGrant;

    const malformed = await post(BROKER_ROUTE, {
      grant: grant.token,
      kind: 'insert',
      table: 'studio_runs',
      row: { id: 'run-x', task: 't', created_at: 'now', nope: 1 },
    });
    expect(malformed.status).toBe(400);
    expect(malformed.body.error).toBe('malformed_op');

    const refused = await post(BROKER_ROUTE, {
      grant: grant.token,
      kind: 'read',
      table: 'url_cache',
      limit: 5,
    });
    expect(refused.status).toBe(200);
    expect(refused.body).toEqual({ ok: false, reason: 'unknown_table' });
  });

  it('is closed to a browser origin, like every other non-REST daemon route', async () => {
    const resp = await fetch(`${url}${PAIRING_ROUTE}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ contractVersion: COMPANION_CONTRACT_VERSION, schemaHead: 1, minSchemaHead: 1 }),
    });

    expect(resp.status).toBe(403);
  });
});
