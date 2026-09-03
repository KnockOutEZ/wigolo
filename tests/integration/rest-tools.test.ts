import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import { DaemonHttpServer } from '../../src/daemon/http-server.js';
import { closedRegions, fenceNonces, regionBody } from '../helpers/untrusted-fence.js';
import { allowNetworkInThisFile } from '../net-fence.js';

// Same shape as rest-api.test.ts: a real DaemonHttpServer driving the real tool pipeline, so the
// crawl/research/agent rows egress. Measured destinations: www.bing.com:443,
// lite.duckduckgo.com:443. Declared so the dependence is inventoried rather than inferred from a
// red on a plane.
//
// `storage.googleapis.com:443` was a third measured destination until #241 — the embedding model
// downloading into a fresh test home, which put "find_similar -> 200 with results[]" at 7.5s on a
// fast link and timed it out at exactly 60s on a slow one. `tests/setup.ts` now seeds that model
// from the machine's real cache and the row costs 56ms. The allowance below stays because the
// search engines above are a real, remaining egress — unlike find-similar.test.ts, this file
// cannot arm the fence.
allowNetworkInThisFile(
  'drives the real REST tool pipeline end to end against live search engines',
);

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

/**
 * ON THE WIRE. The unit tests pin the shaping function; these pin what a real client actually
 * RECEIVES through the full router + auth + limits + dispatch pipeline. The seam is only worth
 * anything if the bytes on the socket carry it — a shaping helper nobody reaches is not a control.
 */
describe('REST tools — untrusted-content representation on the wire (R2 / A10)', () => {
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

  it('WIRE-1: a plain fetch with NO header comes back FENCED, and the url stays dereferenceable', async () => {
    // MUT: default the router's native fallback to 'envelope' → RED.
    const r = await post(port, '/v1/fetch', { url: `http://127.0.0.1:${originPort}/` }, {}, 40000);
    expect(r.status).toBe(200);
    const body = r.body as { markdown: string; url: string; untrusted_content?: unknown };
    expect(closedRegions(body.markdown)).toBe(1);
    expect(regionBody(body.markdown)).toContain('Deterministic content');
    expect(body.url).toBe(`http://127.0.0.1:${originPort}/`);
    expect(body.untrusted_content).toBeUndefined();
  }, 40000);

  it('WIRE-2: the same fetch under `envelope` comes back BYTE-CLEAN with the metadata sibling', async () => {
    // The two representations must carry the same content; only the packaging differs.
    const r = await post(
      port,
      '/v1/fetch',
      { url: `http://127.0.0.1:${originPort}/` },
      { 'X-Wigolo-Untrusted-Content': 'envelope' },
      40000,
    );
    expect(r.status).toBe(200);
    const body = r.body as { markdown: string; untrusted_content: { nonce: string; begin_marker: string; end_marker: string; notice: string } };
    expect(closedRegions(body.markdown)).toBe(0);
    expect(body.markdown).toContain('Deterministic content');
    expect(body.untrusted_content.nonce).toMatch(/^[0-9a-f]{16}$/);
  }, 40000);

  it('WIRE-3: a bulk crawl fences EVERY page, each with its own nonce', async () => {
    // The bulk path is where a hoisted single wrap would show up as a shared terminator.
    const r = await post(port, '/v1/crawl', { url: `http://127.0.0.1:${originPort}/`, max_pages: 3, max_depth: 1 }, {}, 60000);
    expect(r.status).toBe(200);
    const pages = (r.body as { pages: Array<{ markdown: string; url: string }> }).pages;
    expect(pages.length).toBeGreaterThanOrEqual(2);
    const nonces = pages.flatMap((p) => fenceNonces(p.markdown));
    expect(nonces.length).toBe(pages.length);
    expect(new Set(nonces).size).toBe(nonces.length); // all distinct
    for (const p of pages) expect(closedRegions(p.markdown)).toBe(1);
  }, 60000);

  it('WIRE-4: a `watch` LISTING has nothing to contain, but watch is now a page-derived tool', async () => {
    // REWRITTEN, and the old title names the mistake: "`watch` carries no fence and no envelope in
    // either mode", justified as "hashes and counts are operational". Both halves of that were built
    // on the same reading — a description of watch's TYPICAL fields — and it was silent about
    // `changes_since_last[].error`, which the scheduler fills from the fetch tool's prose reason and
    // which therefore carries bytes read off the wire. Watch joined PAGE_DERIVED_TOOLS to close it.
    //
    // The must-not-fire half is KEPT and is what this row still owns end to end, on a real socket: a
    // LISTING has no prose field at all, so the default representation must add no region to it.
    // Fencing an id, a hash or a status enum would corrupt a value the caller matches on. Containment
    // of the error itself is owned by REST-8 and the in-band fence suite, which can drive a failed
    // check without a live origin.
    const listed = await post(port, '/v1/watch', { action: 'list' });
    expect(listed.status).toBe(200);
    expect(closedRegions(JSON.stringify(listed.body))).toBe(0);
    expect((listed.body as { untrusted_content?: unknown }).untrusted_content).toBeUndefined();

    // …and under the opt-in, watch now carries the trust envelope every other page-derived tool
    // carries. This is the observable consequence of joining the set, and it is asserted rather than
    // left implicit: an opted-in SDK that gets no envelope has nothing to fence with.
    const enveloped = await post(port, '/v1/watch', { action: 'list' }, { 'X-Wigolo-Untrusted-Content': 'envelope' });
    expect(enveloped.status).toBe(200);
    const env = (enveloped.body as { untrusted_content?: { trusted: boolean; nonce: string } }).untrusted_content;
    expect(env).toBeDefined();
    expect(env?.trusted).toBe(false);
    expect(env?.nonce).toMatch(/^[0-9a-f]{16}$/);
  }, 40000);

  it('WIRE-5: an unrecognized header value is a 400 invalid_input, not a silent fallback', async () => {
    const r = await post(port, '/v1/fetch', { url: `http://127.0.0.1:${originPort}/` }, { 'X-Wigolo-Untrusted-Content': 'envelop' });
    expect(r.status).toBe(400);
    expect((r.body as { error_reason?: string }).error_reason).toBe('invalid_input');
  }, 20000);
});
