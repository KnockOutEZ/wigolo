import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import { DaemonHttpServer } from '../../src/daemon/http-server.js';

/**
 * WHY: the Firecrawl-compat shim rides the SAME router pipeline as /v1 — auth,
 * body caps, and the SSRF target guard must all apply to it (D11: "the shim
 * must NOT be an escape hatch"). These rows drive a REAL DaemonHttpServer so a
 * regression in the flag gate, the auth gate, or the SSRF seam fails loudly
 * end-to-end. The flag is set in beforeAll and cleared in afterAll.
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
    req.setTimeout(opts.timeoutMs ?? 15000, () => req.destroy(new Error('request timeout')));
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

function post(port: number, path: string, body: unknown, headers: Record<string, string> = {}, timeoutMs?: number): Promise<Resp> {
  return request({ port, method: 'POST', path, body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...headers }, timeoutMs });
}

const PREFIX = '/compat/firecrawl';

// Deterministic local origin so scrape has real content without the live web.
let originServer: http.Server;
let originPort: number;

beforeAll(async () => {
  delete process.env.WIGOLO_API_TOKEN;
  delete process.env.WIGOLO_API_TOKEN_FILE;
  originServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><head><title>Compat Origin</title></head><body><h1>Hi</h1><p>Firecrawl compat body.</p></body></html>');
  });
  await new Promise<void>((r) => originServer.listen(0, '127.0.0.1', () => r()));
  originPort = (originServer.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((r) => originServer.close(() => r()));
});

describe('Firecrawl-compat — flag OFF', () => {
  let daemon: DaemonHttpServer;
  let port: number;

  beforeAll(async () => {
    delete process.env.WIGOLO_FIRECRAWL_COMPAT;
    delete process.env.WIGOLO_API_TOKEN;
    daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1', apiToken: null });
    const url = await daemon.start();
    port = parseInt(new URL(url).port, 10);
  }, 30000);

  afterAll(async () => { await daemon.stop(); }, 30000);

  it('scrape → 404 when the flag is off', async () => {
    const r = await post(port, `${PREFIX}/v1/scrape`, { url: `http://127.0.0.1:${originPort}/` });
    expect(r.status).toBe(404);
  });

  it('search → 404 when the flag is off', async () => {
    const r = await post(port, `${PREFIX}/v1/search`, { query: 'x' });
    expect(r.status).toBe(404);
  });

  it('map → 404 when the flag is off', async () => {
    const r = await post(port, `${PREFIX}/v1/map`, { url: 'https://example.com' });
    expect(r.status).toBe(404);
  });

  it('crawl → 404 when the flag is off', async () => {
    const r = await post(port, `${PREFIX}/v1/crawl`, { url: 'https://example.com' });
    expect(r.status).toBe(404);
  });
});

describe('Firecrawl-compat — flag ON, open loopback mode', () => {
  let daemon: DaemonHttpServer;
  let port: number;

  beforeAll(async () => {
    process.env.WIGOLO_FIRECRAWL_COMPAT = '1';
    delete process.env.WIGOLO_API_TOKEN;
    daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1', apiToken: null });
    const url = await daemon.start();
    port = parseInt(new URL(url).port, 10);
  }, 30000);

  afterAll(async () => {
    await daemon.stop();
    delete process.env.WIGOLO_FIRECRAWL_COMPAT;
  }, 30000);

  it('scrape → {success:true, data:{markdown, metadata:{sourceURL}}}', async () => {
    const r = await post(port, `${PREFIX}/v1/scrape`, { url: `http://127.0.0.1:${originPort}/`, formats: ['markdown'] }, {}, 30000);
    expect(r.status).toBe(200);
    const body = r.body as { success: boolean; data: { markdown: string; metadata: { sourceURL: string } } };
    expect(body.success).toBe(true);
    expect(typeof body.data.markdown).toBe('string');
    expect(body.data.metadata.sourceURL).toContain('127.0.0.1');
    // wigolo-unique fields never leak
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('evidence_score');
    expect(serialized).not.toContain('query_understanding');
    expect(serialized).not.toContain('fetch_method');
  }, 30000);

  it('unknown shim subpath → 404', async () => {
    const r = await post(port, `${PREFIX}/v1/does-not-exist`, {});
    expect(r.status).toBe(404);
  });

  it('crawl lifecycle: POST → id, GET → status', async () => {
    const start = await post(port, `${PREFIX}/v1/crawl`, { url: `http://127.0.0.1:${originPort}/`, limit: 2 }, {}, 30000);
    expect(start.status).toBe(200);
    const startBody = start.body as { success: boolean; id: string };
    expect(startBody.success).toBe(true);
    expect(typeof startBody.id).toBe('string');

    // Poll until terminal or a bounded number of tries.
    let status = '';
    for (let i = 0; i < 40; i++) {
      const poll = await request({ port, path: `${PREFIX}/v1/crawl/${startBody.id}` });
      expect(poll.status).toBe(200);
      status = (poll.body as { status: string }).status;
      if (status === 'completed' || status === 'failed') break;
      await new Promise((res) => setTimeout(res, 250));
    }
    expect(['scraping', 'completed', 'failed']).toContain(status);
  }, 30000);

  it('GET crawl/{unknown-id} → 404 {success:false}', async () => {
    const r = await request({ port, path: `${PREFIX}/v1/crawl/nonexistent-id` });
    expect(r.status).toBe(404);
    expect((r.body as { success: boolean }).success).toBe(false);
  });

  it('crawl limit over-cap → 400 {success:false} with cap message', async () => {
    const r = await post(port, `${PREFIX}/v1/crawl`, { url: 'https://example.com', limit: 9999 });
    expect(r.status).toBe(400);
    expect((r.body as { success: boolean }).success).toBe(false);
    expect((r.body as { error: string }).error).toMatch(/cap|200/i);
  });
});

describe('Firecrawl-compat — auth applies (token mode)', () => {
  let daemon: DaemonHttpServer;
  let port: number;
  const TOKEN = 'compat-token-xyz';

  beforeAll(async () => {
    process.env.WIGOLO_FIRECRAWL_COMPAT = '1';
    daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1', apiToken: TOKEN });
    const url = await daemon.start();
    port = parseInt(new URL(url).port, 10);
  }, 30000);

  afterAll(async () => {
    await daemon.stop();
    delete process.env.WIGOLO_FIRECRAWL_COMPAT;
  }, 30000);

  it('no bearer on shim scrape → 401 (auth runs before the shim)', async () => {
    const r = await post(port, `${PREFIX}/v1/scrape`, { url: 'https://example.com' });
    expect(r.status).toBe(401);
  });

  it('valid bearer → shim reachable', async () => {
    const r = await post(port, `${PREFIX}/v1/scrape`, { url: `http://127.0.0.1:${originPort}/` }, { Authorization: `Bearer ${TOKEN}`, Host: 'my.remote.host' }, 30000);
    expect(r.status).toBe(200);
    expect((r.body as { success: boolean }).success).toBe(true);
  }, 30000);
});

describe('Firecrawl-compat — shim shares the /v1 concurrency cap + deadline (D7/D11)', () => {
  // WHY: the shim rides the SAME router pipeline as /v1, so it MUST take a
  // concurrency slot and run under a per-route deadline. Before the fix the
  // shim branch called handleCompatRequest directly — no slot, no deadline —
  // making it an unbounded escape hatch. Each row below fails if the wrapper is
  // removed (asserts 429 / 504, not merely 200).
  let daemon: DaemonHttpServer;
  let port: number;
  // A slow origin the shim's scrape blocks on for ~2s, so the two in-flight
  // scrapes reliably hold both slots while a third arrives. The delay stays
  // under the 10s fetch timeout so the HTTP tier completes normally (no
  // browser-engine escalation) and each scrape returns 200.
  let slowServer: http.Server;
  let slowPort: number;
  const SLOW_MS = 2000;

  beforeAll(async () => {
    process.env.WIGOLO_FIRECRAWL_COMPAT = '1';
    process.env.WIGOLO_SERVE_MAX_CONCURRENCY = '2';
    delete process.env.WIGOLO_API_TOKEN;
    slowServer = http.createServer((_req, res) => {
      setTimeout(() => {
        if (res.writableEnded) return;
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><p>slow body with enough words to extract cleanly here</p></body></html>');
      }, SLOW_MS);
    });
    await new Promise<void>((r) => slowServer.listen(0, '127.0.0.1', () => r()));
    slowPort = (slowServer.address() as { port: number }).port;
    daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1', apiToken: null });
    const url = await daemon.start();
    port = parseInt(new URL(url).port, 10);
  }, 30000);

  afterAll(async () => {
    await daemon.stop();
    await new Promise<void>((r) => slowServer.close(() => r()));
    delete process.env.WIGOLO_FIRECRAWL_COMPAT;
    delete process.env.WIGOLO_SERVE_MAX_CONCURRENCY;
  }, 30000);

  it('over-cap in-flight shim scrapes → 429 with Retry-After; releasing frees capacity', async () => {
    // Fill both slots with scrapes that block on the slow origin for ~2s.
    const inflight = [
      post(port, `${PREFIX}/v1/scrape`, { url: `http://127.0.0.1:${slowPort}/a` }, {}, 30000),
      post(port, `${PREFIX}/v1/scrape`, { url: `http://127.0.0.1:${slowPort}/b` }, {}, 30000),
    ];
    // Give both a moment to acquire slots + reach the blocking origin fetch.
    await new Promise((r) => setTimeout(r, 400));

    // Third request cannot get a slot → 429 (property that fails without the wrapper).
    const over = await post(port, `${PREFIX}/v1/scrape`, { url: `http://127.0.0.1:${slowPort}/c` }, {}, 30000);
    expect(over.status).toBe(429);
    expect(over.headers['retry-after']).toBe('5');

    // The in-flight scrapes settle once the origin responds, freeing both slots.
    const settled = await Promise.all(inflight);
    expect(settled.every((r) => r.status === 200)).toBe(true);

    // Capacity restored — a fresh scrape succeeds (slot was released on settle).
    const after = await post(port, `${PREFIX}/v1/scrape`, { url: `http://127.0.0.1:${slowPort}/d` }, {}, 30000);
    expect(after.status).toBe(200);
  }, 40000);
});

describe('Firecrawl-compat — shim deadline (504) holds the slot until settle', () => {
  // WHY: a shim request that exceeds its per-route deadline must yield a 504 AND
  // keep its slot until the underlying work settles — identical to /v1. This
  // fails if the shim skips the deadline wrapper (it would 200/hang, never 504).
  let daemon: DaemonHttpServer;
  let port: number;
  let hangServer: http.Server;
  let hangPort: number;
  const openResponses: http.ServerResponse[] = [];

  beforeAll(async () => {
    process.env.WIGOLO_FIRECRAWL_COMPAT = '1';
    process.env.WIGOLO_SERVE_MAX_CONCURRENCY = '1';
    process.env.WIGOLO_SERVE_TIMEOUT_SCALE = '0.001'; // fetch route 120s → ~120ms
    delete process.env.WIGOLO_API_TOKEN;
    hangServer = http.createServer((_req, res) => { openResponses.push(res); });
    await new Promise<void>((r) => hangServer.listen(0, '127.0.0.1', () => r()));
    hangPort = (hangServer.address() as { port: number }).port;
    daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1', apiToken: null });
    const url = await daemon.start();
    port = parseInt(new URL(url).port, 10);
  }, 30000);

  afterAll(async () => {
    for (const res of openResponses) { try { res.destroy(); } catch { /* ignore */ } }
    await daemon.stop();
    await new Promise<void>((r) => hangServer.close(() => r()));
    delete process.env.WIGOLO_FIRECRAWL_COMPAT;
    delete process.env.WIGOLO_SERVE_MAX_CONCURRENCY;
    delete process.env.WIGOLO_SERVE_TIMEOUT_SCALE;
  }, 30000);

  it('slow shim scrape → 504 route_timeout; slot stays held (next request → 429)', async () => {
    const first = await post(port, `${PREFIX}/v1/scrape`, { url: `http://127.0.0.1:${hangPort}/hang` }, {}, 30000);
    expect(first.status).toBe(504);
    expect((first.body as { error_reason?: string }).error_reason).toBe('route_timeout');

    // The underlying fetch is still hanging → the slot is held → next request 429.
    const second = await post(port, `${PREFIX}/v1/scrape`, { url: `http://127.0.0.1:${hangPort}/hang2` }, {}, 30000);
    expect(second.status).toBe(429);
  }, 40000);
});

describe('Firecrawl-compat — SSRF escape-hatch closed (override / non-loopback bind)', () => {
  let daemon: DaemonHttpServer;
  let port: number;

  beforeAll(async () => {
    process.env.WIGOLO_FIRECRAWL_COMPAT = '1';
    delete process.env.WIGOLO_API_TOKEN;
    // Bind loopback in reality, tell the router the bind is non-loopback so the
    // serve-mode target guard engages (mirrors rest-api.test.ts override mode).
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

  afterAll(async () => {
    await daemon.stop();
    delete process.env.WIGOLO_FIRECRAWL_COMPAT;
  }, 30000);

  it('loopback-target scrape under a non-loopback bind → 400 {success:false}', async () => {
    const r = await post(port, `${PREFIX}/v1/scrape`, { url: `http://127.0.0.1:${originPort}/` }, { Host: 'my.remote.host' });
    expect(r.status).toBe(400);
    expect((r.body as { success: boolean }).success).toBe(false);
  });
});
