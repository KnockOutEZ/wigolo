import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { RestRouter } from '../../../src/daemon/rest/router.js';
import type { Subsystems } from '../../../src/server.js';

vi.mock('../../../src/daemon/rest/dispatch.js', () => ({
  dispatchTool: vi.fn(),
}));
vi.mock('../../../src/watch/scheduler.js', () => ({
  scheduleOverdueCheck: vi.fn(),
}));

import { dispatchTool } from '../../../src/daemon/rest/dispatch.js';

// Minimal req/res harness.
function makeReq(opts: {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: string;
}): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage & { destroy: () => void; pause: () => void; resume: () => void };
  (req as { method?: string }).method = opts.method ?? 'POST';
  (req as { url?: string }).url = opts.url ?? '/v1/fetch';
  (req as { headers: Record<string, string> }).headers = { host: '127.0.0.1:3333', ...(opts.headers ?? {}) };
  (req as { destroy: () => void }).destroy = vi.fn();
  (req as { pause: () => void }).pause = vi.fn();
  (req as { resume: () => void }).resume = vi.fn();
  process.nextTick(() => {
    if (opts.body !== undefined) req.emit('data', Buffer.from(opts.body));
    req.emit('end');
  });
  return req;
}

interface CapturedRes {
  res: ServerResponse;
  get: () => { status: number; body: unknown; headers: Record<string, string> };
}
function makeRes(): CapturedRes {
  let status = 0;
  let headers: Record<string, string> = {};
  const chunks: string[] = [];
  const res = {
    headersSent: false,
    writableEnded: false,
    writeHead(code: number, hdrs?: Record<string, string>) {
      status = code;
      if (hdrs) headers = { ...headers, ...hdrs };
      (this as { headersSent: boolean }).headersSent = true;
      return this;
    },
    end(chunk?: string) {
      if (chunk) chunks.push(chunk);
      (this as { writableEnded: boolean }).writableEnded = true;
    },
  } as unknown as ServerResponse;
  return {
    res,
    get: () => {
      const text = chunks.join('');
      let body: unknown = text;
      try { body = JSON.parse(text); } catch { /* leave as text */ }
      return { status, body, headers };
    },
  };
}

function fakeSubsystems(): Subsystems {
  return {
    searchEngines: [],
    router: {} as unknown,
    backendStatus: {} as unknown,
  } as unknown as Subsystems;
}

function loopbackRouter(): RestRouter {
  return new RestRouter({
    subsystems: fakeSubsystems(),
    bindHost: '127.0.0.1',
    token: null,
    allowUnauthenticated: false,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(dispatchTool).mockResolvedValue({ status: 200, body: { ok: true, data: 'x' } });
});

describe('RestRouter — routing basics', () => {
  it('POST /v1/fetch valid → dispatches (200)', async () => {
    const router = loopbackRouter();
    const { res, get } = makeRes();
    await router.handle(makeReq({ url: '/v1/fetch', body: JSON.stringify({ url: 'https://example.com' }) }), res);
    expect(get().status).toBe(200);
    expect(dispatchTool).toHaveBeenCalled();
  });

  it('GET on a tool route → 405 with Allow: POST', async () => {
    const router = loopbackRouter();
    const { res, get } = makeRes();
    await router.handle(makeReq({ method: 'GET', url: '/v1/fetch' }), res);
    const out = get();
    expect(out.status).toBe(405);
    expect(out.headers.Allow).toBe('POST');
  });

  it('unknown route → 404', async () => {
    const router = loopbackRouter();
    const { res, get } = makeRes();
    await router.handle(makeReq({ url: '/v1/find-similar', body: '{}' }), res);
    expect(get().status).toBe(404);
  });

  it('GET /v1/tools → 200 array', async () => {
    const router = loopbackRouter();
    const { res, get } = makeRes();
    await router.handle(makeReq({ method: 'GET', url: '/v1/tools' }), res);
    const out = get();
    expect(out.status).toBe(200);
    expect(Array.isArray(out.body)).toBe(true);
  });

  it('GET /openapi.json → 200 object; alias /v1/openapi.json identical', async () => {
    const router = loopbackRouter();
    const a = makeRes();
    await router.handle(makeReq({ method: 'GET', url: '/openapi.json' }), a.res);
    expect(a.get().status).toBe(200);
    const b = makeRes();
    await router.handle(makeReq({ method: 'GET', url: '/v1/openapi.json' }), b.res);
    expect(b.get().status).toBe(200);
  });
});

describe('RestRouter — pipeline', () => {
  it('malformed JSON → 400 invalid_json', async () => {
    const router = loopbackRouter();
    const { res, get } = makeRes();
    await router.handle(makeReq({ url: '/v1/fetch', body: '{not json' }), res);
    const out = get();
    expect(out.status).toBe(400);
    expect((out.body as { error_reason: string }).error_reason).toBe('invalid_json');
  });

  it('schema-invalid → 400 invalid_input', async () => {
    const router = loopbackRouter();
    const { res, get } = makeRes();
    await router.handle(makeReq({ url: '/v1/fetch', body: JSON.stringify({}) }), res);
    const out = get();
    expect(out.status).toBe(400);
    expect((out.body as { error_reason: string }).error_reason).toBe('invalid_input');
  });

  it('over-cap clamp value → 400 with cap in hint', async () => {
    const router = loopbackRouter();
    const { res, get } = makeRes();
    await router.handle(makeReq({ url: '/v1/crawl', body: JSON.stringify({ url: 'https://x.com', max_pages: 9999 }) }), res);
    const out = get();
    expect(out.status).toBe(400);
    expect((out.body as { hint?: string }).hint).toContain('200');
    expect(dispatchTool).not.toHaveBeenCalled();
  });

  it('boundary clamp value passes to dispatch', async () => {
    const router = loopbackRouter();
    const { res } = makeRes();
    await router.handle(makeReq({ url: '/v1/crawl', body: JSON.stringify({ url: 'https://x.com', max_pages: 200 }) }), res);
    expect(dispatchTool).toHaveBeenCalled();
  });

  it('oversized body → 413', async () => {
    process.env.WIGOLO_SERVE_MAX_BODY_BYTES = '10';
    const router = loopbackRouter();
    const { res, get } = makeRes();
    await router.handle(makeReq({ url: '/v1/fetch', body: JSON.stringify({ url: 'https://example.com/very/long/path' }) }), res);
    expect(get().status).toBe(413);
    delete process.env.WIGOLO_SERVE_MAX_BODY_BYTES;
  });
});

describe('RestRouter — auth ordering (stub route sits behind checks)', () => {
  it('token mode, no bearer, to a stub route → 401 (not 501)', async () => {
    const router = new RestRouter({
      subsystems: fakeSubsystems(),
      bindHost: '127.0.0.1',
      token: 'secret',
      allowUnauthenticated: false,
    });
    const { res, get } = makeRes();
    await router.handle(makeReq({ url: '/v1/crawl', body: '{}', headers: { host: 'remote.host' } }), res);
    expect(get().status).toBe(401);
  });

  it('open mode, bad Host, to a stub route → 403 (not 501)', async () => {
    const router = loopbackRouter();
    const { res, get } = makeRes();
    await router.handle(makeReq({ url: '/v1/crawl', body: '{}', headers: { host: 'evil.com' } }), res);
    expect(get().status).toBe(403);
  });

  it('open mode, Origin present → 403 before body eval', async () => {
    const router = loopbackRouter();
    const { res, get } = makeRes();
    await router.handle(makeReq({ url: '/v1/fetch', body: '{bad json', headers: { host: '127.0.0.1', origin: 'https://evil.com' } }), res);
    // 403 fires before JSON parse — so a malformed body still yields 403 not 400.
    expect(get().status).toBe(403);
  });

  it('open mode /openapi.json → 200', async () => {
    const router = loopbackRouter();
    const { res, get } = makeRes();
    await router.handle(makeReq({ method: 'GET', url: '/openapi.json' }), res);
    expect(get().status).toBe(200);
  });

  it('token mode /openapi.json without bearer → 401', async () => {
    const router = new RestRouter({
      subsystems: fakeSubsystems(),
      bindHost: '127.0.0.1',
      token: 'secret',
      allowUnauthenticated: false,
    });
    const { res, get } = makeRes();
    await router.handle(makeReq({ method: 'GET', url: '/openapi.json', headers: { host: 'remote.host' } }), res);
    expect(get().status).toBe(401);
  });
});

describe('RestRouter — concurrency', () => {
  it('over-cap concurrent requests → 429 with Retry-After', async () => {
    process.env.WIGOLO_SERVE_MAX_CONCURRENCY = '1';
    // A dispatch that never settles until we release it.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    vi.mocked(dispatchTool).mockImplementation(async () => {
      await gate;
      return { status: 200, body: { ok: true } };
    });
    const router = loopbackRouter();

    const first = router.handle(makeReq({ url: '/v1/fetch', body: JSON.stringify({ url: 'https://example.com' }) }), makeRes().res);
    // Give the first request a tick to acquire the slot + start dispatch.
    await new Promise((r) => setTimeout(r, 20));

    const second = makeRes();
    await router.handle(makeReq({ url: '/v1/fetch', body: JSON.stringify({ url: 'https://example.com' }) }), second.res);
    const out = second.get();
    expect(out.status).toBe(429);
    expect(out.headers['Retry-After']).toBe('5');

    release();
    await first;
    delete process.env.WIGOLO_SERVE_MAX_CONCURRENCY;
  });

  it('slot is released after the handler settles (next request succeeds)', async () => {
    process.env.WIGOLO_SERVE_MAX_CONCURRENCY = '1';
    vi.mocked(dispatchTool).mockResolvedValue({ status: 200, body: { ok: true } });
    const router = loopbackRouter();
    await router.handle(makeReq({ url: '/v1/fetch', body: JSON.stringify({ url: 'https://example.com' }) }), makeRes().res);
    const second = makeRes();
    await router.handle(makeReq({ url: '/v1/fetch', body: JSON.stringify({ url: 'https://example.com' }) }), second.res);
    expect(second.get().status).toBe(200);
    delete process.env.WIGOLO_SERVE_MAX_CONCURRENCY;
  });
});

describe('RestRouter — deadline', () => {
  it('slow dispatch → 504, slot stays held until late settle, late settle does not double-write', async () => {
    process.env.WIGOLO_SERVE_MAX_CONCURRENCY = '1';
    process.env.WIGOLO_SERVE_TIMEOUT_SCALE = '0.0001'; // ~6ms for a 60s route
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    vi.mocked(dispatchTool).mockImplementation(async () => {
      await gate;
      return { status: 200, body: { ok: true } };
    });
    const router = loopbackRouter();
    const first = makeRes();
    await router.handle(makeReq({ url: '/v1/search', body: JSON.stringify({ query: 'x' }) }), first.res);
    expect(first.get().status).toBe(504);

    // Slot still held → next request 429.
    const second = makeRes();
    await router.handle(makeReq({ url: '/v1/search', body: JSON.stringify({ query: 'x' }) }), second.res);
    expect(second.get().status).toBe(429);

    // Late settle must not throw / double-write.
    release();
    await new Promise((r) => setTimeout(r, 10));
    expect(first.get().status).toBe(504); // unchanged

    delete process.env.WIGOLO_SERVE_MAX_CONCURRENCY;
    delete process.env.WIGOLO_SERVE_TIMEOUT_SCALE;
  });
});
