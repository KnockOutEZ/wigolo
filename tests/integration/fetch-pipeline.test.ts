import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { httpFetch } from '../../src/fetch/http-client.js';
import { extractContent } from '../../src/extraction/pipeline.js';
import { initDatabase, closeDatabase } from '../../src/cache/db.js';
import { cacheContent, getCachedContent, isExpired } from '../../src/cache/store.js';
import { resetConfig } from '../../src/config.js';
import type { RawFetchResult } from '../../src/types.js';

const FIXTURE_PATH = join(import.meta.dirname, '..', 'fixtures', 'extraction', 'article.html');
const FIXTURE_HTML = readFileSync(FIXTURE_PATH, 'utf-8');

let server: Server;
let baseUrl: string;

function startServer(): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.url === '/article') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(FIXTURE_HTML);
      } else if (req.url === '/not-found') {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<html><body><h1>404 Not Found</h1></body></html>');
      } else {
        res.writeHead(404);
        res.end('Not Found');
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

describe('integration: fetch pipeline', () => {
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
  });

  it('fetches HTML from local server and extracts markdown', async () => {
    const url = `${baseUrl}/article`;
    const result = await httpFetch(url);

    expect(result.statusCode).toBe(200);
    expect(result.html).toContain('Building Modern Web Scrapers');
    expect(result.contentType).toContain('text/html');

    const extraction = await extractContent(result.html, url);

    expect(extraction.title).toContain('Building Modern Web Scrapers');
    expect(extraction.markdown).toBeTruthy();
    expect(extraction.markdown.length).toBeGreaterThan(100);
    expect(extraction.markdown).toContain('TypeScript');
  });

  it('full pipeline: fetch → extract → cache → retrieve', async () => {
    const url = `${baseUrl}/article`;
    const fetchResult = await httpFetch(url);
    const extraction = await extractContent(fetchResult.html, url);

    const raw: RawFetchResult = {
      url: fetchResult.url,
      finalUrl: fetchResult.finalUrl,
      html: fetchResult.html,
      contentType: fetchResult.contentType,
      statusCode: fetchResult.statusCode,
      method: 'http',
      headers: fetchResult.headers,
    };

    cacheContent(raw, extraction);

    const cached = getCachedContent(url);
    expect(cached).not.toBeNull();
    expect(cached!.title).toContain('Building Modern Web Scrapers');
    expect(cached!.markdown).toContain('TypeScript');
    expect(isExpired(cached!)).toBe(false);
  });

  it('second fetch for same URL returns cached content', async () => {
    const url = `${baseUrl}/article`;
    const fetchResult = await httpFetch(url);
    const extraction = await extractContent(fetchResult.html, url);

    const raw: RawFetchResult = {
      url: fetchResult.url,
      finalUrl: fetchResult.finalUrl,
      html: fetchResult.html,
      contentType: fetchResult.contentType,
      statusCode: fetchResult.statusCode,
      method: 'http',
      headers: fetchResult.headers,
    };

    cacheContent(raw, extraction);

    const firstLookup = getCachedContent(url);
    expect(firstLookup).not.toBeNull();

    const secondLookup = getCachedContent(url);
    expect(secondLookup).not.toBeNull();
    expect(secondLookup!.title).toBe(firstLookup!.title);
    expect(secondLookup!.markdown).toBe(firstLookup!.markdown);
    expect(secondLookup!.contentHash).toBe(firstLookup!.contentHash);
  });

  it('extraction produces links from the article', async () => {
    const url = `${baseUrl}/article`;
    const fetchResult = await httpFetch(url);
    const extraction = await extractContent(fetchResult.html, url);

    expect(extraction.links.length).toBeGreaterThan(0);
  });

  it('extraction with section option returns only that section', async () => {
    const url = `${baseUrl}/article`;
    const fetchResult = await httpFetch(url);
    const extraction = await extractContent(fetchResult.html, url, {
      section: 'Conclusion',
    });

    expect(extraction.markdown).toContain('start simple');
    expect(extraction.markdown).not.toContain('Why TypeScript for Web Scraping');
  });

  it('extraction with maxChars truncates output', async () => {
    const url = `${baseUrl}/article`;
    const fetchResult = await httpFetch(url);
    const extraction = await extractContent(fetchResult.html, url, {
      maxChars: 200,
    });

    expect(extraction.markdown.length).toBeLessThanOrEqual(200);
  });

  it('handles 404 response without crashing', async () => {
    const url = `${baseUrl}/not-found`;
    const result = await httpFetch(url);

    expect(result.statusCode).toBe(404);
    expect(result.html).toContain('404');
  });
});
