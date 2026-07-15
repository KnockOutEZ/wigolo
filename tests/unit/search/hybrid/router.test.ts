import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HybridSearchProvider } from '../../../../src/search/hybrid/router.js';
import type {
  SearchProvider,
  SearchContext,
} from '../../../../src/providers/search-provider.js';
import type {
  SearchInput,
  SearchOutput,
  SearchResultItem,
  StageResult,
} from '../../../../src/types.js';

function makeResult(
  title: string,
  url: string,
  score = 0.5,
): SearchResultItem {
  return { title, url, snippet: '', relevance_score: score };
}

function ok(out: Partial<SearchOutput>): StageResult<SearchOutput> {
  return {
    ok: true,
    data: {
      results: [],
      query: 'q',
      engines_used: [],
      total_time_ms: 0,
      ...out,
    },
  };
}

function fail(reason: string): StageResult<SearchOutput> {
  return {
    ok: false,
    error: 'engine_failed',
    error_reason: reason,
    stage: 'search',
  };
}

function makeContext(): SearchContext {
  return {
    engines: [],
    router: {} as SearchContext['router'],
  };
}

interface MockProvider extends SearchProvider {
  search: ReturnType<typeof vi.fn>;
}

function mockProvider(
  name: 'core' | 'searxng',
  impl: (input: SearchInput) => StageResult<SearchOutput> | Promise<StageResult<SearchOutput>>,
): MockProvider {
  return {
    name,
    search: vi.fn(async (input: SearchInput) => impl(input)),
  } as MockProvider;
}

describe('HybridSearchProvider', () => {
  let ctx: SearchContext;

  beforeEach(() => {
    ctx = makeContext();
  });

  it('has name "hybrid"', () => {
    const core = mockProvider('core', () => ok({ results: [] }));
    const sx = mockProvider('searxng', () => ok({ results: [] }));
    const hybrid = new HybridSearchProvider(core, sx);
    expect(hybrid.name).toBe('hybrid');
  });

  it('returns core results unchanged when no signal fires', async () => {
    const coreOut: SearchOutput = {
      results: [
        makeResult('Kubernetes Operators', 'https://kubernetes.io/operators', 0.8),
        makeResult('Operator Framework', 'https://operatorframework.io/', 0.7),
        makeResult('OpenShift Operators', 'https://openshift.com/operators', 0.6),
      ],
      query: 'kubernetes operator',
      engines_used: ['bing', 'ddg'],
      total_time_ms: 100,
    };
    const core = mockProvider('core', () => ({ ok: true, data: coreOut }));
    const sx = mockProvider('searxng', () => ok({ results: [makeResult('x', 'https://x.com/')] }));
    const hybrid = new HybridSearchProvider(core, sx);

    const out = await hybrid.search(
      { query: 'kubernetes operator' },
      ctx,
    );

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(sx.search).not.toHaveBeenCalled();
    expect(out.data.results.map((r) => r.url)).toEqual(
      coreOut.results.map((r) => r.url),
    );
  });

  it('runs searxng and merges when a signal fires (include_domains over-filter)', async () => {
    const core = mockProvider('core', () =>
      ok({
        results: [makeResult('only-one', 'https://example.com/a', 0.8)],
        engines_used: ['bing'],
      }),
    );
    const sx = mockProvider('searxng', () =>
      ok({
        results: [
          makeResult('two', 'https://example.com/b', 0.7),
          makeResult('three', 'https://example.com/c', 0.6),
        ],
        engines_used: ['searxng:google'],
      }),
    );
    const hybrid = new HybridSearchProvider(core, sx);

    const out = await hybrid.search(
      { query: 'q', include_domains: ['example.com'] },
      ctx,
    );

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(sx.search).toHaveBeenCalledTimes(1);
    expect(out.data.results.length).toBeGreaterThan(1);
    expect(new Set(out.data.engines_used)).toEqual(
      new Set(['bing', 'searxng:google']),
    );
  });

  it('only runs searxng once even when multiple signals fire', async () => {
    const core = mockProvider('core', () =>
      ok({
        results: [
          makeResult(
            'Next | Online Shopping Clothes Shoes Bags',
            'https://next.co.uk/',
            1.0,
          ),
        ],
        engines_used: ['bing'],
      }),
    );
    const sx = mockProvider('searxng', () =>
      ok({
        results: [makeResult('Next.js', 'https://nextjs.org/', 0.9)],
        engines_used: ['searxng:google'],
      }),
    );
    const hybrid = new HybridSearchProvider(core, sx);

    const out = await hybrid.search(
      { query: 'next', include_domains: ['next.co.uk'] },
      ctx,
    );

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(sx.search).toHaveBeenCalledTimes(1);
    expect(core.search).toHaveBeenCalledTimes(1);
  });

  it('propagates core error when core fails', async () => {
    const core = mockProvider('core', () => fail('core blew up'));
    const sx = mockProvider('searxng', () => ok({ results: [] }));
    const hybrid = new HybridSearchProvider(core, sx);

    const out = await hybrid.search({ query: 'next' }, ctx);

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error_reason).toContain('core blew up');
    expect(sx.search).not.toHaveBeenCalled();
  });

  it('returns core result when signal fires but searxng fails', async () => {
    const coreOut: SearchOutput = {
      results: [makeResult('only', 'https://example.com/a', 0.8)],
      query: 'q',
      engines_used: ['bing'],
      total_time_ms: 100,
    };
    const core = mockProvider('core', () => ({ ok: true, data: coreOut }));
    const sx = mockProvider('searxng', () => fail('searxng unreachable'));
    const hybrid = new HybridSearchProvider(core, sx);

    const out = await hybrid.search(
      { query: 'q', include_domains: ['example.com'] },
      ctx,
    );

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data.results.map((r) => r.url)).toEqual(['https://example.com/a']);
    expect(sx.search).toHaveBeenCalledTimes(1);
  });

  it('returns core result when signal fires and searxng throws synchronously', async () => {
    const coreOut: SearchOutput = {
      results: [makeResult('only', 'https://example.com/a', 0.8)],
      query: 'q',
      engines_used: ['bing'],
      total_time_ms: 100,
    };
    const core = mockProvider('core', () => ({ ok: true, data: coreOut }));
    const sx = mockProvider('searxng', () => {
      throw new Error('boom');
    });
    const hybrid = new HybridSearchProvider(core, sx);

    const out = await hybrid.search(
      { query: 'q', include_domains: ['example.com'] },
      ctx,
    );

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data.results.length).toBe(1);
  });

  it('records the fired signal names in the response', async () => {
    const core = mockProvider('core', () =>
      ok({
        results: [makeResult('only', 'https://example.com/a', 0.8)],
        engines_used: ['bing'],
      }),
    );
    const sx = mockProvider('searxng', () =>
      ok({ results: [makeResult('two', 'https://other.com/b', 0.6)] }),
    );
    const hybrid = new HybridSearchProvider(core, sx);

    const out = await hybrid.search(
      { query: 'q', include_domains: ['example.com'] },
      ctx,
    );

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data.fallback_signal).toBeTruthy();
    expect(out.data.fallback_signal).toContain('include_domains_over_filter');
  });

  it('sets fallback_signal to null when no signal fires', async () => {
    const core = mockProvider('core', () =>
      ok({
        results: [
          makeResult('Kubernetes Operators', 'https://kubernetes.io/operators', 0.8),
          makeResult('Operator Framework', 'https://operatorframework.io/', 0.7),
        ],
        engines_used: ['bing'],
      }),
    );
    const sx = mockProvider('searxng', () => ok({ results: [] }));
    const hybrid = new HybridSearchProvider(core, sx);

    const out = await hybrid.search({ query: 'kubernetes operator' }, ctx);

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data.fallback_signal).toBeNull();
    expect(sx.search).not.toHaveBeenCalled();
  });

  it('skips the searxng fallback and attaches an actionable warning when the sidecar is NOT available (D1 degrade)', async () => {
    // WHY (D1): in hybrid mode with no usable sidecar (no external URL, never
    // installed), the fallback tier would search with empty engines and return
    // junk. Instead the provider returns the core results untouched and surfaces
    // a PER-REQUEST warning (stderr boot lines are invisible to MCP users)
    // naming BOTH fixes so the caller can act.
    const coreOut: SearchOutput = {
      results: [makeResult('only', 'https://example.com/a', 0.8)],
      query: 'q',
      engines_used: ['bing'],
      total_time_ms: 100,
    };
    const core = mockProvider('core', () => ({ ok: true, data: coreOut }));
    const sx = mockProvider('searxng', () => ok({ results: [makeResult('b', 'https://b.com/')] }));
    // Third ctor arg = searxngAvailable; false means the sidecar can't serve.
    const hybrid = new HybridSearchProvider(core, sx, false);

    const out = await hybrid.search(
      { query: 'q', include_domains: ['example.com'] },
      ctx,
    );

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(sx.search).not.toHaveBeenCalled();
    expect(out.data.results.map((r) => r.url)).toEqual(['https://example.com/a']);
    expect(out.data.warning).toBeTruthy();
    expect(out.data.warning).toContain('WIGOLO_SEARXNG_URL');
    expect(out.data.warning).toContain('wigolo warmup --searxng');
    // The signal is still recorded so callers can see WHY the fallback was
    // wanted, even though it was skipped.
    expect(out.data.fallback_signal).toContain('include_domains_over_filter');
  });

  it('does NOT attach the degrade warning when no signal fires even if the sidecar is unavailable', async () => {
    // WHY: the warning is only actionable when a fallback was actually wanted.
    const core = mockProvider('core', () =>
      ok({
        results: [
          makeResult('Kubernetes Operators', 'https://kubernetes.io/operators', 0.8),
          makeResult('Operator Framework', 'https://operatorframework.io/', 0.7),
        ],
        engines_used: ['bing'],
      }),
    );
    const sx = mockProvider('searxng', () => ok({ results: [] }));
    const hybrid = new HybridSearchProvider(core, sx, false);

    const out = await hybrid.search({ query: 'kubernetes operator' }, ctx);

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(sx.search).not.toHaveBeenCalled();
    expect(out.data.warning).toBeUndefined();
    expect(out.data.fallback_signal).toBeNull();
  });

  it('passes the same context through to both providers', async () => {
    const core = mockProvider('core', () =>
      ok({
        results: [makeResult('only', 'https://example.com/a', 0.8)],
      }),
    );
    const sx = mockProvider('searxng', () =>
      ok({ results: [makeResult('b', 'https://b.com/')] }),
    );
    const hybrid = new HybridSearchProvider(core, sx);

    await hybrid.search({ query: 'q', include_domains: ['example.com'] }, ctx);

    expect(core.search).toHaveBeenCalledWith(
      expect.anything(),
      ctx,
    );
    expect(sx.search).toHaveBeenCalledWith(expect.anything(), ctx);
  });
});
