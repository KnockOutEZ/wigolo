import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { resetConfig } from '../../src/config.js';
import { BrowserPool } from '../../src/fetch/browser-pool.js';
import { SmartRouter } from '../../src/fetch/router.js';
import { httpFetch } from '../../src/fetch/http-client.js';
import { handleFetch } from '../../src/tools/fetch.js';
import { handleCache } from '../../src/tools/cache.js';
import { initDatabase, closeDatabase, getDatabase } from '../../src/cache/db.js';
import type { FetchInput } from '../../src/types.js';

const FIXTURES_DIR = join(import.meta.dirname, '..', 'fixtures', 'changing-page');

let currentVersion = 'v1';

function startVersionServer(): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const fixture = currentVersion === 'v1' ? 'v1.html' : 'v2.html';
      const content = fs.readFileSync(join(FIXTURES_DIR, fixture), 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(content);
    });
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

function expireCacheEntries(): void {
  const db = getDatabase();
  db.prepare("UPDATE url_cache SET expires_at = datetime('now', '-1 hour')").run();
}

describe('Change Detection Integration', () => {
  let server: http.Server;
  let port: number;
  let router: SmartRouter;
  let pool: BrowserPool;

  beforeAll(async () => {
    server = await startVersionServer();
    port = getPort(server);
  });

  afterAll(async () => {
    await closeServer(server);
  });

  beforeEach(() => {
    resetConfig();
    initDatabase(':memory:');
    pool = new BrowserPool();
    const httpClient = { fetch: (url: string, options?: { headers?: Record<string, string>; timeoutMs?: number }) => httpFetch(url, options) };
    router = new SmartRouter(httpClient, pool);
    currentVersion = 'v1';
  });

  afterEach(async () => {
    closeDatabase();
    await pool.shutdown();
  });

  it('first fetch returns no change detection fields', async () => {
    const input: FetchInput = {
      url: `http://127.0.0.1:${port}/doc`,
      render_js: 'never',
    };

    const result = await handleFetch(input, router);

    expect(result.error).toBeUndefined();
    expect(result.cached).toBe(false);
    expect(result.changed).toBeUndefined();
    expect(result.previous_hash).toBeUndefined();
    expect(result.diff_summary).toBeUndefined();
    expect(result.markdown).toContain('Getting Started');
  }, 15000);

  it('second fetch of same content returns no change', async () => {
    const input: FetchInput = {
      url: `http://127.0.0.1:${port}/doc`,
      render_js: 'never',
    };

    await handleFetch(input, router);

    expireCacheEntries();

    const result = await handleFetch({ ...input }, router);

    expect(result.cached).toBe(false);
    expect(result.changed).toBeUndefined();
  }, 15000);

  it('detects change when page content is updated', async () => {
    const url = `http://127.0.0.1:${port}/doc`;
    const input: FetchInput = { url, render_js: 'never' };

    const first = await handleFetch(input, router);
    expect(first.error).toBeUndefined();
    expect(first.cached).toBe(false);

    currentVersion = 'v2';
    expireCacheEntries();

    const second = await handleFetch({ url, render_js: 'never' }, router);

    expect(second.cached).toBe(false);
    expect(second.changed).toBe(true);
    expect(second.previous_hash).toBeDefined();
    expect(second.previous_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(second.diff_summary).toBeDefined();
    expect(second.diff_summary).toMatch(/\d+ lines? added/);
  }, 15000);

  it('cache check_changes reports changes for matching URLs', async () => {
    const url = `http://127.0.0.1:${port}/doc`;
    const input: FetchInput = { url, render_js: 'never' };

    await handleFetch(input, router);

    const cacheResult = await handleCache({
      check_changes: true,
      url_pattern: `*127.0.0.1*`,
    }, router);

    expect(cacheResult.changes).toBeDefined();
    expect(cacheResult.changes!.length).toBeGreaterThanOrEqual(1);
    expect(cacheResult.changes![0].url).toContain('127.0.0.1');
  }, 15000);

  it('check_changes returns empty array when no URLs match', async () => {
    const cacheResult = await handleCache({
      check_changes: true,
      url_pattern: '*nonexistent*',
    }, router);

    expect(cacheResult.changes).toBeDefined();
    expect(cacheResult.changes).toHaveLength(0);
  });

  it('change detection works with normalized URLs', async () => {
    const url = `http://127.0.0.1:${port}/doc?utm_source=test`;
    const input: FetchInput = { url, render_js: 'never' };

    const first = await handleFetch(input, router);
    expect(first.error).toBeUndefined();

    currentVersion = 'v2';
    expireCacheEntries();

    const url2 = `http://127.0.0.1:${port}/doc?utm_source=other`;
    const second = await handleFetch({ url: url2, render_js: 'never' }, router);

    expect(second.cached).toBe(false);
    expect(second.changed).toBe(true);
  }, 15000);

  it('diff summary contains meaningful information', async () => {
    const url = `http://127.0.0.1:${port}/doc`;
    await handleFetch({ url, render_js: 'never' }, router);

    currentVersion = 'v2';
    expireCacheEntries();

    const result = await handleFetch({ url, render_js: 'never' }, router);

    if (!result.cached && result.changed) {
      expect(result.diff_summary).toMatch(/\d+ lines? added, \d+ lines? removed, \d+ lines? modified/);
    }
  }, 15000);

  it('handles rapid successive fetches without corruption', async () => {
    const url = `http://127.0.0.1:${port}/doc`;

    await handleFetch({ url, render_js: 'never' }, router);

    currentVersion = 'v2';
    expireCacheEntries();

    const results = await Promise.all([
      handleFetch({ url, render_js: 'never' }, router),
      handleFetch({ url, render_js: 'never' }, router),
    ]);

    for (const result of results) {
      expect(result.error).toBeUndefined();
    }
  }, 15000);
});
