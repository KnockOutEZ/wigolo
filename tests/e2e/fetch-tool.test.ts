import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { handleFetch } from '../../src/tools/fetch.js';
import { SmartRouter, type HttpClient } from '../../src/fetch/router.js';
import { httpFetch } from '../../src/fetch/http-client.js';
import { initDatabase, closeDatabase } from '../../src/cache/db.js';
import { resetConfig } from '../../src/config.js';

const FIXTURE_PATH = join(import.meta.dirname, '..', 'fixtures', 'extraction', 'article.html');
const FIXTURE_HTML = readFileSync(FIXTURE_PATH, 'utf-8');

let server: Server;
let baseUrl: string;
let router: SmartRouter;

function startServer(): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.url === '/article') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(FIXTURE_HTML);
      } else if (req.url === '/empty') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body></body></html>');
      } else {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<html><body><h1>Not Found</h1></body></html>');
      }
    });

    server.listen(0, () => {
      const addr = server.address();
      if (typeof addr === 'object' && addr) {
        resolve(`http://localhost:${addr.port}`);
      }
    });
  });
}

function createRouter(): SmartRouter {
  const httpClient: HttpClient = {
    fetch: (url, options) => httpFetch(url, options),
  };

  const mockBrowserPool = {
    fetchWithBrowser: async () => {
      throw new Error('Browser not needed');
    },
  };

  return new SmartRouter(httpClient, mockBrowserPool);
}

describe('e2e: fetch tool', () => {
  beforeAll(async () => {
    baseUrl = await startServer();
  });

  afterAll(() => {
    closeDatabase();
    server.close();
  });

  beforeEach(() => {
    resetConfig();
    initDatabase(':memory:');
    router = createRouter();
  });

  it('full fetch returns title, markdown, metadata, and links', async () => {
    const result = await handleFetch({ url: `${baseUrl}/article` }, router);

    expect(result.error).toBeUndefined();
    expect(result.cached).toBe(false);
    expect(result.title).toContain('Building Modern Web Scrapers');
    expect(result.markdown).toBeTruthy();
    expect(result.markdown.length).toBeGreaterThan(100);
    expect(result.markdown).toContain('TypeScript');
    expect(result.url).toContain('/article');
    expect(result.links).toBeInstanceOf(Array);
  });

  it('second fetch returns cached: true', async () => {
    const url = `${baseUrl}/article`;
    const first = await handleFetch({ url }, router);
    expect(first.cached).toBe(false);
    expect(first.error).toBeUndefined();

    const second = await handleFetch({ url }, router);
    expect(second.cached).toBe(true);
    expect(second.title).toBe(first.title);
    expect(second.markdown).toContain('TypeScript');
  });

  it('section extraction returns only the requested section', async () => {
    const result = await handleFetch(
      { url: `${baseUrl}/article`, section: 'Conclusion' },
      router,
    );

    expect(result.error).toBeUndefined();
    expect(result.markdown).toContain('start simple');
    expect(result.markdown).not.toContain('Why TypeScript for Web Scraping');
  });

  it('section extraction from cache returns only the requested section', async () => {
    const url = `${baseUrl}/article`;
    await handleFetch({ url }, router);

    const result = await handleFetch({ url, section: 'Conclusion' }, router);

    expect(result.cached).toBe(true);
    expect(result.markdown).toContain('start simple');
  });

  it('max_chars limits markdown length', async () => {
    const result = await handleFetch(
      { url: `${baseUrl}/article`, max_chars: 150 },
      router,
    );

    expect(result.error).toBeUndefined();
    expect(result.markdown.length).toBeLessThanOrEqual(150);
  });

  it('non-existent URL returns error response without throwing', async () => {
    const result = await handleFetch(
      { url: 'http://localhost:1/nonexistent' },
      router,
    );

    expect(result.error).toBeDefined();
    expect(result.markdown).toBe('');
    expect(result.cached).toBe(false);
    expect(result.links).toEqual([]);
    expect(result.images).toEqual([]);
  });

  it('invalid URL returns error response without throwing', async () => {
    const result = await handleFetch(
      { url: 'not-a-valid-url' },
      router,
    );

    expect(result.error).toBeDefined();
    expect(result.cached).toBe(false);
  });

  it('render_js=never skips browser fallback', async () => {
    const result = await handleFetch(
      { url: `${baseUrl}/article`, render_js: 'never' },
      router,
    );

    expect(result.error).toBeUndefined();
    expect(result.title).toContain('Building Modern Web Scrapers');
  });

  it('metadata includes extracted description', async () => {
    const result = await handleFetch({ url: `${baseUrl}/article` }, router);

    expect(result.metadata).toBeDefined();
  });
});
