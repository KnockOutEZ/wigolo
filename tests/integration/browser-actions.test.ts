import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { resetConfig } from '../../src/config.js';
import { BrowserPool } from '../../src/fetch/browser-pool.js';
import { SmartRouter, type HttpClient } from '../../src/fetch/router.js';
import { handleFetch } from '../../src/tools/fetch.js';
import { initDatabase, closeDatabase } from '../../src/cache/db.js';
import type { FetchInput } from '../../src/types.js';

const FIXTURES_DIR = join(import.meta.dirname, '..', 'fixtures');

function readFixture(name: string): string {
  return fs.readFileSync(join(FIXTURES_DIR, name), 'utf-8');
}

const fixtureMap: Record<string, string> = {};

function startFixtureServer(): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const path = req.url ?? '/';
      const fixtureName = path.slice(1);
      const content = fixtureMap[fixtureName];
      if (content) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(content);
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
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

describe('Browser Actions Integration', () => {
  let server: http.Server;
  let port: number;
  let pool: BrowserPool;
  let router: SmartRouter;

  beforeAll(async () => {
    fixtureMap['cookie-banner.html'] = readFixture('cookie-banner.html');
    fixtureMap['form-page.html'] = readFixture('form-page.html');
    fixtureMap['load-more.html'] = readFixture('load-more.html');

    server = await startFixtureServer();
    port = getPort(server);
  });

  afterAll(async () => {
    await closeServer(server);
  });

  beforeEach(() => {
    resetConfig();
    initDatabase(':memory:');
    pool = new BrowserPool();
    const httpClient: HttpClient = {
      fetch: async () => { throw new Error('should not use HTTP client'); },
    };
    router = new SmartRouter(httpClient, pool);
  });

  afterEach(async () => {
    closeDatabase();
    await pool.shutdown();
  });

  it('dismisses cookie banner then extracts content', async () => {
    const input: FetchInput = {
      url: `http://127.0.0.1:${port}/cookie-banner.html`,
      actions: [
        { type: 'wait_for', selector: '.cookie-accept', timeout: 5000 },
        { type: 'click', selector: '.cookie-accept' },
        { type: 'wait', ms: 300 },
      ],
    };

    const result = await handleFetch(input, router);

    expect(result.error).toBeUndefined();
    expect(result.cached).toBe(false);
    expect(result.markdown).toContain('Article Title');
    expect(result.markdown).toContain('main article content');
    expect(result.action_results).toBeDefined();
    expect(result.action_results).toHaveLength(3);
    expect(result.action_results!.every(r => r.success)).toBe(true);
  }, 30000);

  it('fills form and captures result', async () => {
    const input: FetchInput = {
      url: `http://127.0.0.1:${port}/form-page.html`,
      actions: [
        { type: 'wait_for', selector: '#username', timeout: 5000 },
        { type: 'type', selector: '#username', text: 'testuser' },
        { type: 'type', selector: '#password', text: 'secret123' },
        { type: 'click', selector: '#submit-btn' },
        { type: 'wait', ms: 300 },
      ],
    };

    const result = await handleFetch(input, router);

    expect(result.error).toBeUndefined();
    expect(result.markdown).toContain('Welcome');
    expect(result.markdown).toContain('testuser');
    expect(result.action_results).toBeDefined();
    expect(result.action_results).toHaveLength(5);
    expect(result.action_results!.every(r => r.success)).toBe(true);
  }, 30000);

  it('clicks Load More button to reveal additional content', async () => {
    const input: FetchInput = {
      url: `http://127.0.0.1:${port}/load-more.html`,
      actions: [
        { type: 'wait_for', selector: '#load-more', timeout: 5000 },
        { type: 'click', selector: '#load-more' },
        { type: 'wait', ms: 300 },
      ],
    };

    const result = await handleFetch(input, router);

    expect(result.error).toBeUndefined();
    expect(result.markdown).toContain('Item 4');
    expect(result.markdown).toContain('Item 5');
    expect(result.markdown).toContain('Item 6');
    expect(result.markdown).toContain('Dynamically loaded content');
  }, 30000);

  it('captures mid-flow screenshot', async () => {
    const input: FetchInput = {
      url: `http://127.0.0.1:${port}/cookie-banner.html`,
      actions: [
        { type: 'screenshot' },
        { type: 'click', selector: '.cookie-accept' },
        { type: 'wait', ms: 200 },
        { type: 'screenshot' },
      ],
    };

    const result = await handleFetch(input, router);

    expect(result.error).toBeUndefined();
    expect(result.action_results).toHaveLength(4);
    const screenshots = result.action_results!.filter(r => r.type === 'screenshot' && r.screenshot);
    expect(screenshots).toHaveLength(2);
    expect(screenshots[0].screenshot!.length).toBeGreaterThan(0);
    expect(screenshots[1].screenshot!.length).toBeGreaterThan(0);
  }, 30000);

  it('handles action on nonexistent selector without crashing', async () => {
    const input: FetchInput = {
      url: `http://127.0.0.1:${port}/cookie-banner.html`,
      actions: [
        { type: 'click', selector: '.nonexistent-element' },
        { type: 'wait', ms: 100 },
      ],
    };

    const result = await handleFetch(input, router);

    expect(result.action_results).toBeDefined();
    expect(result.action_results![0].success).toBe(false);
    expect(result.action_results![0].error).toBeDefined();
    expect(result.action_results![1].success).toBe(true);
    expect(result.markdown).toBeDefined();
  }, 30000);

  it('performs scroll action', async () => {
    const input: FetchInput = {
      url: `http://127.0.0.1:${port}/load-more.html`,
      actions: [
        { type: 'scroll', direction: 'down', amount: 500 },
        { type: 'wait', ms: 200 },
      ],
    };

    const result = await handleFetch(input, router);

    expect(result.error).toBeUndefined();
    expect(result.action_results).toBeDefined();
    expect(result.action_results!.every(r => r.success)).toBe(true);
  }, 30000);

  it('handles empty actions array identically to no actions', async () => {
    const input: FetchInput = {
      url: `http://127.0.0.1:${port}/load-more.html`,
      render_js: 'always',
      actions: [],
    };

    const result = await handleFetch(input, router);

    expect(result.error).toBeUndefined();
    expect(result.action_results).toBeUndefined();
    expect(result.markdown).toContain('Item List');
  }, 30000);

  it('complex multi-step flow: dismiss, type, scroll, screenshot', async () => {
    const input: FetchInput = {
      url: `http://127.0.0.1:${port}/form-page.html`,
      actions: [
        { type: 'wait_for', selector: '#username' },
        { type: 'type', selector: '#username', text: 'admin' },
        { type: 'type', selector: '#password', text: 'pass' },
        { type: 'click', selector: '#submit-btn' },
        { type: 'wait', ms: 300 },
        { type: 'scroll', direction: 'down', amount: 200 },
        { type: 'screenshot' },
      ],
    };

    const result = await handleFetch(input, router);

    expect(result.error).toBeUndefined();
    expect(result.action_results).toHaveLength(7);
    expect(result.action_results!.filter(r => !r.success)).toHaveLength(0);
    expect(result.markdown).toContain('admin');
    const screenshotResults = result.action_results!.filter(r => r.type === 'screenshot');
    expect(screenshotResults).toHaveLength(1);
    expect(screenshotResults[0].screenshot).toBeDefined();
  }, 30000);
});
