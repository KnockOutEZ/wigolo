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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  let originalUrl: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.WIGOLO_SEARCH;
    originalUrl = process.env.SEARXNG_URL;
    process.env.WIGOLO_SEARCH = 'hybrid';
    // These merge-path tests exercise the fallback tier, which now only runs
    // when the sidecar is AVAILABLE (D1). An external URL makes it available
    // without a live process. The degrade case below clears this.
    process.env.SEARXNG_URL = 'http://sidecar.test:8888';
    // The provider factory now resolves the backend through getConfig(), which
    // memoizes. Reset the config cache so the mutated env is re-read here.
    resetConfig();
    _resetSearchProviderForTest();
    impls.searxngCalls = 0;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.WIGOLO_SEARCH;
    else process.env.WIGOLO_SEARCH = originalEnv;
    if (originalUrl === undefined) delete process.env.SEARXNG_URL;
    else process.env.SEARXNG_URL = originalUrl;
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

  it('DEGRADE: hybrid selected, no URL, sidecar not installed — skips fallback, returns core results + warning naming both fixes', async () => {
    // WHY (D1): WIGOLO_SEARCH=hybrid opts into the sidecar, but if it was never
    // installed (no URL, no ready state), the fallback tier would search with
    // empty engines and return junk. The provider must skip it, still return
    // the core results, and surface a per-request warning naming BOTH fixes so
    // an MCP caller (who never sees stderr) can act.
    const freshDataDir = mkdtempSync(join(tmpdir(), 'wigolo-hybrid-degrade-'));
    delete process.env.SEARXNG_URL; // no external endpoint
    process.env.WIGOLO_DATA_DIR = freshDataDir; // empty dir → no ready state.json
    resetConfig();
    _resetSearchProviderForTest();
    impls.searxngCalls = 0;

    impls.core = async () =>
      ok({
        results: [makeResult('only', 'https://niche.example.com/a', 0.8)],
        engines_used: ['bing'],
      });
    // This impl must never be invoked; if it were, the count assertion catches it.
    impls.searxng = async () =>
      ok({ results: [makeResult('B', 'https://niche.example.com/b', 0.6)] });

    try {
      const provider = await getSearchProvider();
      expect(provider.name).toBe('hybrid');

      const out = await provider.search(
        { query: 'kubernetes operator', include_domains: ['niche.example.com'] },
        { engines: [], router: {} as never },
      );

      expect(out.ok).toBe(true);
      if (!out.ok) return;
      // Fallback SKIPPED — searxng provider never called.
      expect(impls.searxngCalls).toBe(0);
      // Core results still returned.
      expect(out.data.results.map((r) => r.url)).toEqual(['https://niche.example.com/a']);
      // Signal recorded (the fallback WAS wanted) but per-request warning names both fixes.
      expect(out.data.fallback_signal).toContain('include_domains_over_filter');
      expect(out.data.warning).toBeTruthy();
      expect(out.data.warning).toContain('WIGOLO_SEARXNG_URL');
      expect(out.data.warning).toContain('wigolo warmup --searxng');
    } finally {
      delete process.env.WIGOLO_DATA_DIR;
      rmSync(freshDataDir, { recursive: true, force: true });
    }
  });
});
