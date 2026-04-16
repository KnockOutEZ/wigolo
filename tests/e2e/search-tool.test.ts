import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { handleSearch } from '../../src/tools/search.js';
import type { SearchEngine } from '../../src/types.js';
import { initDatabase, closeDatabase } from '../../src/cache/db.js';
import { resetConfig } from '../../src/config.js';

describe('search tool E2E', () => {
  let contentServer: Server;
  let contentPort: number;
  const originalEnv = process.env;

  beforeAll(async () => {
    const reactHtml = [
      '<html><head><title>React Tutorial</title></head><body>',
      '<h1>Learn React</h1>',
      '<p>React is a JavaScript library for building user interfaces. It lets you compose complex UIs from small, isolated pieces of code called components.</p>',
      '<p>Components accept arbitrary inputs called props and return React elements describing what should appear on the screen. You can build reusable pieces of UI that manage their own state.</p>',
      '</body></html>',
    ].join('');

    const tsHtml = [
      '<html><head><title>TypeScript Handbook</title></head><body>',
      '<h1>TypeScript</h1>',
      '<p>TypeScript is a strongly typed programming language that builds on JavaScript, giving you better tooling at any scale.</p>',
      '<p>TypeScript adds optional static typing, classes, and modules to JavaScript. It supports tools for large-scale JavaScript applications for any browser, host, or operating system.</p>',
      '</body></html>',
    ].join('');

    contentServer = createServer((req, res) => {
      if (req.url === '/react') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(reactHtml);
      } else if (req.url === '/typescript') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(tsHtml);
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><p>Generic content</p></body></html>');
      }
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
    process.env = { ...originalEnv, VALIDATE_LINKS: 'false' };
    resetConfig();
    initDatabase(':memory:');
  });

  afterEach(() => {
    closeDatabase();
    process.env = originalEnv;
    resetConfig();
  });

  function makeEngine(port: number): SearchEngine {
    return {
      name: 'e2e-mock',
      search: async () => [
        { title: 'React Tutorial', url: `http://127.0.0.1:${port}/react`, snippet: 'Learn React', relevance_score: 0.95, engine: 'e2e-mock' },
        { title: 'TypeScript Handbook', url: `http://127.0.0.1:${port}/typescript`, snippet: 'Learn TypeScript', relevance_score: 0.85, engine: 'e2e-mock' },
      ],
    };
  }

  async function makeRouter() {
    const { httpFetch } = await import('../../src/fetch/http-client.js');
    const { SmartRouter } = await import('../../src/fetch/router.js');
    return new SmartRouter(
      { fetch: (url: string, opts?: any) => httpFetch(url, opts) },
      { fetchWithBrowser: async () => { throw new Error('no browser in E2E'); } },
    );
  }

  it('search with include_content=true returns markdown', async () => {
    const router = await makeRouter();
    const output = await handleSearch(
      { query: 'react tutorial', max_results: 2 },
      [makeEngine(contentPort)],
      router,
    );

    expect(output.query).toBe('react tutorial');
    expect(output.results).toHaveLength(2);
    expect(output.results[0].title).toBe('React Tutorial');
    expect(output.results[0].markdown_content).toContain('React');
    expect(output.results[0].relevance_score).toBeGreaterThan(0);
    expect(output.results[1].markdown_content).toContain('TypeScript');
  });

  it('search with include_content=false returns only snippets', async () => {
    const router = await makeRouter();
    const output = await handleSearch(
      { query: 'test', include_content: false },
      [makeEngine(contentPort)],
      router,
    );

    expect(output.results[0].markdown_content).toBeUndefined();
    expect(output.results[0].snippet).toBeDefined();
  });

  it('results are cached and served on repeat query', async () => {
    const router = await makeRouter();
    const engine = makeEngine(contentPort);

    await handleSearch({ query: 'cached query', include_content: false }, [engine], router);
    const output = await handleSearch({ query: 'cached query', include_content: false }, [engine], router);

    expect(output.results.length).toBeGreaterThan(0);
  });

  it('max_total_chars budget is enforced', async () => {
    const router = await makeRouter();
    const output = await handleSearch(
      { query: 'test', max_results: 2, max_total_chars: 50 },
      [makeEngine(contentPort)],
      router,
    );

    const totalChars = output.results.reduce((s, r) => s + (r.markdown_content?.length ?? 0), 0);
    expect(totalChars).toBeLessThanOrEqual(50);
  });

  it('partial results on individual fetch failure', async () => {
    const engine: SearchEngine = {
      name: 'mixed',
      search: async () => [
        { title: 'Good', url: `http://127.0.0.1:${contentPort}/react`, snippet: 'OK', relevance_score: 0.9, engine: 'mixed' },
        { title: 'Bad', url: 'http://127.0.0.1:1/nonexistent', snippet: 'Fail', relevance_score: 0.5, engine: 'mixed' },
      ],
    };

    const router = await makeRouter();
    const output = await handleSearch({ query: 'test', max_results: 2 }, [engine], router);

    expect(output.results).toHaveLength(2);
    const good = output.results.find(r => r.title === 'Good');
    const bad = output.results.find(r => r.title === 'Bad');
    expect(good?.markdown_content).toBeDefined();
    expect(bad?.fetch_failed).toBeDefined();
  });
});
