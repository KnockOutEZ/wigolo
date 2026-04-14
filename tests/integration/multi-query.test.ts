import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import { handleSearch } from '../../src/tools/search.js';
import type { SearchInput, SearchEngine, RawSearchResult } from '../../src/types.js';
import type { SmartRouter } from '../../src/fetch/router.js';
import { initDatabase, closeDatabase } from '../../src/cache/db.js';
import { resetConfig } from '../../src/config.js';

vi.mock('../../src/extraction/pipeline.js', () => ({
  extractContent: vi.fn().mockResolvedValue({
    title: 'Integration Test',
    markdown: '# Integration\n\nTest content.',
    metadata: {},
    links: [],
    images: [],
    extractor: 'defuddle' as const,
  }),
}));

describe('Multi-query integration', () => {
  const originalEnv = process.env;
  let testServer: http.Server;
  let serverPort: number;

  beforeAll(async () => {
    process.env = { ...originalEnv, VALIDATE_LINKS: 'false' };
    resetConfig();
    initDatabase(':memory:');

    testServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body><h1>Test Page</h1><p>Content for integration test.</p></body></html>');
    });

    await new Promise<void>((resolve) => {
      testServer.listen(0, '127.0.0.1', () => resolve());
    });

    serverPort = (testServer.address() as { port: number }).port;
  });

  afterAll(async () => {
    closeDatabase();
    process.env = originalEnv;
    resetConfig();
    await new Promise<void>((resolve) => testServer.close(() => resolve()));
  });

  function makeEngine(resultsByQuery: Record<string, RawSearchResult[]>): SearchEngine {
    return {
      name: 'integration-mock',
      search: vi.fn().mockImplementation(async (query: string) => {
        return resultsByQuery[query] ?? [];
      }),
    };
  }

  const mockRouter = {
    fetch: vi.fn().mockImplementation(async (url: string) => ({
      url,
      finalUrl: url,
      html: '<html><body><h1>Fetched</h1><p>Real content</p></body></html>',
      contentType: 'text/html',
      statusCode: 200,
      method: 'http' as const,
      headers: {},
    })),
  } as unknown as SmartRouter;

  it('end-to-end: multi-query with content fetch and dedup', async () => {
    const engine = makeEngine({
      'react hooks': [
        { title: 'React Hooks Guide', url: `http://127.0.0.1:${serverPort}/react`, snippet: 'Learn hooks', relevance_score: 0.95, engine: 'integration-mock' },
        { title: 'Shared Page', url: `http://127.0.0.1:${serverPort}/shared`, snippet: 'Shared', relevance_score: 0.8, engine: 'integration-mock' },
      ],
      'vue composition api': [
        { title: 'Vue Composition', url: `http://127.0.0.1:${serverPort}/vue`, snippet: 'Composition API', relevance_score: 0.9, engine: 'integration-mock' },
        { title: 'Shared Page', url: `http://127.0.0.1:${serverPort}/shared`, snippet: 'Also shared', relevance_score: 0.85, engine: 'integration-mock' },
      ],
    });

    const input: SearchInput = {
      query: ['React Hooks', 'Vue Composition API'],
      max_results: 5,
      include_content: true,
    };

    const output = await handleSearch(input, [engine], mockRouter);

    expect(output.queries_executed).toEqual(['react hooks', 'vue composition api']);

    const urls = output.results.map(r => r.url);
    expect(urls.filter(u => u.includes('/shared')).length).toBe(1);

    expect(output.results.some(r => r.markdown_content)).toBe(true);
    expect(output.total_time_ms).toBeGreaterThanOrEqual(0);
  });

  it('end-to-end: single string query backward compat', async () => {
    const engine = makeEngine({
      'simple test': [
        { title: 'Simple', url: `http://127.0.0.1:${serverPort}/simple`, snippet: 'Simple result', relevance_score: 0.9, engine: 'integration-mock' },
      ],
    });

    const input: SearchInput = {
      query: 'simple test',
      include_content: false,
    };

    const output = await handleSearch(input, [engine], mockRouter);

    expect(output.queries_executed).toBeUndefined();
    expect(output.query).toBe('simple test');
    expect(output.results.length).toBeGreaterThan(0);
  });

  it('end-to-end: multi-query with context format', async () => {
    const engine = makeEngine({
      'typescript generics': [
        { title: 'TS Generics', url: `http://127.0.0.1:${serverPort}/ts-gen`, snippet: 'Generics guide', relevance_score: 0.95, engine: 'integration-mock' },
      ],
      'rust generics': [
        { title: 'Rust Generics', url: `http://127.0.0.1:${serverPort}/rs-gen`, snippet: 'Rust guide', relevance_score: 0.9, engine: 'integration-mock' },
      ],
    });

    const input: SearchInput = {
      query: ['TypeScript Generics', 'Rust Generics'],
      format: 'context',
      include_content: false,
    };

    const output = await handleSearch(input, [engine], mockRouter);

    expect(output.context_text).toBeDefined();
    expect(output.context_text!.length).toBeGreaterThan(0);
    expect(output.queries_executed).toEqual(['typescript generics', 'rust generics']);
  });

  it('end-to-end: multi-query with max exceeded', async () => {
    process.env.WIGOLO_MULTI_QUERY_MAX = '2';
    resetConfig();

    const engine = makeEngine({
      'q1': [{ title: 'R1', url: `http://127.0.0.1:${serverPort}/1`, snippet: 's1', relevance_score: 0.9, engine: 'integration-mock' }],
      'q2': [{ title: 'R2', url: `http://127.0.0.1:${serverPort}/2`, snippet: 's2', relevance_score: 0.8, engine: 'integration-mock' }],
      'q3': [{ title: 'R3', url: `http://127.0.0.1:${serverPort}/3`, snippet: 's3', relevance_score: 0.7, engine: 'integration-mock' }],
    });

    const input: SearchInput = {
      query: ['q1', 'q2', 'q3'],
      include_content: false,
    };

    const output = await handleSearch(input, [engine], mockRouter);

    expect(output.queries_executed!.length).toBeLessThanOrEqual(2);

    process.env.WIGOLO_MULTI_QUERY_MAX = undefined;
    resetConfig();
  });
});
