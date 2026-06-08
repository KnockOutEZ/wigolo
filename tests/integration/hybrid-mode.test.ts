import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type {
  SearchInput,
  SearchOutput,
  SearchResultItem,
  StageResult,
} from '../../src/types.js';
import {
  getSearchProvider,
  _resetSearchProviderForTest,
} from '../../src/providers/search-provider.js';
import { resetConfig } from '../../src/config.js';

// Mutable impls shared between the test module and the mock factories.
// Hoisting keeps the references stable across vi.mock setup.
const impls = vi.hoisted(() => ({
  core: async (_input: SearchInput): Promise<StageResult<SearchOutput>> => ({
    ok: true,
    data: { results: [], query: 'q', engines_used: [], total_time_ms: 0 },
  }),
  searxng: async (_input: SearchInput): Promise<StageResult<SearchOutput>> => ({
    ok: true,
    data: { results: [], query: 'q', engines_used: [], total_time_ms: 0 },
  }),
  searxngCalls: 0,
}));

vi.mock('../../src/search/core/core-provider.js', () => ({
  CoreSearchProvider: class {
    readonly name = 'core' as const;
    async search(input: SearchInput): Promise<StageResult<SearchOutput>> {
      return impls.core(input);
    }
  },
}));

vi.mock('../../src/search/legacy/searxng-provider.js', () => ({
  LegacySearxngProvider: class {
    readonly name = 'searxng' as const;
    async search(input: SearchInput): Promise<StageResult<SearchOutput>> {
      impls.searxngCalls += 1;
      return impls.searxng(input);
    }
  },
}));

function makeResult(
  title: string,
  url: string,
  score = 0.5,
): SearchResultItem {
  return { title, url, snippet: '', relevance_score: score };
}

function ok(data: Partial<SearchOutput>): StageResult<SearchOutput> {
  return {
    ok: true,
    data: {
      results: [],
      query: 'q',
      engines_used: [],
      total_time_ms: 0,
      ...data,
    },
  };
}

describe('hybrid mode via provider factory', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.WIGOLO_SEARCH;
    process.env.WIGOLO_SEARCH = 'hybrid';
    // The provider factory now resolves the backend through getConfig(), which
    // memoizes. Reset the config cache so the mutated env is re-read here.
    resetConfig();
    _resetSearchProviderForTest();
    impls.searxngCalls = 0;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.WIGOLO_SEARCH;
    else process.env.WIGOLO_SEARCH = originalEnv;
    resetConfig();
    _resetSearchProviderForTest();
  });

  it('fires fallback on a brand-collision-shaped query and reports the signal', async () => {
    impls.core = async () =>
      ok({
        results: [
          makeResult(
            'Next | Online Shopping Clothes Shoes Bags',
            'https://next.co.uk/',
            1.0,
          ),
        ],
        engines_used: ['bing'],
      });
    impls.searxng = async () =>
      ok({
        results: [makeResult('Next.js', 'https://nextjs.org/', 0.9)],
        engines_used: ['searxng:google'],
      });

    const provider = await getSearchProvider();
    expect(provider.name).toBe('hybrid');

    const out = await provider.search(
      { query: 'next' },
      { engines: [], router: {} as never },
    );

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data.fallback_signal).toBeTruthy();
    expect(out.data.fallback_signal).toContain('brand_collision_suspect');
    expect(impls.searxngCalls).toBe(1);
  });

  it('returns core unchanged with fallback_signal null on a clean query', async () => {
    impls.core = async () =>
      ok({
        results: [
          makeResult('Kubernetes Operators', 'https://kubernetes.io/operators', 0.8),
          makeResult('Operator Framework', 'https://operatorframework.io/', 0.7),
          makeResult('OpenShift Operators', 'https://openshift.com/operators', 0.6),
        ],
        engines_used: ['bing', 'ddg'],
      });

    const provider = await getSearchProvider();

    const out = await provider.search(
      { query: 'kubernetes operator' },
      { engines: [], router: {} as never },
    );

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data.results.length).toBeGreaterThan(0);
    expect(out.data.fallback_signal).toBeNull();
    expect(impls.searxngCalls).toBe(0);
  });

  it('does not fall back when include_domains is satisfied with >=2 core hits', async () => {
    impls.core = async () =>
      ok({
        results: [
          makeResult('A', 'https://example.com/a'),
          makeResult('B', 'https://example.com/b'),
          makeResult('C', 'https://example.com/c'),
        ],
        engines_used: ['bing'],
      });

    const provider = await getSearchProvider();
    const out = await provider.search(
      { query: 'kubernetes operator', include_domains: ['example.com'] },
      { engines: [], router: {} as never },
    );

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data.fallback_signal).toBeNull();
    expect(impls.searxngCalls).toBe(0);
  });

  it('falls back when include_domains over-filters core to fewer than 2 results', async () => {
    impls.core = async () =>
      ok({
        results: [makeResult('A', 'https://niche.example.com/a', 0.8)],
        engines_used: ['bing'],
      });
    impls.searxng = async () =>
      ok({
        results: [
          makeResult('B', 'https://niche.example.com/b', 0.6),
          makeResult('C', 'https://niche.example.com/c', 0.5),
        ],
        engines_used: ['searxng:google'],
      });

    const provider = await getSearchProvider();
    const out = await provider.search(
      { query: 'kubernetes operator', include_domains: ['niche.example.com'] },
      { engines: [], router: {} as never },
    );

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(impls.searxngCalls).toBe(1);
    expect(out.data.fallback_signal).toContain('include_domains_over_filter');
    expect(out.data.results.length).toBeGreaterThan(1);
  });
});
