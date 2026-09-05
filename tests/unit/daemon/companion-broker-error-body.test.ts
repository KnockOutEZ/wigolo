import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resetConfig } from '../../../src/config.js';
import { BROKER_ROUTE } from '../../../src/companion-contract/index.js';

/**
 * SD-406 — a broker op that throws something the route did not anticipate must not hand the thrown
 * message to the caller.
 *
 * The messages that reach this arm are written by the storage layer, and they name absolute file paths
 * ("unable to open database file: /Users/…/.wigolo/cache.db"), column layouts and constraint names. The
 * broker route answers an unauthenticated loopback caller in open mode, so echoing them turns an
 * ordinary 500 into a disclosure of where the machine keeps its data.
 *
 * The two halves are one claim and have to be asserted together: dropping the detail from the WIRE is
 * only correct if the operator can still get it from the LOG. A test that checked the body alone would
 * stay green if someone deleted the log line as well, which would be a worse system than before.
 */
const THROWN = 'unable to open database file: /Users/secretname/.wigolo/cache.db';

vi.mock('../../../src/daemon/studio-db-broker.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/daemon/studio-db-broker.js')>();
  return {
    ...actual,
    executeBrokerOp: vi.fn(() => {
      throw new Error(THROWN);
    }),
  };
});

describe('companion broker route — unexpected failures', () => {
  const originalEnv = process.env;
  let dataDir: string;
  let daemon: { start: () => Promise<string>; stop: () => Promise<void> };
  let url: string;
  let stderr: string[];
  let restoreStderr: () => void;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'wigolo-broker-500-'));
    // `warn`, not `error`: the level is read when the module builds its logger, so the log half of this
    // test only has a chance to observe anything if the route's own level is enabled from the first import.
    process.env = { ...originalEnv, WIGOLO_DATA_DIR: dataDir, LOG_LEVEL: 'warn', LOG_FORMAT: 'json' };
    resetConfig();

    stderr = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stderr.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stderr.write);
    restoreStderr = () => spy.mockRestore();

    const { DaemonHttpServer } = await import('../../../src/daemon/http-server.js');
    daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1' });
    url = await daemon.start();
  });

  afterEach(async () => {
    await daemon.stop();
    restoreStderr();
    resetConfig();
    process.env = originalEnv;
    vi.clearAllMocks();
  });

  async function brokerOp(): Promise<{ status: number; body: any }> {
    const resp = await fetch(`${url}${BROKER_ROUTE}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant: 'grant-token', kind: 'read', table: 'studio_runs', limit: 5 }),
    });
    return { status: resp.status, body: await resp.json() };
  }

  it('answers a fixed reason and keeps the storage-layer message off the wire', async () => {
    const { status, body } = await brokerOp();

    expect(status).toBe(500);
    expect(body.error).toBe('broker_failed');
    expect(body.error_reason).toBe('The broker could not complete this op. The daemon log has the detail.');

    // Spelled out rather than derived from the constant: the fixed string is the thing under test, so an
    // assertion that imported it would agree with any future rewording, including one that reintroduced
    // the path. The whole serialised body is searched because a leak could ride any field.
    const wire = JSON.stringify(body);
    expect(wire).not.toContain(THROWN);
    expect(wire).not.toContain('/Users/secretname');
    expect(wire).not.toContain('cache.db');
  });

  it('keeps the real message in the daemon log, where the operator can read it', async () => {
    await brokerOp();

    const record = stderr
      .join('')
      .split('\n')
      .filter((line) => line.includes('broker op failed'))
      .map((line) => JSON.parse(line) as { level: string; msg: string; data?: { error?: string } });

    expect(record).toHaveLength(1);
    expect(record[0].level).toBe('warn');
    expect(record[0].data?.error).toBe(THROWN);
  });
});
