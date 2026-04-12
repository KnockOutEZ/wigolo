import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { httpFetch } from '../../src/fetch/http-client.js';
import { initDatabase, closeDatabase } from '../../src/cache/db.js';
import { handleExtract } from '../../src/tools/extract.js';
import type { SmartRouter } from '../../src/fetch/router.js';
import type { RawFetchResult } from '../../src/types.js';

const PRODUCT_HTML = readFileSync(
  join(import.meta.dirname, '..', 'fixtures', 'extraction', 'product-page.html'),
  'utf-8',
);

const JOB_HTML = readFileSync(
  join(import.meta.dirname, '..', 'fixtures', 'extraction', 'job-listing.html'),
  'utf-8',
);

const JSONLD_ARTICLE_HTML = readFileSync(
  join(import.meta.dirname, '..', 'fixtures', 'extraction', 'jsonld-article.html'),
  'utf-8',
);

let server: Server;
let baseUrl: string;

function startServer(): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const routes: Record<string, string> = {
        '/product': PRODUCT_HTML,
        '/job': JOB_HTML,
        '/article': JSONLD_ARTICLE_HTML,
      };

      const html = routes[req.url ?? ''];
      if (html) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
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

describe('integration: schema extraction pipeline', () => {
  beforeAll(async () => {
    initDatabase(':memory:');
    baseUrl = await startServer();
  });

  afterAll(() => {
    server.close();
    closeDatabase();
  });

  // --- Product page schema extraction ---

  it('extracts product name and price via schema mode from URL', async () => {
    const result = await handleExtract(
      {
        url: `${baseUrl}/product`,
        mode: 'schema',
        schema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            price: { type: 'string' },
            description: { type: 'string' },
          },
        },
      },
      makeRouter(),
    );

    expect(result.error).toBeUndefined();
    expect(result.mode).toBe('schema');
    expect(result.source_url).toContain('/product');

    const data = result.data as Record<string, unknown>;
    expect(data.name).toBe('Widget Pro');
    expect(data.price).toContain('29.99');
    expect(data.description).toContain('widget');
  });

  it('extracts product features as array via schema mode', async () => {
    const result = await handleExtract(
      {
        url: `${baseUrl}/product`,
        mode: 'schema',
        schema: {
          type: 'object',
          properties: {
            features: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      makeRouter(),
    );

    expect(result.error).toBeUndefined();
    const data = result.data as Record<string, unknown>;
    expect(data.features).toEqual(expect.arrayContaining(['Lightweight', 'Durable', 'Waterproof']));
  });

  // --- Job listing schema extraction ---

  it('extracts job title and company from job listing via schema mode', async () => {
    const result = await handleExtract(
      {
        url: `${baseUrl}/job`,
        mode: 'schema',
        schema: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            description: { type: 'string' },
            employmentType: { type: 'string' },
          },
        },
      },
      makeRouter(),
    );

    expect(result.error).toBeUndefined();
    const data = result.data as Record<string, unknown>;
    expect(data.title).toBe('Senior TypeScript Developer');
    expect(data.employmentType).toBe('FULL_TIME');
    expect(data.description).toContain('TypeScript developer');
  });

  it('extracts job requirements as array', async () => {
    const result = await handleExtract(
      {
        url: `${baseUrl}/job`,
        mode: 'schema',
        schema: {
          type: 'object',
          properties: {
            requirements: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      makeRouter(),
    );

    expect(result.error).toBeUndefined();
    const data = result.data as Record<string, unknown>;
    const reqs = data.requirements as string[];
    expect(reqs).toHaveLength(3);
    expect(reqs[0]).toContain('TypeScript');
  });

  // --- JSON-LD enriched metadata ---

  it('metadata mode includes JSON-LD from article page', async () => {
    const result = await handleExtract(
      { url: `${baseUrl}/article`, mode: 'metadata' },
      makeRouter(),
    );

    expect(result.error).toBeUndefined();
    expect(result.mode).toBe('metadata');

    const data = result.data as Record<string, unknown>;
    const jsonld = data.jsonld as Record<string, unknown>[];
    expect(jsonld).toHaveLength(1);
    expect(jsonld[0]['@type']).toBe('Article');
    expect(jsonld[0].headline).toBe('Understanding TypeScript Generics');
  });

  it('metadata mode includes JSON-LD from product page', async () => {
    const result = await handleExtract(
      { url: `${baseUrl}/product`, mode: 'metadata' },
      makeRouter(),
    );

    expect(result.error).toBeUndefined();
    const data = result.data as Record<string, unknown>;
    const jsonld = data.jsonld as Record<string, unknown>[];
    expect(jsonld).toHaveLength(1);
    expect(jsonld[0]['@type']).toBe('Product');
  });

  // --- Direct HTML (no URL fetch) ---

  it('works with direct HTML in schema mode', async () => {
    const result = await handleExtract(
      {
        html: PRODUCT_HTML,
        mode: 'schema',
        schema: {
          type: 'object',
          properties: { name: { type: 'string' } },
        },
      },
      makeRouter(),
    );

    expect(result.error).toBeUndefined();
    expect(result.source_url).toBeUndefined();
    expect((result.data as any).name).toBe('Widget Pro');
  });

  // --- Error handling ---

  it('returns validation error for schema mode without schema', async () => {
    const result = await handleExtract(
      { html: '<p>test</p>', mode: 'schema' },
      makeRouter(),
    );

    expect(result.error).toBeDefined();
    expect(result.mode).toBe('schema');
  });

  it('handles 404 URL gracefully in schema mode', async () => {
    const result = await handleExtract(
      {
        url: `${baseUrl}/nonexistent`,
        mode: 'schema',
        schema: {
          type: 'object',
          properties: { title: { type: 'string' } },
        },
      },
      makeRouter(),
    );

    expect(result.mode).toBe('schema');
    expect(result.error).toBeUndefined();
    // 404 HTML has no schema.org markup — schema extraction returns empty result
    const data = result.data as Record<string, unknown>;
    expect(data).toBeDefined();
  });

  // --- Cross-mode verification ---

  it('schema mode and metadata mode return consistent data for same URL', async () => {
    const metadataResult = await handleExtract(
      { url: `${baseUrl}/product`, mode: 'metadata' },
      makeRouter(),
    );

    const schemaResult = await handleExtract(
      {
        url: `${baseUrl}/product`,
        mode: 'schema',
        schema: {
          type: 'object',
          properties: { name: { type: 'string' } },
        },
      },
      makeRouter(),
    );

    const metaData = metadataResult.data as Record<string, unknown>;
    const jsonld = metaData.jsonld as Record<string, unknown>[];
    const schemaData = schemaResult.data as Record<string, unknown>;

    expect(jsonld[0].name).toBe(schemaData.name);
  });
});
