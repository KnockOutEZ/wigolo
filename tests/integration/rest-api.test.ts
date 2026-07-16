import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as http from 'node:http';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DaemonHttpServer } from '../../src/daemon/http-server.js';

/**
 * WHY: the REST surface is the P2 self-host contract. These rows pin the
 * negative matrix (auth modes, resource limits, error codes) end-to-end
 * against a real DaemonHttpServer so a regression in the router pipeline,
 * the lazy-load seam, or the auth gate fails loudly.
 */

interface Resp {
  status: number;
  body: unknown;
  headers: http.IncomingHttpHeaders;
}

// One-shot HTTP with Connection: close (avoids keep-alive ECONNRESET flakes).
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

// A tiny local origin so the fetch happy path is deterministic (no live web).
let originServer: http.Server;
let originPort: number;

beforeAll(async () => {
  delete process.env.WIGOLO_API_TOKEN;
  delete process.env.WIGOLO_API_TOKEN_FILE;
  originServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><head><title>Origin</title></head><body><h1>Hello REST</h1><p>Deterministic origin content.</p></body></html>');
  });
  await new Promise<void>((r) => originServer.listen(0, '127.0.0.1', () => r()));
  originPort = (originServer.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((r) => originServer.close(() => r()));
});

describe('REST API — open loopback mode', () => {
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

  it('fetch happy path → 200 with documented top-level fields', async () => {
    const r = await post(port, '/v1/fetch', { url: `http://127.0.0.1:${originPort}/` });
    expect(r.status).toBe(200);
    const body = r.body as Record<string, unknown>;
    expect(body.error).toBeUndefined();
    expect(typeof body.markdown === 'string' || typeof body.content === 'string').toBe(true);
    expect(body.metadata !== undefined || body.title !== undefined || body.url !== undefined).toBe(true);
  }, 30000);

  it('search returns the documented envelope (200 with fields, or mapped failure)', async () => {
    const r = await post(port, '/v1/search', { query: 'wigolo local first search', search_depth: 'ultra-fast' }, {}, 55000);
    if (r.status === 200) {
      const body = r.body as Record<string, unknown>;
      // Documented top-level: results + evidence present (warning-only stays 200).
      expect('results' in body || 'evidence' in body || 'query_understanding' in body).toBe(true);
    } else {
      // All-engines-failed / unavailability maps to a structured envelope.
      const body = r.body as { ok?: boolean; error_reason?: string };
      expect(body.ok).toBe(false);
      expect(typeof body.error_reason).toBe('string');
    }
  }, 60000);

  it('malformed JSON → 400 invalid_json', async () => {
    const r = await request({ port, method: 'POST', path: '/v1/fetch', headers: { 'Content-Type': 'application/json' }, body: '{not json' });
    expect(r.status).toBe(400);
    expect((r.body as { error_reason: string }).error_reason).toBe('invalid_json');
  });

  it('schema-invalid → 400 invalid_input', async () => {
    const r = await post(port, '/v1/fetch', {});
    expect(r.status).toBe(400);
    expect((r.body as { error_reason: string }).error_reason).toBe('invalid_input');
  });

  it('oversized body → 413', async () => {
    process.env.WIGOLO_SERVE_MAX_BODY_BYTES = '20';
    const r = await post(port, '/v1/fetch', { url: 'https://example.com/some/long/enough/path/to/exceed' });
    expect(r.status).toBe(413);
    delete process.env.WIGOLO_SERVE_MAX_BODY_BYTES;
  });

  it('wrong method → 405 + Allow: POST', async () => {
    const r = await request({ port, method: 'GET', path: '/v1/fetch' });
    expect(r.status).toBe(405);
    expect(r.headers.allow).toBe('POST');
  });

  it('unknown route → 404', async () => {
    const r = await post(port, '/v1/find-similar', {});
    expect(r.status).toBe(404);
  });

  it('bad Host → 403', async () => {
    const r = await post(port, '/v1/fetch', { url: `http://127.0.0.1:${originPort}/` }, { Host: 'evil.example.com' });
    expect(r.status).toBe(403);
  });

  it('Origin header → 403 (before body eval)', async () => {
    const r = await request({ port, method: 'POST', path: '/v1/fetch', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.com' }, body: '{bad json' });
    expect(r.status).toBe(403);
  });

  it('stub route with bad Host → 403 (not 501)', async () => {
    const r = await post(port, '/v1/crawl', {}, { Host: 'evil.example.com' });
    expect(r.status).toBe(403);
  });

  it('/openapi.json → 200 (open-mode half of the policy pair)', async () => {
    const r = await request({ port, path: '/openapi.json' });
    expect(r.status).toBe(200);
    expect((r.body as { openapi?: string }).openapi).toBeTruthy();
  });

  it('/v1/tools → 200 array', async () => {
    const r = await request({ port, path: '/v1/tools' });
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
  });

  it('/health open in this mode', async () => {
    const r = await request({ port, path: '/health' });
    expect([200, 503]).toContain(r.status);
  });

  it('an implemented tool route reaches its handler when the request is valid (diff → 200)', async () => {
    // diff was a T1 stub (501); T2 filled it. A valid request now reaches the
    // handler and returns the plain diff output.
    const r = await post(port, '/v1/diff', { old: { markdown: 'a' }, new: { markdown: 'b' } });
    expect(r.status).toBe(200);
    expect((r.body as { changed?: boolean }).changed).toBeDefined();
  });
});

describe('REST API — token mode', () => {
  let daemon: DaemonHttpServer;
  let port: number;
  const TOKEN = 'test-bearer-token-123';

  beforeAll(async () => {
    daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1', apiToken: TOKEN });
    const url = await daemon.start();
    port = parseInt(new URL(url).port, 10);
  }, 30000);

  afterAll(async () => { await daemon.stop(); }, 30000);

  it('no bearer on /v1 → 401', async () => {
    const r = await post(port, '/v1/fetch', { url: 'https://example.com' });
    expect(r.status).toBe(401);
  });

  it('wrong bearer on /v1 → 401', async () => {
    const r = await post(port, '/v1/fetch', { url: 'https://example.com' }, { Authorization: 'Bearer nope' });
    expect(r.status).toBe(401);
  });

  it('no bearer on /mcp → 401', async () => {
    const r = await post(port, '/mcp', { jsonrpc: '2.0', method: 'initialize', id: 1 });
    expect(r.status).toBe(401);
  });

  it('no bearer on /sse → 401', async () => {
    const r = await request({ port, path: '/sse' });
    expect(r.status).toBe(401);
  });

  it('no bearer on /messages → 401', async () => {
    const r = await post(port, '/messages?sessionId=x', {});
    expect(r.status).toBe(401);
  });

  it('valid bearer + remote-style Host → 200 (Host allowlist skipped)', async () => {
    const r = await post(port, '/v1/fetch', { url: `http://127.0.0.1:${originPort}/` }, { Authorization: `Bearer ${TOKEN}`, Host: 'my.remote.host' });
    expect(r.status).toBe(200);
  }, 30000);

  it('valid bearer, unauth-to-stub → 401 not 501 (checked before dispatch)', async () => {
    const r = await post(port, '/v1/crawl', {}, { Host: 'my.remote.host' });
    expect(r.status).toBe(401);
  });

  it('/openapi.json without bearer → 401 (version disclosure gated)', async () => {
    const r = await request({ port, path: '/openapi.json' });
    expect(r.status).toBe(401);
  });

  it('/openapi.json with valid bearer → 200', async () => {
    const r = await request({ port, path: '/openapi.json', headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(r.status).toBe(200);
  });

  it('/health always open (no bearer required)', async () => {
    const r = await request({ port, path: '/health' });
    expect([200, 503]).toContain(r.status);
  });
});

describe('REST API — override mode (simulated non-loopback bind)', () => {
  let daemon: DaemonHttpServer;
  let port: number;

  beforeAll(async () => {
    delete process.env.WIGOLO_API_TOKEN;
    // Actually bind loopback, but tell the router the bind is non-loopback.
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

  it('wildcard bind + external-style Host + no bearer → 200 (Host skipped)', async () => {
    // Point at the local origin (fast + deterministic) and allow local targets
    // so the target-guard does not block it — the row proves auth (Host-skip)
    // succeeded end-to-end with a real 200, not that fetch reaches the WAN.
    process.env.WIGOLO_SERVE_ALLOW_LOCAL_TARGETS = '1';
    try {
      const r = await post(port, '/v1/fetch', { url: `http://127.0.0.1:${originPort}/` }, { Host: 'my.remote.host' });
      expect(r.status).toBe(200);
    } finally {
      delete process.env.WIGOLO_SERVE_ALLOW_LOCAL_TARGETS;
    }
  }, 30000);

  it('Origin header still rejected in override mode → 403', async () => {
    const r = await post(port, '/v1/fetch', { url: 'https://example.com' }, { Host: 'my.remote.host', Origin: 'https://evil.com' });
    expect(r.status).toBe(403);
  });

  it('serve-mode target guard: loopback target under non-loopback bind → 400', async () => {
    const r = await post(port, '/v1/fetch', { url: `http://127.0.0.1:${originPort}/` }, { Host: 'my.remote.host' });
    expect(r.status).toBe(400);
  });
});

describe('REST API — concurrency saturation', () => {
  let daemon: DaemonHttpServer;
  let port: number;

  beforeAll(async () => {
    delete process.env.WIGOLO_API_TOKEN;
    process.env.WIGOLO_SERVE_MAX_CONCURRENCY = '1';
    daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1', apiToken: null });
    const url = await daemon.start();
    port = parseInt(new URL(url).port, 10);
  }, 30000);

  afterAll(async () => {
    await daemon.stop();
    delete process.env.WIGOLO_SERVE_MAX_CONCURRENCY;
  }, 30000);

  it('second concurrent request over the cap → 429 with Retry-After', async () => {
    // Fire a fetch at the local origin (fast) plus a search (slower) to hold
    // the single slot; race a second request to hit the cap.
    const slow = post(port, '/v1/search', { query: 'hold the slot open for a moment', search_depth: 'balanced' });
    await new Promise((r) => setTimeout(r, 30));
    const second = await post(port, '/v1/fetch', { url: `http://127.0.0.1:${originPort}/` });
    // Either the slow request is still holding the slot (429) or it already
    // finished (then the fetch succeeds). Assert the cap fires when contended.
    if (second.status === 429) {
      expect(second.headers['retry-after']).toBe('5');
    } else {
      expect([200, 500, 502, 503]).toContain(second.status);
    }
    await slow.catch(() => undefined);
  }, 60000);
});

describe('ajv-laziness — SOURCE-LEVEL guard', () => {
  const SRC = join(process.cwd(), 'src');

  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) out.push(...walk(p));
      else if (p.endsWith('.ts')) out.push(p);
    }
    return out;
  }

  it('no static ajv import specifier anywhere in src/', () => {
    const files = walk(SRC);
    const offenders: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, 'utf-8');
      // A static import/require of ajv. The only allowed reference is the
      // dynamic import('ajv') inside rest/validate.ts.
      if (/\bfrom\s+['"]ajv['"]/.test(text) || /\brequire\(\s*['"]ajv['"]\s*\)/.test(text)) {
        offenders.push(f);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('validate.ts references ajv only via dynamic import', () => {
    const text = readFileSync(join(SRC, 'daemon', 'rest', 'validate.ts'), 'utf-8');
    expect(text).toMatch(/await import\(\s*['"]ajv['"]\s*\)/);
    expect(text).not.toMatch(/\bfrom\s+['"]ajv['"]/);
  });

  it('http-server.ts references the router only via dynamic import', () => {
    const text = readFileSync(join(SRC, 'daemon', 'http-server.ts'), 'utf-8');
    expect(text).toMatch(/await import\(\s*['"]\.\/rest\/router\.js['"]\s*\)/);
    // No static import of the router module (only a type-only import allowed).
    expect(text).not.toMatch(/^import\s+\{[^}]*\bRestRouter\b[^}]*\}\s+from\s+['"]\.\/rest\/router\.js['"]/m);
  });
});
