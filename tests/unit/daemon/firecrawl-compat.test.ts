import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * WHY: the Firecrawl-compat shim is the drop-in surface that neutralizes a
 * named competitor win. These tests pin the per-route field mapping (so a
 * Firecrawl SDK sees the exact shape it expects), the in-memory job lifecycle,
 * and the three eviction bounds (count / byte-pressure / TTL). Field-mapping
 * tests mock the heavy handlers so they assert the shim's translation, not the
 * tool internals. Job-store bound tests exercise the store class directly.
 */

// Mocked tool handlers — the shim's job is translation, not fetching.
const mockHandleFetch = vi.fn();
const mockHandleSearch = vi.fn();
const mockHandleCrawl = vi.fn();

vi.mock('../../../src/tools/fetch.js', () => ({
  handleFetch: (...args: unknown[]) => mockHandleFetch(...args),
}));
vi.mock('../../../src/tools/search.js', () => ({
  handleSearch: (...args: unknown[]) => mockHandleSearch(...args),
}));
vi.mock('../../../src/tools/crawl.js', () => ({
  handleCrawl: (...args: unknown[]) => mockHandleCrawl(...args),
}));

// Loopback bind by default so the target guard does not block localhost fixtures.
const SUBSYSTEMS = {
  searchEngines: [],
  router: {},
  backendStatus: {},
} as unknown as import('../../../src/server.js').Subsystems;

/** Fake IncomingMessage that emits a JSON body then ends. */
function fakeReq(method: string, body?: unknown): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage;
  (req as { method?: string }).method = method;
  (req as unknown as { pause: () => void }).pause = () => {};
  queueMicrotask(() => {
    if (body !== undefined) {
      req.emit('data', Buffer.from(JSON.stringify(body)));
    }
    req.emit('end');
  });
  return req;
}

interface Captured {
  status: number;
  body: unknown;
}

function makeCtx(subPath: string, bindIsLoopback = true): { ctx: import('../../../src/daemon/rest/firecrawl-compat.js').CompatContext; captured: Captured[] } {
  const captured: Captured[] = [];
  const ctx = {
    subsystems: SUBSYSTEMS,
    bindIsLoopback,
    subPath,
    respond: (status: number, respBody: unknown) => captured.push({ status, body: respBody }),
  };
  return { ctx, captured };
}

const FAKE_RES = {} as ServerResponse;

async function importShim() {
  return import('../../../src/daemon/rest/firecrawl-compat.js');
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.WIGOLO_SERVE_JOB_STORE_MAX_BYTES;
  delete process.env.WIGOLO_SERVE_MAX_COMPAT_JOBS;
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.WIGOLO_SERVE_MAX_COMPAT_JOBS;
});

describe('firecrawl-compat — scrape', () => {
  it('maps fetch output → {success:true, data:{markdown, metadata}}', async () => {
    mockHandleFetch.mockResolvedValue({
      ok: true,
      data: {
        url: 'https://example.com/',
        title: 'Example',
        markdown: '# Hello',
        metadata: { description: 'a page', language: 'en' },
        links: [],
        images: [],
        cached: false,
        http_status: 200,
        // wigolo-unique fields that must NOT leak into the compat shape:
        evidence: [{ excerpt: 'x', score: 0.9 }],
      },
    });
    const { handleCompatRequest } = await importShim();
    const { ctx, captured } = makeCtx('/v1/scrape');
    await handleCompatRequest(fakeReq('POST', { url: 'https://example.com/', formats: ['markdown'] }), FAKE_RES, ctx);

    expect(captured).toHaveLength(1);
    expect(captured[0].status).toBe(200);
    const body = captured[0].body as { success: boolean; data: { markdown: string; metadata: Record<string, unknown> } };
    expect(body.success).toBe(true);
    expect(body.data.markdown).toBe('# Hello');
    expect(body.data.metadata.sourceURL).toBe('https://example.com/');
    expect(body.data.metadata.title).toBe('Example');
    expect(body.data.metadata.statusCode).toBe(200);
  });

  it('does NOT leak wigolo-unique fields into the scrape response', async () => {
    mockHandleFetch.mockResolvedValue({
      ok: true,
      data: {
        url: 'https://example.com/',
        title: 'Example',
        markdown: 'body',
        metadata: {},
        links: [],
        images: [],
        cached: false,
        evidence: [{ excerpt: 'x', score: 0.9 }],
        fetch_method: 'http',
      },
    });
    const { handleCompatRequest } = await importShim();
    const { ctx, captured } = makeCtx('/v1/scrape');
    await handleCompatRequest(fakeReq('POST', { url: 'https://example.com/' }), FAKE_RES, ctx);
    const serialized = JSON.stringify(captured[0].body);
    expect(serialized).not.toContain('evidence');
    expect(serialized).not.toContain('evidence_score');
    expect(serialized).not.toContain('fetch_method');
    expect(serialized).not.toContain('query_understanding');
  });

  it('missing url → {success:false} 400', async () => {
    const { handleCompatRequest } = await importShim();
    const { ctx, captured } = makeCtx('/v1/scrape');
    await handleCompatRequest(fakeReq('POST', {}), FAKE_RES, ctx);
    expect(captured[0].status).toBe(400);
    expect((captured[0].body as { success: boolean }).success).toBe(false);
  });

  it('fetch StageResult failure → {success:false} with mapped status', async () => {
    mockHandleFetch.mockResolvedValue({
      ok: false,
      error: 'fetch_failed',
      error_reason: 'fetch_failed',
      stage: 'fetch',
      hint: 'try later',
    });
    const { handleCompatRequest } = await importShim();
    const { ctx, captured } = makeCtx('/v1/scrape');
    await handleCompatRequest(fakeReq('POST', { url: 'https://example.com/' }), FAKE_RES, ctx);
    expect(captured[0].status).toBe(502); // fetch-stage upstream → 502
    expect((captured[0].body as { success: boolean }).success).toBe(false);
  });
});

describe('firecrawl-compat — search', () => {
  it('maps search results → {success:true, data:{web:[{url,title,description}]}}', async () => {
    mockHandleSearch.mockResolvedValue({
      ok: true,
      data: {
        results: [
          { url: 'https://a.com', title: 'A', snippet: 'about A' },
          { url: 'https://b.com', title: 'B', snippet: 'about B' },
        ],
        query: 'q',
        engines_used: ['x'],
        total_time_ms: 10,
        evidence: [{ excerpt: 'x' }],
        query_understanding: { intent: 'general' },
      },
    });
    const { handleCompatRequest } = await importShim();
    const { ctx, captured } = makeCtx('/v1/search');
    await handleCompatRequest(fakeReq('POST', { query: 'q' }), FAKE_RES, ctx);
    expect(captured[0].status).toBe(200);
    const body = captured[0].body as { success: boolean; data: { web: Array<{ url: string; title: string; description: string }> } };
    expect(body.success).toBe(true);
    expect(body.data.web).toEqual([
      { url: 'https://a.com', title: 'A', description: 'about A' },
      { url: 'https://b.com', title: 'B', description: 'about B' },
    ]);
    // wigolo-unique fields absent
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('query_understanding');
    expect(serialized).not.toContain('engines_used');
  });

  it('limit caps result count (default 5)', async () => {
    const results = Array.from({ length: 12 }, (_, i) => ({ url: `https://x${i}.com`, title: `T${i}`, snippet: 's' }));
    mockHandleSearch.mockResolvedValue({
      ok: true,
      data: { results, query: 'q', engines_used: [], total_time_ms: 1 },
    });
    const { handleCompatRequest } = await importShim();
    const { ctx, captured } = makeCtx('/v1/search');
    await handleCompatRequest(fakeReq('POST', { query: 'q' }), FAKE_RES, ctx);
    const body = captured[0].body as { data: { web: unknown[] } };
    expect(body.data.web).toHaveLength(5);
  });

  it('limit over max (20) → 400 {success:false}', async () => {
    const { handleCompatRequest } = await importShim();
    const { ctx, captured } = makeCtx('/v1/search');
    await handleCompatRequest(fakeReq('POST', { query: 'q', limit: 100 }), FAKE_RES, ctx);
    expect(captured[0].status).toBe(400);
    expect((captured[0].body as { success: boolean }).success).toBe(false);
    expect((captured[0].body as { error: string }).error).toMatch(/cap/i);
  });

  it('search data.error (all engines failed) → 500 {success:false}', async () => {
    mockHandleSearch.mockResolvedValue({
      ok: true,
      data: { results: [], query: 'q', engines_used: [], total_time_ms: 1, error: 'all engines failed' },
    });
    const { handleCompatRequest } = await importShim();
    const { ctx, captured } = makeCtx('/v1/search');
    await handleCompatRequest(fakeReq('POST', { query: 'q' }), FAKE_RES, ctx);
    expect(captured[0].status).toBe(500);
    expect((captured[0].body as { success: boolean }).success).toBe(false);
  });
});

describe('firecrawl-compat — map', () => {
  it('maps crawl(map) output → {success:true, data:{links:[…]}}', async () => {
    mockHandleCrawl.mockResolvedValue({
      urls: ['https://a.com/1', 'https://a.com/2'],
      total_found: 2,
      sitemap_found: true,
      crawled: 0,
    });
    const { handleCompatRequest } = await importShim();
    const { ctx, captured } = makeCtx('/v1/map');
    await handleCompatRequest(fakeReq('POST', { url: 'https://a.com' }), FAKE_RES, ctx);
    expect(captured[0].status).toBe(200);
    const body = captured[0].body as { success: boolean; data: { links: string[] } };
    expect(body.success).toBe(true);
    expect(body.data.links).toEqual(['https://a.com/1', 'https://a.com/2']);
    // passes strategy:'map' to the handler
    expect(mockHandleCrawl).toHaveBeenCalledWith(expect.objectContaining({ strategy: 'map' }), expect.anything());
  });

  it('map limit over 200 → 400 {success:false}', async () => {
    const { handleCompatRequest } = await importShim();
    const { ctx, captured } = makeCtx('/v1/map');
    await handleCompatRequest(fakeReq('POST', { url: 'https://a.com', limit: 5000 }), FAKE_RES, ctx);
    expect(captured[0].status).toBe(400);
    expect((captured[0].body as { error: string }).error).toMatch(/cap|200/i);
    expect(mockHandleCrawl).not.toHaveBeenCalled();
  });

  it('map in-band SSRF error → 400 {success:false}', async () => {
    mockHandleCrawl.mockResolvedValue({
      urls: [],
      total_found: 0,
      sitemap_found: false,
      crawled: 0,
      error: 'ssrf_private_target',
    });
    const { handleCompatRequest } = await importShim();
    const { ctx, captured } = makeCtx('/v1/map');
    await handleCompatRequest(fakeReq('POST', { url: 'https://a.com' }), FAKE_RES, ctx);
    expect(captured[0].status).toBe(400);
  });
});

describe('firecrawl-compat — crawl job lifecycle', () => {
  it('POST crawl → {success:true, id}; GET reaches completed with data', async () => {
    let resolveCrawl!: (v: unknown) => void;
    mockHandleCrawl.mockReturnValue(new Promise((res) => { resolveCrawl = res; }));

    const { handleCompatRequest } = await importShim();
    const start = makeCtx('/v1/crawl');
    await handleCompatRequest(fakeReq('POST', { url: 'https://a.com', limit: 2 }), FAKE_RES, start.ctx);
    expect(start.captured[0].status).toBe(200);
    const startBody = start.captured[0].body as { success: boolean; id: string };
    expect(startBody.success).toBe(true);
    expect(typeof startBody.id).toBe('string');
    const id = startBody.id;

    // Before the crawl settles → scraping
    const poll1 = makeCtx(`/v1/crawl/${id}`);
    await handleCompatRequest(fakeReq('GET'), FAKE_RES, poll1.ctx);
    expect((poll1.captured[0].body as { status: string }).status).toBe('scraping');

    // Settle the crawl
    resolveCrawl({
      pages: [{ url: 'https://a.com/1', title: 'p1', markdown: 'body1', depth: 0 }],
      total_found: 1,
      crawled: 1,
    });
    await new Promise((r) => setTimeout(r, 0));

    const poll2 = makeCtx(`/v1/crawl/${id}`);
    await handleCompatRequest(fakeReq('GET'), FAKE_RES, poll2.ctx);
    const done = poll2.captured[0].body as { status: string; data: Array<{ markdown: string; metadata: { sourceURL: string } }> };
    expect(done.status).toBe('completed');
    expect(done.data).toEqual([{ markdown: 'body1', metadata: { sourceURL: 'https://a.com/1' } }]);
  });

  it('failed crawl (in-band error) → status failed', async () => {
    mockHandleCrawl.mockResolvedValue({ pages: [], total_found: 0, crawled: 0, error: 'boom' });
    const { handleCompatRequest } = await importShim();
    const start = makeCtx('/v1/crawl');
    await handleCompatRequest(fakeReq('POST', { url: 'https://a.com' }), FAKE_RES, start.ctx);
    const id = (start.captured[0].body as { id: string }).id;
    await new Promise((r) => setTimeout(r, 0));

    const poll = makeCtx(`/v1/crawl/${id}`);
    await handleCompatRequest(fakeReq('GET'), FAKE_RES, poll.ctx);
    expect((poll.captured[0].body as { status: string }).status).toBe('failed');
  });

  it('GET crawl/{unknown-id} → 404 {success:false}', async () => {
    const { handleCompatRequest } = await importShim();
    const poll = makeCtx('/v1/crawl/does-not-exist');
    await handleCompatRequest(fakeReq('GET'), FAKE_RES, poll.ctx);
    expect(poll.captured[0].status).toBe(404);
    expect((poll.captured[0].body as { success: boolean }).success).toBe(false);
  });

  it('crawl limit over 200 → 400, no job created', async () => {
    const { handleCompatRequest } = await importShim();
    const start = makeCtx('/v1/crawl');
    await handleCompatRequest(fakeReq('POST', { url: 'https://a.com', limit: 9999 }), FAKE_RES, start.ctx);
    expect(start.captured[0].status).toBe(400);
    expect(mockHandleCrawl).not.toHaveBeenCalled();
  });
});

describe('firecrawl-compat — concurrent running-jobs cap', () => {
  /** Start a crawl POST whose handleCrawl promise stays pending until resolved. */
  function pendingCrawl(): { resolve: () => void } {
    let resolveFn!: (v: unknown) => void;
    mockHandleCrawl.mockReturnValueOnce(new Promise((res) => { resolveFn = res; }));
    return {
      resolve: () => resolveFn({ pages: [], total_found: 0, crawled: 0 }),
    };
  }

  async function postCrawl(handleCompatRequest: typeof import('../../../src/daemon/rest/firecrawl-compat.js').handleCompatRequest): Promise<Captured> {
    const { ctx, captured } = makeCtx('/v1/crawl');
    await handleCompatRequest(fakeReq('POST', { url: 'https://a.com' }), FAKE_RES, ctx);
    return captured[0];
  }

  it('16 running (default cap) → 17th POST 429 {success:false}; settling frees capacity', async () => {
    const { handleCompatRequest } = await importShim();
    const resolvers: Array<{ resolve: () => void }> = [];
    for (let i = 0; i < 16; i++) {
      resolvers.push(pendingCrawl());
      const r = await postCrawl(handleCompatRequest);
      expect(r.status).toBe(200);
    }

    // 17th over the cap → 429, refused (not queued), no job started.
    const over = await postCrawl(handleCompatRequest);
    expect(over.status).toBe(429);
    expect((over.body as { success: boolean }).success).toBe(false);
    expect((over.body as { error: string }).error).toMatch(/WIGOLO_SERVE_MAX_COMPAT_JOBS|16/);
    expect(mockHandleCrawl).toHaveBeenCalledTimes(16);

    // A job settling frees capacity: resolve one, next POST succeeds.
    resolvers[0].resolve();
    await new Promise((r) => setTimeout(r, 0));
    const freed = pendingCrawl();
    const next = await postCrawl(handleCompatRequest);
    expect(next.status).toBe(200);

    // Drain all pending crawls so the counter is 0 for later tests.
    for (let i = 1; i < 16; i++) resolvers[i].resolve();
    freed.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });

  it('env override WIGOLO_SERVE_MAX_COMPAT_JOBS is honored', async () => {
    process.env.WIGOLO_SERVE_MAX_COMPAT_JOBS = '1';
    const { handleCompatRequest } = await importShim();
    const first = pendingCrawl();
    const r1 = await postCrawl(handleCompatRequest);
    expect(r1.status).toBe(200);

    const r2 = await postCrawl(handleCompatRequest);
    expect(r2.status).toBe(429);
    expect((r2.body as { success: boolean }).success).toBe(false);

    // Settle → capacity frees under the override too.
    first.resolve();
    await new Promise((r) => setTimeout(r, 0));
    const second = pendingCrawl();
    const r3 = await postCrawl(handleCompatRequest);
    expect(r3.status).toBe(200);
    second.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });

  it('429 refusal carries Retry-After header when the respond seam gets headers', async () => {
    process.env.WIGOLO_SERVE_MAX_COMPAT_JOBS = '1';
    const { handleCompatRequest } = await importShim();
    const first = pendingCrawl();
    await postCrawl(handleCompatRequest);

    const headersCaptured: Array<Record<string, string> | undefined> = [];
    const ctx = {
      subsystems: SUBSYSTEMS,
      bindIsLoopback: true,
      subPath: '/v1/crawl',
      respond: (_status: number, _body: unknown, headers?: Record<string, string>) => headersCaptured.push(headers),
    };
    await handleCompatRequest(fakeReq('POST', { url: 'https://a.com' }), FAKE_RES, ctx);
    expect(headersCaptured[0]).toEqual({ 'Retry-After': '5' });

    first.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });

  it('a crawl that rejects also frees capacity', async () => {
    process.env.WIGOLO_SERVE_MAX_COMPAT_JOBS = '1';
    const { handleCompatRequest } = await importShim();
    let rejectFn!: (e: Error) => void;
    mockHandleCrawl.mockReturnValueOnce(new Promise((_res, rej) => { rejectFn = rej; }));
    const r1 = await postCrawl(handleCompatRequest);
    expect(r1.status).toBe(200);

    rejectFn(new Error('boom'));
    await new Promise((r) => setTimeout(r, 0));

    const next = pendingCrawl();
    const r2 = await postCrawl(handleCompatRequest);
    expect(r2.status).toBe(200);
    next.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
});

describe('firecrawl-compat — SSRF parity', () => {
  it('loopback-target scrape under a non-loopback bind → 400 {success:false}', async () => {
    const { handleCompatRequest } = await importShim();
    const { ctx, captured } = makeCtx('/v1/scrape', /* bindIsLoopback */ false);
    await handleCompatRequest(fakeReq('POST', { url: 'http://127.0.0.1:8080/' }), FAKE_RES, ctx);
    expect(captured[0].status).toBe(400);
    expect((captured[0].body as { success: boolean }).success).toBe(false);
    expect(mockHandleFetch).not.toHaveBeenCalled();
  });

  it('metadata-target scrape refused in all modes → 400', async () => {
    const { handleCompatRequest } = await importShim();
    const { ctx, captured } = makeCtx('/v1/scrape', /* bindIsLoopback */ true);
    await handleCompatRequest(fakeReq('POST', { url: 'http://169.254.169.254/latest/meta-data/' }), FAKE_RES, ctx);
    expect(captured[0].status).toBe(400);
    expect(mockHandleFetch).not.toHaveBeenCalled();
  });
});

describe('firecrawl-compat — method + unknown route guards', () => {
  it('unknown shim subpath → 404', async () => {
    const { handleCompatRequest } = await importShim();
    const { ctx, captured } = makeCtx('/v1/nope');
    await handleCompatRequest(fakeReq('POST', {}), FAKE_RES, ctx);
    expect(captured[0].status).toBe(404);
  });

  it('POST to a status route → 405', async () => {
    const { handleCompatRequest } = await importShim();
    const { ctx, captured } = makeCtx('/v1/crawl/some-id');
    await handleCompatRequest(fakeReq('POST', {}), FAKE_RES, ctx);
    expect(captured[0].status).toBe(405);
  });

  it('GET to scrape → 405', async () => {
    const { handleCompatRequest } = await importShim();
    const { ctx, captured } = makeCtx('/v1/scrape');
    await handleCompatRequest(fakeReq('GET'), FAKE_RES, ctx);
    expect(captured[0].status).toBe(405);
  });
});

describe('CrawlJobStore — bounds', () => {
  it('count LRU: evicts oldest past the 100-entry cap', async () => {
    const { CrawlJobStore } = await importShim();
    const store = new CrawlJobStore();
    const first = store.create();
    for (let i = 0; i < 100; i++) store.create();
    // 101 created total; oldest (first) evicted, size capped at 100.
    expect(store.size).toBe(100);
    expect(store.get(first.id)).toBeUndefined();
  });

  it('byte-pressure eviction evicts oldest (not just count)', async () => {
    process.env.WIGOLO_SERVE_JOB_STORE_MAX_BYTES = '2000';
    const { CrawlJobStore } = await importShim();
    const store = new CrawlJobStore();
    const oldest = store.create();
    const big = 'x'.repeat(1500);
    store.settle(oldest, {
      status: 'completed',
      data: [{ markdown: big, metadata: { sourceURL: 'https://a.com' } }],
    });
    const newer = store.create();
    // Settle the newer with another big payload → total exceeds 2000 bytes →
    // the oldest is evicted under byte pressure even though count is 2 << 100.
    store.settle(newer, {
      status: 'completed',
      data: [{ markdown: big, metadata: { sourceURL: 'https://b.com' } }],
    });
    expect(store.get(oldest.id)).toBeUndefined();
    expect(store.get(newer.id)).toBeDefined();
  });

  it('TTL expiry: completed jobs vanish after 30 min', async () => {
    vi.useFakeTimers();
    const { CrawlJobStore } = await importShim();
    const store = new CrawlJobStore();
    const job = store.create();
    store.settle(job, { status: 'completed', data: [] });
    expect(store.get(job.id)).toBeDefined();
    vi.advanceTimersByTime(31 * 60 * 1000);
    expect(store.get(job.id)).toBeUndefined();
  });

  it('TTL does not expire a still-scraping job', async () => {
    vi.useFakeTimers();
    const { CrawlJobStore } = await importShim();
    const store = new CrawlJobStore();
    const job = store.create();
    vi.advanceTimersByTime(60 * 60 * 1000);
    // Never settled → no settledAt → not TTL-eligible.
    expect(store.get(job.id)).toBeDefined();
  });
});
