import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resetConfig } from '../../src/config.js';
import {
  BROKER_REFUSAL_REASONS,
  BROKER_ROUTE,
  COMPANION_CONTRACT_VERSION,
  MAX_BROKER_ROWS,
  PAIRING_ROUTE,
  isBrokerRefusal,
} from '../../src/companion-contract/index.js';
import type { BrokerGrant } from '../../src/companion-contract/index.js';

/**
 * #334's transport claim, carried onto the wire C3 gave the broker.
 *
 * The original worry was exact and still applies: a refusal that THREW arrived as a transport failure,
 * so a route whose documented answer is a typed 404/409/400 answered 500 instead, and the reason the
 * caller needed was flattened to a bare message. The transport changed — newline-delimited JSON-RPC over
 * a child's stdio became one POST on the daemon — and the failure mode survived the change intact, so
 * the test does too.
 *
 * Every row below reads the FRAME, not the value: a typed refusal must arrive 200 with its reason in the
 * body (the wire's own `isBrokerRefusal` has to accept it), and a question the broker cannot answer at
 * all must arrive 400 with a reason, never 500. In-process that difference is invisible, because a thrown
 * error and a returned refusal are both just what the function did.
 */
describe('companion broker — refusals cross the wire as values', () => {
  const originalEnv = process.env;
  let dir: string;
  let daemon: { stop: () => Promise<void> };
  let url: string;
  let grant: BrokerGrant;

  async function post(route: string, body: unknown): Promise<{ status: number; body: any }> {
    const resp = await fetch(`${url}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: resp.status, body: await resp.json() };
  }

  async function pair(): Promise<BrokerGrant> {
    const { body } = await post(PAIRING_ROUTE, {
      contractVersion: COMPANION_CONTRACT_VERSION,
      schemaHead: 0,
      minSchemaHead: 0,
      capabilities: ['broker'],
    });
    return body.grant as BrokerGrant;
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wigolo-broker-wire-'));
    process.env = { ...originalEnv, WIGOLO_DATA_DIR: dir, LOG_LEVEL: 'error' };
    resetConfig();
    const { DaemonHttpServer } = await import('../../src/daemon/http-server.js');
    const server = new DaemonHttpServer({ port: 0, host: '127.0.0.1' });
    url = await server.start();
    daemon = server;
    grant = await pair();
  });

  afterEach(async () => {
    await daemon.stop();
    resetConfig();
    process.env = originalEnv;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* the OS owns the temp dir */ }
  });

  it('answers every refusal a paired companion can provoke with 200 and a typed body', async () => {
    const cases: Array<{ reason: string; op: Record<string, unknown> }> = [
      { reason: 'unknown_table', op: { grant: grant.token, kind: 'read', table: 'url_cache', limit: 5 } },
      {
        reason: 'row_limit_exceeded',
        op: { grant: grant.token, kind: 'read', table: 'studio_runs', limit: MAX_BROKER_ROWS + 1 },
      },
      { reason: 'no_grant', op: { grant: 'never-issued', kind: 'read', table: 'studio_runs', limit: 5 } },
    ];

    for (const { reason, op } of cases) {
      const { status, body } = await post(BROKER_ROUTE, op);
      expect(status, `${reason} must not be an HTTP failure`).toBe(200);
      expect(body.reason).toBe(reason);
      // The wire's own guard has to accept it: a refusal the contract cannot recognise is one the
      // companion's client will treat as "no answer", which is the failure this file is about.
      expect(isBrokerRefusal(body)).toBe(true);
      expect(body.error).toBeUndefined();
    }
  }, 60_000);

  it('names the refusals the pairing route cannot currently produce, so a narrower grant is a deliberate change', () => {
    // The route issues ONE grant shape today — readwrite over every shared table, valid until revoked or
    // superseded — so three arms of the closed enum are unreachable through it and are covered against
    // the executor instead. Listed rather than counted: the day the route issues a scoped or expiring
    // grant, these become reachable over the wire and this row is where that is noticed.
    const unreachableThroughTheRoute = ['grant_expired', 'table_not_granted', 'write_not_granted'];
    const reachable = ['grant_revoked', 'no_grant', 'row_limit_exceeded', 'unknown_table'];

    expect([...unreachableThroughTheRoute, ...reachable].sort()).toEqual([...BROKER_REFUSAL_REASONS].sort());
  });

  it('answers an unanswerable op with 400 and a reason, never a 500 that loses it', async () => {
    const { status, body } = await post(BROKER_ROUTE, {
      grant: grant.token,
      kind: 'update',
      table: 'studio_runs',
      row: { status: 'done' },
    });

    expect(status).toBe(400);
    expect(body.error).toBe('malformed_op');
    expect(body.error_reason).toMatch(/where/i);
    // Not a refusal: the closed enum means access, and a caller that read this as one would go looking
    // for a grant to fix a missing filter.
    expect(isBrokerRefusal(body)).toBe(false);
  }, 60_000);

  it('keeps a revoked pairing’s refusal typed rather than turning it into a transport failure', async () => {
    await daemon.stop();
    const { DaemonHttpServer } = await import('../../src/daemon/http-server.js');
    const restarted = new DaemonHttpServer({ port: 0, host: '127.0.0.1' });
    url = await restarted.start();
    daemon = restarted;

    const { status, body } = await post(BROKER_ROUTE, {
      grant: grant.token,
      kind: 'read',
      table: 'studio_run_events',
      limit: 5,
    });

    expect(status).toBe(200);
    expect(isBrokerRefusal(body)).toBe(true);
    expect(body.reason).toBe('no_grant');
  }, 60_000);

  it('carries a long run log across the wire in bounded pages, in order', async () => {
    const RUN = 'wire9';
    await post(BROKER_ROUTE, {
      grant: grant.token,
      kind: 'insert',
      table: 'studio_runs',
      row: { id: RUN, task: 'long log', created_at: '2026-09-03T00:00:00.000Z' },
    });
    const payload = JSON.stringify({ text: 'x'.repeat(2_000) });
    for (let seq = 1; seq <= 30; seq++) {
      await post(BROKER_ROUTE, {
        grant: grant.token,
        kind: 'insert',
        table: 'studio_run_events',
        row: { run_id: RUN, seq, ts: 't', actor: JSON.stringify({ kind: 'agent' }), type: 'agent.step', payload },
      });
    }

    const seen: number[] = [];
    let cursor: number | undefined;
    for (let page = 0; page < 5; page++) {
      const { body } = await post(BROKER_ROUTE, {
        grant: grant.token,
        kind: 'read',
        table: 'studio_run_events',
        where: { run_id: RUN },
        limit: 12,
        ...(cursor === undefined ? {} : { since: cursor }),
      });
      expect(body.ok).toBe(true);
      if (body.rows.length === 0) break;
      expect(body.rows.length).toBeLessThanOrEqual(12);
      seen.push(...body.rows.map((r: { seq: number }) => r.seq));
      cursor = body.rows.at(-1).seq;
    }

    expect(seen).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
  }, 120_000);
});
