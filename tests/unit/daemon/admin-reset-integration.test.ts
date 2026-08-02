// Deterministic breaker-trip → reset acceptance (D9 CONTRACT #7).
//
// Trips a REAL circuit breaker by pointing one engine at a local HTTP server
// that returns 403 three times — no test-only trip hook in prod code. Then
// proves BOTH reset paths clear it via getBreakerSnapshot():
//   1. in-process resetBreakers() (what `doctor --fix` calls locally).
//   2. the authed POST /admin/reset-breakers admin route on a running daemon.
//
// Placed under tests/unit/daemon so the S9 gate (`vitest run tests/unit/cli
// tests/unit/daemon`) exercises it.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetConfig } from '../../../src/config.js';
import {
  wrapWithRetryAndBreaker,
  getBreakerSnapshot,
  resetBreakers,
} from '../../../src/search/core/engine-base.js';
import type { SearchEngine } from '../../../src/types.js';

/** A local server that always answers 403 — a reputational block signal. */
function start403Server(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}/` });
    });
  });
}

/** A real engine that fetches the 403 server and throws a 403-classified error
 * so classifyFailure() routes it down the hard-failure (trips) ladder. */
function make403Engine(name: string, url: string): SearchEngine {
  return {
    name,
    async search() {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`engine ${name} upstream returned ${resp.status} Forbidden`);
      return [];
    },
  };
}

async function tripBreaker(engine: SearchEngine): Promise<void> {
  // retryAttempts:1 → one recordFailure per call; threshold 3 → 3 calls trip it.
  const wrapped = wrapWithRetryAndBreaker(engine, { retryAttempts: 1 });
  for (let i = 0; i < 3; i++) {
    await wrapped.search('q').catch(() => undefined);
  }
}

let server: Server;
let url: string;
let dir: string;

beforeEach(async () => {
  resetBreakers();
  resetConfig();
  dir = mkdtempSync(join(tmpdir(), 'wigolo-admin-reset-'));
  process.env.WIGOLO_DATA_DIR = dir;
  resetConfig();
  const started = await start403Server();
  server = started.server;
  url = started.url;
});

afterEach(async () => {
  resetBreakers();
  resetConfig();
  delete process.env.WIGOLO_DATA_DIR;
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

describe('deterministic breaker trip → in-process reset', () => {
  it('a local 403×3 opens the breaker; resetBreakers() clears it (doctor --fix in-proc path)', async () => {
    const engine = make403Engine('admin-reset-inproc', url);
    await tripBreaker(engine);

    const tripped = getBreakerSnapshot().find((b) => b.engine === 'admin-reset-inproc');
    expect(tripped).toBeDefined();
    expect(tripped!.state).not.toBe('closed');

    // What doctor --fix runs locally.
    resetBreakers();

    expect(getBreakerSnapshot()).toHaveLength(0);
  });
});

describe('deterministic breaker trip → daemon admin-route reset', () => {
  it('a tripped breaker is cleared via the authed POST /admin/reset-breakers', async () => {
    const engine = make403Engine('admin-reset-daemon', url);
    await tripBreaker(engine);
    expect(getBreakerSnapshot().some((b) => b.engine === 'admin-reset-daemon' && b.state !== 'closed')).toBe(true);

    const { DaemonHttpServer } = await import('../../../src/daemon/http-server.js');
    const { readAdminToken } = await import('../../../src/daemon/admin-token.js');
    const daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1' });
    try {
      const daemonUrl = await daemon.start();
      const token = readAdminToken(dir);
      const resp = await fetch(`${daemonUrl}/admin/reset-breakers`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(resp.status).toBe(200);
      const body = await resp.json();
      expect(body.reset).toBe(true);
      // The route runs in THIS process (daemon shares the module-level breaker
      // Map), so the snapshot is now empty.
      expect(getBreakerSnapshot()).toHaveLength(0);
    } finally {
      await daemon.stop();
    }
  });
});
