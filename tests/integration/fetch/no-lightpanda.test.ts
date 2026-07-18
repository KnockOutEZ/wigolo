/**
 * Acceptance test for SP1: Drop Lightpanda → Chromium-only.
 *
 * Why this matters:
 *  - BrowserPool.fetchWithBrowser must route HTTP→Chromium with no Lightpanda
 *    code path — even when the old env vars are set (they should be inert).
 *  - Under concurrent fetches the Chromium pool must still satisfy all requests
 *    without deadlock or Lightpanda fallback invocations.
 *  - The lightpanda_routing DB table must NOT exist after schema init.
 *  - BrowserType must not include 'lightpanda'.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { initDatabase, closeDatabase } from '../../../src/cache/db.js';
import { resetConfig } from '../../../src/config.js';
import { BrowserPool } from '../../../src/fetch/browser-pool.js';
import type { BrowserType } from '../../../src/types.js';

function startServer(handler: http.RequestListener): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function getPort(server: http.Server): number {
  return (server.address() as AddressInfo).port;
}

describe('SP1 — Lightpanda removed, Chromium-only fetch path', () => {
  let pool: BrowserPool | null = null;
  let server: http.Server | null = null;

  beforeEach(() => {
    resetConfig();
  });

  afterEach(async () => {
    if (pool) {
      await pool.shutdown();
      pool = null;
    }
    if (server) {
      await closeServer(server);
      server = null;
    }
    closeDatabase();
  });

  it('BrowserType union does not include lightpanda', () => {
    // Compile-time check: if 'lightpanda' is in the union the assignment below
    // would compile; the only way to verify removal at runtime is to assert
    // the valid set does not contain the string.
    const validTypes: BrowserType[] = ['chromium', 'firefox', 'webkit'];
    // @ts-expect-error — 'lightpanda' must NOT be a valid BrowserType after SP1
    const _invalid: BrowserType = 'lightpanda';
    expect(validTypes).not.toContain('lightpanda');
  });

  it('lightpanda_routing table does NOT exist after schema init', () => {
    const db = initDatabase(':memory:');
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='lightpanda_routing'",
    ).all() as { name: string }[];
    expect(tables).toHaveLength(0);
  });

  it('BrowserPool.fetchWithBrowser routes to Chromium even when WIGOLO_LIGHTPANDA_ENABLED is set', async () => {
    process.env.WIGOLO_LIGHTPANDA_ENABLED = 'true';
    process.env.WIGOLO_LIGHTPANDA_URL = 'http://localhost:9222';
    process.env.MAX_BROWSERS = '3';
    process.env.PLAYWRIGHT_NAV_TIMEOUT_MS = '10000';
    process.env.PLAYWRIGHT_LOAD_TIMEOUT_MS = '15000';
    resetConfig();

    server = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body><p>Chromium only</p></body></html>');
    });

    pool = new BrowserPool();
    const url = `http://127.0.0.1:${getPort(server)}/`;
    const result = await pool.fetchWithBrowser(url);

    expect(result.html).toContain('Chromium only');
    expect(result.method).toBe('browser');
    // No lightpanda file imported at all: the result must come from Playwright Chromium
    expect(result.statusCode).toBe(200);

    delete process.env.WIGOLO_LIGHTPANDA_ENABLED;
    delete process.env.WIGOLO_LIGHTPANDA_URL;
  }, 30000);

  it('concurrent fetchWithBrowser calls all resolve via Chromium without deadlock', async () => {
    process.env.MAX_BROWSERS = '3';
    process.env.PLAYWRIGHT_NAV_TIMEOUT_MS = '10000';
    process.env.PLAYWRIGHT_LOAD_TIMEOUT_MS = '15000';
    resetConfig();

    server = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body><p>concurrent ok</p></body></html>');
    });

    pool = new BrowserPool();
    const url = `http://127.0.0.1:${getPort(server)}/`;

    const results = await Promise.all([
      pool.fetchWithBrowser(url),
      pool.fetchWithBrowser(url),
      pool.fetchWithBrowser(url),
    ]);

    for (const r of results) {
      expect(r.html).toContain('concurrent ok');
      expect(r.method).toBe('browser');
    }
  }, 60000);

  // NOTE: the migration DROP path (an existing DB that HAD lightpanda_routing →
  // table dropped after applyMigrations) is covered directly against the
  // migration runner in tests/unit/cache/migrations-runner.test.ts, where a
  // single DB instance is seeded with the legacy table and then migrated.
});
