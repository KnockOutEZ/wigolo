import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RawSearchResult } from '../../../../src/types.js';

// fetchContentForResults mock — hoisted (vi.mock is statically hoisted)
const mockFetchContent = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../../../../src/search/content-fetch.js', () => ({
  fetchContentForResults: mockFetchContent,
}));

const runV1Search = vi.fn();
vi.mock('../../../../src/search/core/orchestrator.js', () => ({ runV1Search }));

const { CoreSearchProvider } = await import('../../../../src/search/core/core-provider.js');

function dispatch(url: string): { results: RawSearchResult[]; enginesUsed: string[]; outcomes: []; degraded: boolean } {
  return {
    results: [{ title: url, url, snippet: 's', relevance_score: 1, engine: 'e1' }],
    enginesUsed: ['e1'], outcomes: [], degraded: false,
  };
}

// A minimal router stub so include_content runs (core-provider gates on ctx.router)
const stubRouter = { fetch: vi.fn() } as never;

// Records the ORDER of prewarm vs enrichment so we can prove prewarm fires
// before fetchContentForResults (so enrichment fetches don't pay cold start).
const callOrder: string[] = [];
const prewarmSpy = vi.fn(async () => { callOrder.push('prewarm'); });

// Router stub that also exposes prewarmBrowser (the browser-pool warm seam).
const warmableRouter = { fetch: vi.fn(), prewarmBrowser: prewarmSpy } as never;

describe('core-provider tier budget wiring', () => {
  beforeEach(() => {
    runV1Search.mockReset();
    mockFetchContent.mockReset();
    callOrder.length = 0;
    prewarmSpy.mockClear();
    mockFetchContent.mockImplementation(async () => { callOrder.push('fetch'); });
  });

  it('balanced depth passes fetchTimeoutMs=3000 and stageBudgetMs=4000 to fetchContentForResults', async () => {
    runV1Search.mockResolvedValue(dispatch('https://a.com'));
    const provider = new CoreSearchProvider();
    await provider.search(
      { query: 'hello world', search_depth: 'balanced', include_content: true },
      { router: stubRouter } as never,
    );
    expect(mockFetchContent).toHaveBeenCalledOnce();
    const ctx = mockFetchContent.mock.calls[0][2] as Record<string, unknown>;
    expect(ctx.fetchTimeoutMs).toBe(3000);
    expect(ctx.stageBudgetMs).toBe(4000);
  });

  it('deep depth passes fetchTimeoutMs=8000 and stageBudgetMs=10000 to fetchContentForResults', async () => {
    runV1Search.mockResolvedValue(dispatch('https://b.com'));
    const provider = new CoreSearchProvider();
    await provider.search(
      { query: 'hello world', search_depth: 'deep', include_content: true },
      { router: stubRouter } as never,
    );
    expect(mockFetchContent).toHaveBeenCalledOnce();
    const ctx = mockFetchContent.mock.calls[0][2] as Record<string, unknown>;
    expect(ctx.fetchTimeoutMs).toBe(8000);
    expect(ctx.stageBudgetMs).toBe(10000);
  });

  it('fast depth skips fetchContentForResults entirely', async () => {
    runV1Search.mockResolvedValue(dispatch('https://c.com'));
    const provider = new CoreSearchProvider();
    await provider.search(
      { query: 'hello world', search_depth: 'fast', include_content: true },
      { router: stubRouter } as never,
    );
    expect(mockFetchContent).not.toHaveBeenCalled();
  });

  // --- S4: browser pool pre-warm before enrichment ---
  //
  // WHY: the browser pool lazily launches on first acquire, so the first
  // enrichment fetch pays the browser cold-start (~5-8s) inline. Pre-warming it
  // BEFORE the enrichment await moves that cost off the critical per-fetch path.
  it('pre-warms the browser pool BEFORE fetchContentForResults on balanced depth with include_content', async () => {
    runV1Search.mockResolvedValue(dispatch('https://a.com'));
    const provider = new CoreSearchProvider();
    await provider.search(
      { query: 'hello world', search_depth: 'balanced', include_content: true },
      { router: warmableRouter } as never,
    );
    expect(prewarmSpy).toHaveBeenCalledOnce();
    expect(mockFetchContent).toHaveBeenCalledOnce();
    // Prewarm must land before enrichment.
    expect(callOrder).toEqual(['prewarm', 'fetch']);
  });

  it('pre-warms the browser pool on deep depth too', async () => {
    runV1Search.mockResolvedValue(dispatch('https://a.com'));
    const provider = new CoreSearchProvider();
    await provider.search(
      { query: 'hello world', search_depth: 'deep', include_content: true },
      { router: warmableRouter } as never,
    );
    expect(prewarmSpy).toHaveBeenCalledOnce();
    expect(callOrder[0]).toBe('prewarm');
  });

  it('does NOT pre-warm on fast depth (no enrichment) or when include_content is false', async () => {
    runV1Search.mockResolvedValue(dispatch('https://a.com'));
    const provider = new CoreSearchProvider();
    await provider.search(
      { query: 'hello world', search_depth: 'fast', include_content: true },
      { router: warmableRouter } as never,
    );
    await provider.search(
      { query: 'hello world', search_depth: 'balanced', include_content: false },
      { router: warmableRouter } as never,
    );
    expect(prewarmSpy).not.toHaveBeenCalled();
  });

  it('passes candidateCount + narrowSetBudgetMs into the fetch context (narrow-set scaling seam)', async () => {
    runV1Search.mockResolvedValue(dispatch('https://a.com'));
    const provider = new CoreSearchProvider();
    await provider.search(
      { query: 'hello world', search_depth: 'balanced', include_content: true },
      { router: warmableRouter } as never,
    );
    const ctx = mockFetchContent.mock.calls[0][2] as Record<string, unknown>;
    // One result dispatched → candidateCount should reflect the fetched set size.
    expect(ctx.candidateCount).toBe(1);
    expect(typeof ctx.narrowSetBudgetMs).toBe('number');
    // Snippet fallback is enabled on the search path.
    expect(ctx.snippetFallback).toBe(true);
  });

  // --- Narrow-set browser-render escalation wiring ---
  //
  // WHY: a domain-narrowed (include_domains) search over JS-heavy documentation
  // SPAs needs the browser-render path to recover real content. The provider
  // threads renderNarrowSet ONLY when include_domains is present, so broad
  // searches keep the fast auto path. The narrow BOUND itself
  // (candidateCount <= maxCandidates) lives in the fetcher, not here.
  it('threads renderNarrowSet into the fetch context when include_domains is present', async () => {
    runV1Search.mockResolvedValue(dispatch('https://docs.example.com/x'));
    const provider = new CoreSearchProvider();
    await provider.search(
      { query: 'hooks', search_depth: 'balanced', include_content: true, include_domains: ['docs.example.com'] },
      { router: warmableRouter } as never,
    );
    const ctx = mockFetchContent.mock.calls[0][2] as Record<string, unknown>;
    expect(ctx.renderNarrowSet).toEqual({ maxCandidates: 3 });
  });

  it('does NOT thread renderNarrowSet for a broad (no include_domains) search — fast path unchanged', async () => {
    runV1Search.mockResolvedValue(dispatch('https://a.com'));
    const provider = new CoreSearchProvider();
    await provider.search(
      { query: 'hello world', search_depth: 'balanced', include_content: true },
      { router: warmableRouter } as never,
    );
    const ctx = mockFetchContent.mock.calls[0][2] as Record<string, unknown>;
    expect(ctx.renderNarrowSet).toBeUndefined();
  });

  it('does not throw when the router has no prewarmBrowser method (back-compat)', async () => {
    runV1Search.mockResolvedValue(dispatch('https://a.com'));
    const provider = new CoreSearchProvider();
    await expect(
      provider.search(
        { query: 'hello world', search_depth: 'balanced', include_content: true },
        { router: stubRouter } as never,
      ),
    ).resolves.toBeDefined();
    expect(mockFetchContent).toHaveBeenCalledOnce();
  });
});
