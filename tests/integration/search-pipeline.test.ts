import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { handleSearch } from '../../src/tools/search.js';
import type { SearchEngine, RawSearchResult } from '../../src/types.js';
import { initDatabase, closeDatabase } from '../../src/cache/db.js';
import { resetConfig } from '../../src/config.js';

describe('search pipeline integration', () => {
  let contentServer: Server;
  let contentPort: number;
  const originalEnv = process.env;

  beforeAll(async () => {
    contentServer = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      const filler = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.';
      res.end(`<html><head><title>Test Page</title></head><body><h1>Hello</h1><p>Test content for ${req.url}</p><p>${filler}</p><p>${filler}</p></body></html>`);
    });
    await new Promise<void>(resolve => {
      contentServer.listen(0, () => {
        contentPort = (contentServer.address() as { port: number }).port;
        resolve();
      });
    });
  });

  afterAll(() => contentServer.close());

  beforeEach(() => {
    // Pin reranker off so dedup score assertions are not rewritten by FlashRank
    // (the default reranker is now 'flashrank' when the model is available).
    process.env = { ...originalEnv, VALIDATE_LINKS: 'false', WIGOLO_RERANKER: 'none' };
    resetConfig();
    initDatabase(':memory:');
  });

  afterEach(() => {
    closeDatabase();
    process.env = originalEnv;
    resetConfig();
  });

  it('full pipeline: engines → dedup → fetch content → return', async () => {
    const engine: SearchEngine = {
      name: 'test-engine',
      search: async () => [
        { title: 'Test', url: `http://127.0.0.1:${contentPort}/page1`, snippet: 'A test page', relevance_score: 0.9, engine: 'test-engine' },
        { title: 'Test 2', url: `http://127.0.0.1:${contentPort}/page2`, snippet: 'Another page', relevance_score: 0.7, engine: 'test-engine' },
      ],
    };

    const { httpFetch } = await import('../../src/fetch/http-client.js');
    const { SmartRouter } = await import('../../src/fetch/router.js');
    const mockBrowserPool = {
      fetchWithBrowser: async () => { throw new Error('not implemented'); },
    };
    const httpClient = { fetch: (url: string, opts?: any) => httpFetch(url, opts) };
    const router = new SmartRouter(httpClient, mockBrowserPool);

    const output = await handleSearch(
      { query: 'test', max_results: 2, include_content: true },
      [engine],
      router,
    );

    expect(output.results).toHaveLength(2);
    expect(output.results[0].markdown_content).toBeDefined();
    expect(output.results[0].markdown_content).toContain('Hello');
    expect(output.engines_used).toContain('test-engine');
    expect(output.total_time_ms).toBeGreaterThan(0);
  });

  it('deduplicates across engines', async () => {
    const engine1: SearchEngine = {
      name: 'e1',
      search: async () => [
        { title: 'Same Page', url: `http://127.0.0.1:${contentPort}/shared`, snippet: 'From engine 1', relevance_score: 0.8, engine: 'e1' },
      ],
    };
    const engine2: SearchEngine = {
      name: 'e2',
      search: async () => [
        { title: 'Same Page', url: `http://127.0.0.1:${contentPort}/shared`, snippet: 'From engine 2', relevance_score: 0.6, engine: 'e2' },
      ],
    };

    const { httpFetch } = await import('../../src/fetch/http-client.js');
    const { SmartRouter } = await import('../../src/fetch/router.js');
    const router = new SmartRouter(
      { fetch: (url: string, opts?: any) => httpFetch(url, opts) },
      { fetchWithBrowser: async () => { throw new Error('not implemented'); } },
    );

    const output = await handleSearch(
      { query: 'test', include_content: false },
      [engine1, engine2],
      router,
    );

    expect(output.results).toHaveLength(1);
    expect(output.results[0].relevance_score).toBe(0.8);
  });

  it('handles engine failure gracefully', async () => {
    const failEngine: SearchEngine = {
      name: 'failing',
      search: async () => { throw new Error('engine down'); },
    };
    const goodEngine: SearchEngine = {
      name: 'good',
      search: async () => [
        { title: 'OK', url: `http://127.0.0.1:${contentPort}/ok`, snippet: 'Works', relevance_score: 0.9, engine: 'good' },
      ],
    };

    const { httpFetch } = await import('../../src/fetch/http-client.js');
    const { SmartRouter } = await import('../../src/fetch/router.js');
    const router = new SmartRouter(
      { fetch: (url: string, opts?: any) => httpFetch(url, opts) },
      { fetchWithBrowser: async () => { throw new Error('not implemented'); } },
    );

    const output = await handleSearch(
      { query: 'test', include_content: false },
      [failEngine, goodEngine],
      router,
    );

    expect(output.results).toHaveLength(1);
    expect(output.results[0].title).toBe('OK');
  });
});
