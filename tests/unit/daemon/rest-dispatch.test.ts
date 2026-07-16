import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dispatchTool, type DispatchContext } from '../../../src/daemon/rest/dispatch.js';
import type { Subsystems } from '../../../src/server.js';

vi.mock('../../../src/tools/fetch.js', () => ({
  handleFetch: vi.fn(),
}));
vi.mock('../../../src/tools/search.js', () => ({
  handleSearch: vi.fn(),
}));
vi.mock('../../../src/tools/crawl.js', () => ({ handleCrawl: vi.fn() }));
vi.mock('../../../src/tools/cache.js', () => ({ handleCache: vi.fn() }));
vi.mock('../../../src/tools/extract.js', () => ({ handleExtract: vi.fn() }));
vi.mock('../../../src/tools/find-similar.js', () => ({ handleFindSimilar: vi.fn() }));
vi.mock('../../../src/tools/research.js', () => ({ handleResearch: vi.fn() }));
vi.mock('../../../src/tools/agent.js', () => ({ handleAgent: vi.fn() }));
vi.mock('../../../src/tools/diff.js', () => ({ handleDiff: vi.fn() }));
vi.mock('../../../src/tools/watch.js', () => ({ handleWatch: vi.fn() }));
vi.mock('../../../src/watch/scheduler.js', () => ({
  scheduleOverdueCheck: vi.fn(),
}));

import { handleFetch } from '../../../src/tools/fetch.js';
import { handleSearch } from '../../../src/tools/search.js';
import { handleCrawl } from '../../../src/tools/crawl.js';
import { handleCache } from '../../../src/tools/cache.js';
import { handleExtract } from '../../../src/tools/extract.js';
import { handleFindSimilar } from '../../../src/tools/find-similar.js';
import { handleResearch } from '../../../src/tools/research.js';
import { handleAgent } from '../../../src/tools/agent.js';
import { handleDiff } from '../../../src/tools/diff.js';
import { handleWatch } from '../../../src/tools/watch.js';
import { scheduleOverdueCheck } from '../../../src/watch/scheduler.js';

beforeEach(() => {
  vi.clearAllMocks();
});

function fakeCtx(): DispatchContext {
  return {
    subsystems: {
      searchEngines: [],
      router: {} as unknown,
      backendStatus: {} as unknown,
    } as unknown as Subsystems,
    bindIsLoopback: true,
  };
}

describe('dispatchTool — fetch', () => {
  it('success returns r.data as plain JSON (200)', async () => {
    vi.mocked(handleFetch).mockResolvedValue({ ok: true, data: { url: 'https://x.com', markdown: 'hi' } } as never);
    const r = await dispatchTool('fetch', { url: 'https://x.com' }, fakeCtx());
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ url: 'https://x.com', markdown: 'hi' });
  });

  it('failure maps via errors.ts status table (fetch upstream → 502)', async () => {
    vi.mocked(handleFetch).mockResolvedValue({
      ok: false, error: 'blocked', error_reason: 'blocked_by_challenge', stage: 'fetch',
    } as never);
    const r = await dispatchTool('fetch', { url: 'https://x.com' }, fakeCtx());
    expect(r.status).toBe(502);
    expect((r.body as { ok: boolean }).ok).toBe(false);
  });

  it('applies the serve-mode target guard before dispatch (non-loopback bind, loopback target → 400)', async () => {
    const ctx = fakeCtx();
    ctx.bindIsLoopback = false;
    const r = await dispatchTool('fetch', { url: 'http://127.0.0.1/' }, ctx);
    expect(r.status).toBe(400);
    expect(handleFetch).not.toHaveBeenCalled();
  });

  it('schedules the overdue watch check on a non-watch call', async () => {
    vi.mocked(handleFetch).mockResolvedValue({ ok: true, data: {} } as never);
    await dispatchTool('fetch', { url: 'https://x.com' }, fakeCtx());
    expect(scheduleOverdueCheck).toHaveBeenCalled();
  });
});

describe('dispatchTool — search', () => {
  it('success returns r.data as plain JSON (200)', async () => {
    vi.mocked(handleSearch).mockResolvedValue({ ok: true, data: { results: [], evidence_score: 1 } } as never);
    const r = await dispatchTool('search', { query: 'x' }, fakeCtx());
    expect(r.status).toBe(200);
    expect((r.body as { evidence_score: number }).evidence_score).toBe(1);
  });

  it('ok:true with data.error → mapped as failure (500)', async () => {
    vi.mocked(handleSearch).mockResolvedValue({ ok: true, data: { error: 'all engines failed' } } as never);
    const r = await dispatchTool('search', { query: 'x' }, fakeCtx());
    expect(r.status).toBe(500);
  });

  it('warning-only search result stays 200', async () => {
    vi.mocked(handleSearch).mockResolvedValue({ ok: true, data: { results: [], warning: 'degraded' } } as never);
    const r = await dispatchTool('search', { query: 'x' }, fakeCtx());
    expect(r.status).toBe(200);
  });
});

describe('dispatchTool — the 8 filled tools return plain JSON on success', () => {
  it('crawl success → 200 with the plain output object', async () => {
    vi.mocked(handleCrawl).mockResolvedValue({ pages: [], total_found: 0, crawled: 0 } as never);
    const r = await dispatchTool('crawl', { url: 'https://x.com' }, fakeCtx());
    expect(r.status).toBe(200);
    expect((r.body as { pages: unknown[] }).pages).toEqual([]);
  });

  it('crawl in-band ssrf error → 400 (shape adapter)', async () => {
    vi.mocked(handleCrawl).mockResolvedValue({ pages: [], total_found: 0, crawled: 0, error: 'ssrf_private_target' } as never);
    const r = await dispatchTool('crawl', { url: 'https://x.com' }, fakeCtx());
    expect(r.status).toBe(400);
  });

  it('crawl in-band free-text error → 500 (no substring matching)', async () => {
    vi.mocked(handleCrawl).mockResolvedValue({ pages: [], total_found: 0, crawled: 0, error: 'a timeout happened while crawling' } as never);
    const r = await dispatchTool('crawl', { url: 'https://x.com' }, fakeCtx());
    expect(r.status).toBe(500);
  });

  it('cache success → 200 with results[]', async () => {
    vi.mocked(handleCache).mockResolvedValue({ results: [] } as never);
    const r = await dispatchTool('cache', { query: 'x' }, fakeCtx());
    expect(r.status).toBe(200);
    expect((r.body as { results: unknown[] }).results).toEqual([]);
  });

  it('extract success → 200 with data', async () => {
    vi.mocked(handleExtract).mockResolvedValue({ ok: true, data: { data: {}, mode: 'metadata' } } as never);
    const r = await dispatchTool('extract', { html: '<p>x</p>', mode: 'metadata' }, fakeCtx());
    expect(r.status).toBe(200);
    expect((r.body as { mode: string }).mode).toBe('metadata');
  });

  it('find_similar success → 200 with results[]', async () => {
    vi.mocked(handleFindSimilar).mockResolvedValue({ ok: true, data: { results: [] } } as never);
    const r = await dispatchTool('find_similar', { concept: 'x' }, fakeCtx());
    expect(r.status).toBe(200);
    expect((r.body as { results: unknown[] }).results).toEqual([]);
  });

  it('research success → 200 with brief', async () => {
    vi.mocked(handleResearch).mockResolvedValue({ ok: true, data: { brief: { topics: [] } } } as never);
    const r = await dispatchTool('research', { question: 'x' }, fakeCtx());
    expect(r.status).toBe(200);
    expect((r.body as { brief: { topics: unknown[] } }).brief.topics).toEqual([]);
  });

  it('agent success → 200 with steps[]', async () => {
    vi.mocked(handleAgent).mockResolvedValue({ ok: true, data: { steps: [] } } as never);
    const r = await dispatchTool('agent', { prompt: 'x' }, fakeCtx());
    expect(r.status).toBe(200);
    expect((r.body as { steps: unknown[] }).steps).toEqual([]);
  });

  it('diff success → 200 with the diff output', async () => {
    vi.mocked(handleDiff).mockResolvedValue({ ok: true, data: { changed: true } } as never);
    const r = await dispatchTool('diff', { old: { markdown: 'a' }, new: { markdown: 'b' } }, fakeCtx());
    expect(r.status).toBe(200);
    expect((r.body as { changed: boolean }).changed).toBe(true);
  });

  it('watch success → 200 with jobs[]', async () => {
    vi.mocked(handleWatch).mockResolvedValue({ ok: true, data: { jobs: [] } } as never);
    const r = await dispatchTool('watch', { action: 'list' }, fakeCtx());
    expect(r.status).toBe(200);
    expect((r.body as { jobs: unknown[] }).jobs).toEqual([]);
  });

  it('watch does NOT schedule the overdue check (it IS the watch path)', async () => {
    vi.mocked(handleWatch).mockResolvedValue({ ok: true, data: { jobs: [] } } as never);
    await dispatchTool('watch', { action: 'list' }, fakeCtx());
    expect(scheduleOverdueCheck).not.toHaveBeenCalled();
  });
});

describe('dispatchTool — URL-bearing routes run the serve-mode target guard', () => {
  it('crawl loopback target under non-loopback bind → 400 (guard, no handler call)', async () => {
    const ctx = fakeCtx();
    ctx.bindIsLoopback = false;
    const r = await dispatchTool('crawl', { url: 'http://127.0.0.1/' }, ctx);
    expect(r.status).toBe(400);
    expect(handleCrawl).not.toHaveBeenCalled();
  });

  it('extract with no url skips the guard (inline-html extraction)', async () => {
    const ctx = fakeCtx();
    ctx.bindIsLoopback = false;
    vi.mocked(handleExtract).mockResolvedValue({ ok: true, data: { data: {}, mode: 'tables' } } as never);
    const r = await dispatchTool('extract', { html: '<table></table>', mode: 'tables' }, ctx);
    expect(r.status).toBe(200);
    expect(handleExtract).toHaveBeenCalled();
  });

  it('agent guards every url in urls[] (metadata → 400, no handler call)', async () => {
    const ctx = fakeCtx();
    const r = await dispatchTool('agent', { prompt: 'x', urls: ['http://169.254.169.254/'] }, ctx);
    expect(r.status).toBe(400);
    expect(handleAgent).not.toHaveBeenCalled();
  });

  it('an unknown tool still returns 501 not_implemented', async () => {
    const r = await dispatchTool('bogus', {}, fakeCtx());
    expect(r.status).toBe(501);
    expect((r.body as { error_reason: string }).error_reason).toBe('not_implemented');
  });
});
