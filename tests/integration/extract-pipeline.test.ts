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
    const __r_result = await handleExtract(
      { url: `${baseUrl}/metadata`, mode: 'metadata' },
      makeRouter(),
    );;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

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
    const __r_result = await handleExtract(
      { url: `${baseUrl}/tables`, mode: 'tables' },
      makeRouter(),
    );;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

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
    const __r_result = await handleExtract(
      { url: `${baseUrl}/metadata`, mode: 'selector', css_selector: 'h1' },
      makeRouter(),
    );;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.error).toBeUndefined();
    expect(result.mode).toBe('selector');
    expect(result.data).toBe('Understanding TypeScript Generics');
  });

  it('extracts multiple selector matches from a URL', async () => {
    const __r_result = await handleExtract(
      {
        url: `${baseUrl}/metadata`,
        mode: 'selector',
        css_selector: '.tag',
        multiple: true,
      },
      makeRouter(),
    );;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.error).toBeUndefined();
    expect(result.data).toEqual(['typescript', 'generics', 'tutorial']);
  });

  it('works with direct HTML (no URL fetch)', async () => {
    const __r_result = await handleExtract(
      { html: METADATA_HTML, mode: 'metadata' },
      makeRouter(),
    );;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.error).toBeUndefined();
    expect(result.source_url).toBeUndefined();
    const data = result.data as Record<string, unknown>;
    expect(data.title).toBe('Understanding TypeScript Generics');
  });

  it('trims tables to a tight max_tokens_out at the tool boundary and signals the clip', async () => {
    const result = await handleExtract(
      { url: `${baseUrl}/tables`, mode: 'tables', max_tokens_out: 60 },
      makeRouter(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.mode).toBe('tables');
    // Proportional degradation: structure survives with headers, the clip is
    // signaled, and a human-readable warning names the drop — never silent [].
    expect(result.data.truncated).toBe(true);
    expect(Array.isArray(result.data.warnings)).toBe(true);
    expect((result.data.warnings ?? []).join(' ')).toMatch(/trimmed to fit max_tokens_out/i);
    const tables = result.data.data as Array<{ headers: string[]; rows: unknown[] }>;
    if (tables.length > 0) {
      expect(tables[0].headers.length).toBeGreaterThan(0);
    }
  });

  it('leaves tables untouched when max_tokens_out fits everything', async () => {
    const result = await handleExtract(
      { url: `${baseUrl}/tables`, mode: 'tables', max_tokens_out: 100000 },
      makeRouter(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.truncated).toBeUndefined();
    expect(result.data.warnings).toBeUndefined();
  });

  it('handles 404 URL gracefully', async () => {
    const __r_result = await handleExtract(
      { url: `${baseUrl}/nonexistent`, mode: 'metadata' },
      makeRouter(),
    );;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.mode).toBe('metadata');
    const data = result.data as Record<string, unknown>;
    expect(data.title).toBe('Not Found');
  });
});
