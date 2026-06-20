import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SearchEngine, RawSearchResult, ResearchInput } from '../../../src/types.js';
import type { SmartRouter } from '../../../src/fetch/router.js';

// Extract markdown is derived from the URL so the content gate has real
// per-source signal: a /shell URL yields an empty stub, everything else yields
// substantial on-topic prose.
const ON_TOPIC = Array.from(
  { length: 30 },
  () => 'SQLite FTS5 full text search versus a dedicated vector database tradeoffs for local semantic ranking',
).join('. ');

vi.mock('../../../src/providers/extract-provider.js', () => ({
  getExtractProvider: vi.fn(async () => ({
    name: 'v1' as const,
    extract: vi.fn(async (_html: string, url: string) => ({
      title: `Title for ${url}`,
      markdown: url.includes('/shell') ? 'Loading' : ON_TOPIC,
      metadata: {},
      links: [],
      images: [],
      extractor: 'defuddle' as const,
    })),
  })),
  _resetExtractProviderForTest: vi.fn(),
}));

vi.mock('../../../src/cache/store.js', () => ({
  cacheContent: vi.fn(),
  normalizeUrl: vi.fn((url: string) => url),
}));

const { runResearchPipeline } = await import('../../../src/research/pipeline.js');

function createStubEngine(results: RawSearchResult[]): SearchEngine {
  return { name: 'stub', search: vi.fn().mockResolvedValue(results) } as unknown as SearchEngine;
}

function createStubRouter(): SmartRouter {
  return {
    fetch: vi.fn(async (url: string) => ({
      url,
      finalUrl: url,
      html: `<html><body><p>content</p></body></html>`,
      contentType: 'text/html',
      statusCode: 200,
      method: 'http' as const,
      headers: {},
    })),
  } as unknown as SmartRouter;
}

function goodResult(i: number, score: number): RawSearchResult {
  return {
    title: `FTS5 vs vector DB article ${i}`,
    url: `https://content${i}.example.com/articles/fts5-vs-vector-${i}`,
    snippet: 'SQLite FTS5 versus a dedicated vector database tradeoffs.',
    relevance_score: score,
    engine: 'stub',
  };
}

const QUESTION = 'SQLite FTS5 vs dedicated vector database tradeoffs';

describe('research pipeline source validation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('drops homepage and SERP URLs and surfaces them in rejected_sources', async () => {
    // WHY: the C1 benchmark leaked a Google homepage and a results page into
    // the source list — url-shape junk must never occupy a source slot, and
    // the drop must be visible, not silently swallowed.
    const results: RawSearchResult[] = [
      { title: 'Google', url: 'https://www.google.com/', snippet: '', relevance_score: 0.99, engine: 'stub' },
      { title: 'Bing search', url: 'https://www.bing.com/search?q=fts5', snippet: '', relevance_score: 0.98, engine: 'stub' },
      ...Array.from({ length: 10 }, (_, i) => goodResult(i, 0.9 - i * 0.01)),
    ];
    const input: ResearchInput = { question: QUESTION, depth: 'quick' };

    const result = await runResearchPipeline(input, [createStubEngine(results)], createStubRouter());

    const urls = result.sources.map((s) => s.url);
    expect(urls).not.toContain('https://www.google.com/');
    expect(urls).not.toContain('https://www.bing.com/search?q=fts5');

    expect(result.rejected_sources).toBeDefined();
    const reasons = (result.rejected_sources ?? []).map((r) => r.reason);
    expect(reasons).toContain('homepage');
    expect(reasons).toContain('serp');
    for (const r of result.rejected_sources ?? []) {
      if (r.reason === 'homepage' || r.reason === 'serp') expect(r.stage).toBe('url-shape');
    }
  });

  it('back-fills dropped junk so the source count stays at max_sources', async () => {
    // WHY: dropping junk must not shrink the brief — a next-ranked legitimate
    // candidate fills the freed slot (filter runs before the slice).
    const results: RawSearchResult[] = [
      { title: 'Google', url: 'https://www.google.com/', snippet: '', relevance_score: 0.99, engine: 'stub' },
      { title: 'Bing search', url: 'https://www.bing.com/search?q=x', snippet: '', relevance_score: 0.98, engine: 'stub' },
      ...Array.from({ length: 10 }, (_, i) => goodResult(i, 0.9 - i * 0.01)),
    ];
    const input: ResearchInput = { question: QUESTION, depth: 'quick' }; // max_sources 8

    const result = await runResearchPipeline(input, [createStubEngine(results)], createStubRouter());

    // 10 good candidates remain after 2 junk dropped — enough to fill all 8.
    expect(result.sources).toHaveLength(8);
  });

  it('drops a bare LinkedIn activity post as social-promo via url-shape', async () => {
    // WHY: the C1 query surfaced a linkedin.com/posts/...activity-<id> promo
    // post into the pool. It is real, on-domain content (so the content gate
    // would pass it) but a sentence of self-promotion, not article text — the
    // url-shape filter must drop it, tagged social-promo, before it takes a slot.
    const results: RawSearchResult[] = [
      { title: 'Promo post', url: 'https://www.linkedin.com/posts/jane_sqlite-vector-activity-7123456789012345678-AbCd', snippet: 'check out my post', relevance_score: 0.97, engine: 'stub' },
      ...Array.from({ length: 10 }, (_, i) => goodResult(i, 0.9 - i * 0.01)),
    ];
    const input: ResearchInput = { question: QUESTION, depth: 'quick' };

    const result = await runResearchPipeline(input, [createStubEngine(results)], createStubRouter());

    const urls = result.sources.map((s) => s.url);
    expect(urls).not.toContain(
      'https://www.linkedin.com/posts/jane_sqlite-vector-activity-7123456789012345678-AbCd',
    );
    const promoReject = (result.rejected_sources ?? []).find((r) => r.reason === 'social-promo');
    expect(promoReject).toBeDefined();
    expect(promoReject?.stage).toBe('url-shape');
  });

  it('drops a fetched empty-shell page via the content gate', async () => {
    // WHY: a URL can be content-shaped yet resolve to an empty shell; the
    // post-fetch gate catches what url-shape can't, tagged content-gate.
    const results: RawSearchResult[] = [
      { title: 'Shell page', url: 'https://content99.example.com/shell', snippet: 'x', relevance_score: 0.995, engine: 'stub' },
      ...Array.from({ length: 9 }, (_, i) => goodResult(i, 0.9 - i * 0.01)),
    ];
    const input: ResearchInput = { question: QUESTION, depth: 'quick' };

    const result = await runResearchPipeline(input, [createStubEngine(results)], createStubRouter());

    const urls = result.sources.map((s) => s.url);
    expect(urls).not.toContain('https://content99.example.com/shell');

    const shellReject = (result.rejected_sources ?? []).find(
      (r) => r.url === 'https://content99.example.com/shell',
    );
    expect(shellReject).toBeDefined();
    expect(shellReject?.stage).toBe('content-gate');
    expect(shellReject?.reason).toBe('low-content');
  });

  it('fails open: keeps sources rather than emptying the brief when the gate would drop everything', async () => {
    // WHY: if every fetched page is thin/off-topic, mediocre sources still beat
    // an empty brief — rerank already ordered them. The gate must never zero
    // out the result.
    // Every candidate fetches to an empty shell ("Loading"), so the content
    // gate would drop all of them — the fail-open guard must keep them.
    const results: RawSearchResult[] = Array.from({ length: 5 }, (_, i) => ({
      title: `Shell ${i}`,
      url: `https://content${i}.example.com/shell-${i}`,
      snippet: 'x',
      relevance_score: 0.9 - i * 0.01,
      engine: 'stub',
    }));
    const input: ResearchInput = { question: QUESTION, depth: 'quick' };

    const result = await runResearchPipeline(input, [createStubEngine(results)], createStubRouter());

    expect(result.sources.length).toBeGreaterThan(0);
  });

  it('does not gate fetch-failed snippet sources', async () => {
    // WHY: a fetch failure keeps the search snippet as a deliberate fallback
    // (documented contract). The content gate targets pages that fetched but
    // returned an empty shell — not failed fetches.
    const results: RawSearchResult[] = Array.from({ length: 3 }, (_, i) => goodResult(i, 0.9 - i * 0.01));
    const failingRouter = {
      fetch: vi.fn(async () => {
        throw new Error('fetch failed');
      }),
    } as unknown as SmartRouter;
    const input: ResearchInput = { question: QUESTION, depth: 'quick' };

    const result = await runResearchPipeline(input, [createStubEngine(results)], failingRouter);

    expect(result.sources.some((s) => s.fetch_error)).toBe(true);
    // none of the failed snippet sources were tagged content-gate
    const contentGateRejects = (result.rejected_sources ?? []).filter((r) => r.stage === 'content-gate');
    expect(contentGateRejects).toHaveLength(0);
  });

  it('keeps an include_domains root through the pipeline filter', async () => {
    // WHY: the url-shape filter threads input.include_domains — a homepage on a
    // domain the caller explicitly scoped to is an intentional target and must
    // survive the pipeline, not just the unit classifier.
    const results: RawSearchResult[] = [
      { title: 'Docs root', url: 'https://docs.example.com/', snippet: 'x', relevance_score: 0.95, engine: 'stub' },
      ...Array.from({ length: 3 }, (_, i) => goodResult(i, 0.9 - i * 0.01)),
    ];
    const input: ResearchInput = {
      question: QUESTION,
      depth: 'quick',
      include_domains: ['docs.example.com'],
    };

    const result = await runResearchPipeline(input, [createStubEngine(results)], createStubRouter());

    const homepageRejects = (result.rejected_sources ?? []).filter((r) => r.reason === 'homepage');
    expect(homepageRejects).toHaveLength(0);
    expect(result.sources.map((s) => s.url)).toContain('https://docs.example.com/');
  });

  it('returns the no-sources report when every candidate is url-shape junk', async () => {
    // WHY: the all-junk early-return is a distinct branch from content-gate
    // fail-open — when nothing survives the url-shape filter there is nothing
    // to fetch, and the rejected_sources must still surface why.
    const results: RawSearchResult[] = [
      { title: 'Google', url: 'https://www.google.com/', snippet: '', relevance_score: 0.99, engine: 'stub' },
      { title: 'Bing search', url: 'https://www.bing.com/search?q=x', snippet: '', relevance_score: 0.98, engine: 'stub' },
    ];
    const input: ResearchInput = { question: QUESTION, depth: 'quick' };

    const result = await runResearchPipeline(input, [createStubEngine(results)], createStubRouter());

    expect(result.sources).toHaveLength(0);
    expect(result.report).toContain('No sources could be found');
    expect((result.rejected_sources ?? []).length).toBeGreaterThanOrEqual(2);
  });
});
