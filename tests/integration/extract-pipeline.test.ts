import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { httpFetch } from '../../src/fetch/http-client.js';
import { initDatabase, closeDatabase } from '../../src/cache/db.js';
import { handleExtract } from '../../src/tools/extract.js';
import type { SmartRouter } from '../../src/fetch/router.js';
import type { RawFetchResult } from '../../src/types.js';

const METADATA_HTML = readFileSync(
  join(import.meta.dirname, '..', 'fixtures', 'extraction', 'metadata.html'),
  'utf-8',
);
const TABLES_HTML = readFileSync(
  join(import.meta.dirname, '..', 'fixtures', 'extraction', 'tables.html'),
  'utf-8',
);

let server: Server;
let baseUrl: string;

function startServer(): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.url === '/metadata') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(METADATA_HTML);
      } else if (req.url === '/tables') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(TABLES_HTML);
      } else {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<html><head><title>Not Found</title></head><body>Not Found</body></html>');
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

function makeRouter(): SmartRouter {
  return {
    fetch: async (url: string): Promise<RawFetchResult> => {
      return httpFetch(url, {});
    },
    getDomainStats: () => undefined,
  } as unknown as SmartRouter;
}

describe('integration: extract pipeline', () => {
  beforeAll(async () => {
    initDatabase(':memory:');
    baseUrl = await startServer();
  });

  afterAll(() => {
    server.close();
    closeDatabase();
  });

  it('extracts metadata from a URL', async () => {
    const result = await handleExtract(
      { url: `${baseUrl}/metadata`, mode: 'metadata' },
      makeRouter(),
    );

    expect(result.error).toBeUndefined();
    expect(result.mode).toBe('metadata');
    expect(result.source_url).toContain('/metadata');

    const data = result.data as Record<string, unknown>;
    expect(data.title).toBe('Understanding TypeScript Generics');
    expect(data.description).toBe(
      'A comprehensive guide to TypeScript generics with practical examples.',
    );
    expect(data.author).toBe('Jane Smith');
    expect(data.date).toBe('2025-08-15');
    expect(data.keywords).toEqual(['typescript', 'generics', 'programming', 'tutorial']);
    expect(data.og_image).toBe('https://example.com/images/ts-generics.png');
  });

  it('extracts tables from a URL', async () => {
    const result = await handleExtract(
      { url: `${baseUrl}/tables`, mode: 'tables' },
      makeRouter(),
    );

    expect(result.error).toBeUndefined();
    expect(result.mode).toBe('tables');

    const tables = result.data as Array<{
      headers: string[];
      rows: Array<Record<string, string>>;
    }>;
    expect(tables.length).toBeGreaterThanOrEqual(2);
    expect(tables[0].headers).toContain('Quarter');
    expect(tables[0].rows[0]).toHaveProperty('Revenue');
  });

  it('extracts by CSS selector from a URL', async () => {
    const result = await handleExtract(
      { url: `${baseUrl}/metadata`, mode: 'selector', css_selector: 'h1' },
      makeRouter(),
    );

    expect(result.error).toBeUndefined();
    expect(result.mode).toBe('selector');
    expect(result.data).toBe('Understanding TypeScript Generics');
  });

  it('extracts multiple selector matches from a URL', async () => {
    const result = await handleExtract(
      {
        url: `${baseUrl}/metadata`,
        mode: 'selector',
        css_selector: '.tag',
        multiple: true,
      },
      makeRouter(),
    );

    expect(result.error).toBeUndefined();
    expect(result.data).toEqual(['typescript', 'generics', 'tutorial']);
  });

  it('works with direct HTML (no URL fetch)', async () => {
    const result = await handleExtract(
      { html: METADATA_HTML, mode: 'metadata' },
      makeRouter(),
    );

    expect(result.error).toBeUndefined();
    expect(result.source_url).toBeUndefined();
    const data = result.data as Record<string, unknown>;
    expect(data.title).toBe('Understanding TypeScript Generics');
  });

  it('handles 404 URL gracefully', async () => {
    const result = await handleExtract(
      { url: `${baseUrl}/nonexistent`, mode: 'metadata' },
      makeRouter(),
    );

    expect(result.mode).toBe('metadata');
    const data = result.data as Record<string, unknown>;
    expect(data.title).toBe('Not Found');
  });
});
