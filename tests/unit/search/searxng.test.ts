import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { SearxngClient } from '../../../src/search/searxng.js';
import { resetConfig } from '../../../src/config.js';

const fixture = JSON.parse(
  readFileSync('tests/fixtures/search/searxng-response.json', 'utf-8'),
);

describe('SearxngClient', () => {
  let server: Server;
  let port: number;
  const originalEnv = process.env;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url!, `http://localhost`);
      if (url.pathname === '/search' && url.searchParams.get('format') === 'json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(fixture));
      } else if (url.pathname === '/error') {
        res.writeHead(500);
        res.end();
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>(resolve => {
      server.listen(0, () => {
        port = (server.address() as { port: number }).port;
        resolve();
      });
    });
  });

  afterAll(() => server.close());
  beforeEach(() => { process.env = { ...originalEnv }; resetConfig(); });
  afterEach(() => { process.env = originalEnv; resetConfig(); });

  it('returns normalized results from SearXNG JSON API', async () => {
    const client = new SearxngClient(`http://127.0.0.1:${port}`);
    const results = await client.search('typescript tutorial');
    expect(results).toHaveLength(3);
    expect(results[0].title).toBe('TypeScript: Handbook');
    expect(results[0].engine).toBe('searxng');
    expect(results[0].relevance_score).toBe(0.95);
  });

  it('assigns position-based scores when SearXNG score is null', async () => {
    const client = new SearxngClient(`http://127.0.0.1:${port}`);
    const results = await client.search('typescript tutorial');
    expect(results[2].relevance_score).toBeGreaterThan(0);
    expect(results[2].relevance_score).toBeLessThan(1);
  });

  it('respects maxResults option', async () => {
    const client = new SearxngClient(`http://127.0.0.1:${port}`);
    const results = await client.search('typescript tutorial', { maxResults: 2 });
    expect(results).toHaveLength(2);
  });

  it('throws on non-200 response', async () => {
    const client = new SearxngClient(`http://127.0.0.1:${port}/error`);
    await expect(client.search('test')).rejects.toThrow();
  });

  it('has name property set to searxng', () => {
    const client = new SearxngClient('http://localhost:8888');
    expect(client.name).toBe('searxng');
  });

  it('propagates publishedDate when SearXNG response includes it', async () => {
    const client = new SearxngClient(`http://127.0.0.1:${port}`);
    const results = await client.search('typescript tutorial');
    const dated = results.find(r => r.url === 'https://www.learn-ts.org/');
    expect(dated?.published_date).toBe('2026-04-01T00:00:00Z');
    const undated = results.find(r => r.title === 'TypeScript: Handbook');
    expect(undated?.published_date).toBeUndefined();
  });
});
