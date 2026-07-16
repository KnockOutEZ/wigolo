import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import { DaemonHttpServer } from '../../src/daemon/http-server.js';

/**
 * WHY: T2 fills the 8 remaining REST dispatch routes (crawl/cache/extract/
 * find_similar/research/agent/diff/watch). These rows pin, at the HTTP
 * boundary, that (a) each route's documented top-level fields reach the JSON
 * response and (b) the SSRF + clamp negatives map to the right status codes.
 * A regression in a dispatch fn, the shape adapters, or the target-guard wiring
 * fails loudly here rather than silently degrading the self-host contract.
 */

interface Resp {
  status: number;
  body: unknown;
  headers: http.IncomingHttpHeaders;
}

function request(opts: {
  port: number;
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: opts.port,
        method: opts.method ?? 'GET',
        path: opts.path,
        headers: { Connection: 'close', ...(opts.headers ?? {}) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          let body: unknown = text;
          try { body = JSON.parse(text); } catch { /* leave as text */ }
          resolve({ status: res.statusCode ?? 0, body, headers: res.headers });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.setTimeout(opts.timeoutMs ?? 20000, () => req.destroy(new Error('request timeout')));
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

function post(port: number, path: string, body: unknown, headers: Record<string, string> = {}, timeoutMs?: number): Promise<Resp> {
  return request({ port, method: 'POST', path, body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...headers }, timeoutMs });
}

// Deterministic local origin: a page that links to two same-host paths so
// crawl/map/find-similar have real content without hitting the live web.
let originServer: http.Server;
let originPort: number;

beforeAll(async () => {
  delete process.env.WIGOLO_API_TOKEN;
  delete process.env.WIGOLO_API_TOKEN_FILE;
  originServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    const p = req.url ?? '/';
    if (p === '/') {
      res.end('<html><head><title>Origin Home</title></head><body><h1>Origin</h1><p>Deterministic content for REST tools tests.</p><a href="/a">A</a> <a href="/b">B</a></body></html>');
    } else {
      res.end(`<html><head><title>Page ${p}</title></head><body><h1>Page ${p}</h1><p>Some body text for page ${p} with enough words to extract.</p></body></html>`);
    }
  });
  await new Promise<void>((r) => originServer.listen(0, '127.0.0.1', () => r()));
  originPort = (originServer.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((r) => originServer.close(() => r()));
});

describe('REST tools — loopback happy paths (documented top-level fields)', () => {
  let daemon: DaemonHttpServer;
  let port: number;

  beforeAll(async () => {
    delete process.env.WIGOLO_API_TOKEN;
    delete process.env.WIGOLO_API_TOKEN_FILE;
    daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1', apiToken: null });
    const url = await daemon.start();
    port = parseInt(new URL(url).port, 10);
  }, 30000);

  afterAll(async () => { await daemon.stop(); }, 30000);

  it('crawl → 200 with pages[]', async () => {
    const r = await post(port, '/v1/crawl', { url: `http://127.0.0.1:${originPort}/`, max_pages: 3, max_depth: 1 }, {}, 60000);
    expect(r.status).toBe(200);
    const body = r.body as Record<string, unknown>;
    expect(body.error).toBeUndefined();
    expect(Array.isArray(body.pages)).toBe(true);
  }, 60000);

  it('cache → 200 with results[] (stats query)', async () => {
    const r = await post(port, '/v1/cache', { stats: true });
    expect(r.status).toBe(200);
    const body = r.body as Record<string, unknown>;
    // stats query returns a stats object; a query returns results[]. Both are
    // the documented cache envelope — assert we got a structured object back.
    expect(body.error).toBeUndefined();
    expect('stats' in body || 'results' in body || 'cleared' in body).toBe(true);
  });

  it('cache (query) → 200 with results[]', async () => {
    const r = await post(port, '/v1/cache', { query: 'origin' });
    expect(r.status).toBe(200);
    const body = r.body as Record<string, unknown>;
    expect('results' in body).toBe(true);
    expect(Array.isArray((body as { results?: unknown }).results)).toBe(true);
  });

  it('extract → 200 with data + warnings surface', async () => {
    const r = await post(port, '/v1/extract', { url: `http://127.0.0.1:${originPort}/`, mode: 'metadata' }, {}, 40000);
    expect(r.status).toBe(200);
    const body = r.body as Record<string, unknown>;
    expect('data' in body).toBe(true);
    expect(body.mode).toBe('metadata');
  }, 40000);

  it('extract from inline html (no url) → 200 with data', async () => {
    const r = await post(port, '/v1/extract', { html: '<table><tr><td>k</td><td>v</td></tr></table>', mode: 'tables' });
    expect(r.status).toBe(200);
    const body = r.body as Record<string, unknown>;
    expect('data' in body).toBe(true);
  });

  it('find_similar → 200 with results[]', async () => {
    const r = await post(port, '/v1/find_similar', { concept: 'deterministic origin content', include_web: false, max_results: 3 }, {}, 60000);
    expect(r.status).toBe(200);
    const body = r.body as Record<string, unknown>;
    expect(Array.isArray(body.results)).toBe(true);
  }, 60000);

  it('research → 200 with brief.topics', async () => {
    const r = await post(port, '/v1/research', { question: 'origin content', depth: 'quick' }, {}, 120000);
    expect(r.status).toBe(200);
    const body = r.body as Record<string, unknown>;
    // brief is always emitted (keyless ladder degrades synthesis, not shape).
    const brief = body.brief as { topics?: unknown } | undefined;
    expect(brief).toBeDefined();
    expect(Array.isArray(brief?.topics)).toBe(true);
  }, 120000);

  it('agent → 200 with steps[]', async () => {
    const r = await post(port, '/v1/agent', { prompt: 'summarize the origin page', urls: [`http://127.0.0.1:${originPort}/`], max_time_ms: 20000, max_pages: 2 }, {}, 60000);
    expect(r.status).toBe(200);
    const body = r.body as Record<string, unknown>;
    expect(Array.isArray(body.steps)).toBe(true);
  }, 60000);

  it('diff → 200 with summary', async () => {
    const r = await post(port, '/v1/diff', { old: { markdown: 'hello world one' }, new: { markdown: 'hello world two' } });
    expect(r.status).toBe(200);
    const body = r.body as Record<string, unknown>;
    expect('changed' in body).toBe(true);
    expect(body.summary !== undefined || body.changed !== undefined).toBe(true);
  });

  it('watch (create) → 200 with job fields', async () => {
    // The watch tool refuses loopback targets by design (its guard requires
    // public hosts); creation performs no fetch, so a public URL is safe and
    // deterministic here.
    const r = await post(port, '/v1/watch', { action: 'create', url: 'https://example.com/watched', interval_seconds: 3600 }, {}, 40000);
    expect(r.status).toBe(200);
    const body = r.body as Record<string, unknown>;
    // create returns a single `job` plus a `jobs[]` set.
    expect('job' in body || 'jobs' in body).toBe(true);
  }, 40000);

  it('watch (list) → 200 with jobs[]', async () => {
    const r = await post(port, '/v1/watch', { action: 'list' });
    expect(r.status).toBe(200);
    const body = r.body as Record<string, unknown>;
    expect(Array.isArray(body.jobs)).toBe(true);
  });
});

describe('REST tools — SSRF + protocol negatives (loopback bind)', () => {
  let daemon: DaemonHttpServer;
  let port: number;

  beforeAll(async () => {
    delete process.env.WIGOLO_API_TOKEN;
    delete process.env.WIGOLO_API_TOKEN_FILE;
    daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1', apiToken: null });
    const url = await daemon.start();
    port = parseInt(new URL(url).port, 10);
  }, 30000);

  afterAll(async () => { await daemon.stop(); }, 30000);

  it('crawl SSRF-refused seed (metadata) → 400 (in-band-error adapter path)', async () => {
    const r = await post(port, '/v1/crawl', { url: 'http://169.254.169.254/latest/meta-data/' });
    expect(r.status).toBe(400);
    expect((r.body as { ok?: boolean }).ok).toBe(false);
  });

  it('crawl file:// seed → 400', async () => {
    const r = await post(port, '/v1/crawl', { url: 'file:///etc/passwd' });
    expect(r.status).toBe(400);
  });

  it('extract metadata-IP target → 400', async () => {
    const r = await post(port, '/v1/extract', { url: 'http://169.254.169.254/', mode: 'metadata' });
    expect(r.status).toBe(400);
  });

  it('agent file:// url → 400', async () => {
    const r = await post(port, '/v1/agent', { prompt: 'x', urls: ['file:///etc/hosts'] });
    expect(r.status).toBe(400);
  });

  it('watch metadata url → 400', async () => {
    const r = await post(port, '/v1/watch', { action: 'create', url: 'http://169.254.169.254/' });
    expect(r.status).toBe(400);
  });

  it('find_similar metadata url → 400', async () => {
    const r = await post(port, '/v1/find_similar', { url: 'http://169.254.169.254/latest/' });
    expect(r.status).toBe(400);
  });
});

describe('REST tools — clamp enforcement (router-owned, T2 boundary tests)', () => {
  let daemon: DaemonHttpServer;
  let port: number;

  beforeAll(async () => {
    delete process.env.WIGOLO_API_TOKEN;
    delete process.env.WIGOLO_API_TOKEN_FILE;
    daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1', apiToken: null });
    const url = await daemon.start();
    port = parseInt(new URL(url).port, 10);
  }, 30000);

  afterAll(async () => { await daemon.stop(); }, 30000);

  it('crawl max_pages=201 (over cap 200) → 400 with cap in hint', async () => {
    const r = await post(port, '/v1/crawl', { url: `http://127.0.0.1:${originPort}/`, max_pages: 201 });
    expect(r.status).toBe(400);
    const body = r.body as { hint?: string };
    expect(typeof body.hint).toBe('string');
    expect(body.hint).toMatch(/200/);
  });

  it('crawl max_pages=200 (boundary) passes the clamp gate', async () => {
    // Boundary value is accepted by the clamp; the request proceeds (the crawl
    // itself is bounded by the origin so it completes fast).
    const r = await post(port, '/v1/crawl', { url: `http://127.0.0.1:${originPort}/`, max_pages: 200, max_depth: 1 }, {}, 60000);
    expect(r.status).toBe(200);
  }, 60000);
});

describe('REST tools — SSRF under non-loopback bind (loopback target refused)', () => {
  let daemon: DaemonHttpServer;
  let port: number;

  beforeAll(async () => {
    delete process.env.WIGOLO_API_TOKEN;
    daemon = new DaemonHttpServer({
      port: 0,
      host: '127.0.0.1',
      apiToken: null,
      allowUnauthenticated: true,
      restBindHost: '0.0.0.0',
    });
    const url = await daemon.start();
    port = parseInt(new URL(url).port, 10);
  }, 30000);

  afterAll(async () => { await daemon.stop(); }, 30000);

  it('crawl loopback target under non-loopback bind → 400', async () => {
    const r = await post(port, '/v1/crawl', { url: `http://127.0.0.1:${originPort}/` }, { Host: 'my.remote.host' });
    expect(r.status).toBe(400);
  });

  it('crawl loopback target allowed when WIGOLO_SERVE_ALLOW_LOCAL_TARGETS=1', async () => {
    process.env.WIGOLO_SERVE_ALLOW_LOCAL_TARGETS = '1';
    try {
      const r = await post(port, '/v1/crawl', { url: `http://127.0.0.1:${originPort}/`, max_pages: 2, max_depth: 1 }, { Host: 'my.remote.host' }, 60000);
      expect(r.status).toBe(200);
    } finally {
      delete process.env.WIGOLO_SERVE_ALLOW_LOCAL_TARGETS;
    }
  }, 60000);
});
