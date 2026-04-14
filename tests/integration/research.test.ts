import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SearchEngine, RawSearchResult, ResearchInput } from '../../src/types.js';
import type { SmartRouter } from '../../src/fetch/router.js';

vi.mock('../../src/extraction/pipeline.js', () => ({
  extractContent: vi.fn().mockResolvedValue({
    title: 'Integration Article',
    markdown: '# Article\n\nDetailed content about TypeScript generics and type system features. This covers everything from basic generic functions to advanced conditional types.',
    metadata: {},
    links: [],
    images: [],
    extractor: 'defuddle' as const,
  }),
}));

vi.mock('../../src/cache/store.js', () => ({
  cacheContent: vi.fn(),
  normalizeUrl: vi.fn((url: string) => url),
}));

const { handleResearch } = await import('../../src/tools/research.js');

const stubResults: RawSearchResult[] = [
  {
    title: 'TypeScript Handbook - Generics',
    url: 'https://typescriptlang.org/docs/handbook/generics.html',
    snippet: 'Generics allow creating reusable components that work with multiple types.',
    relevance_score: 0.95,
    engine: 'integration-stub',
  },
  {
    title: 'Understanding TypeScript Generics',
    url: 'https://blog.example.com/ts-generics',
    snippet: 'A deep dive into TypeScript generics with practical examples.',
    relevance_score: 0.88,
    engine: 'integration-stub',
  },
  {
    title: 'Advanced TypeScript Patterns',
    url: 'https://patterns.dev/typescript',
    snippet: 'Advanced patterns including conditional types and mapped types.',
    relevance_score: 0.82,
    engine: 'integration-stub',
  },
  {
    title: 'TypeScript vs Flow',
    url: 'https://comparison.dev/ts-flow',
    snippet: 'Comparing TypeScript and Flow type systems.',
    relevance_score: 0.75,
    engine: 'integration-stub',
  },
  {
    title: 'TypeScript Performance Tips',
    url: 'https://perf.dev/typescript',
    snippet: 'How to write performant TypeScript code.',
    relevance_score: 0.70,
    engine: 'integration-stub',
  },
];

const stubEngine: SearchEngine = {
  name: 'integration-stub',
  search: vi.fn().mockResolvedValue(stubResults),
};

const stubRouter = {
  fetch: vi.fn().mockImplementation((url: string) => Promise.resolve({
    url,
    finalUrl: url,
    html: `<html><body><h1>Article</h1><p>Detailed content about TypeScript generics and type system features. This covers everything from basic generic functions to advanced conditional types.</p></body></html>`,
    contentType: 'text/html',
    statusCode: 200,
    method: 'http' as const,
    headers: {},
  })),
} as unknown as SmartRouter;

describe('research tool integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('full pipeline: question -> sub-queries -> search -> fetch -> report', async () => {
    const input: ResearchInput = {
      question: 'How do TypeScript generics work and what are best practices?',
      depth: 'quick',
    };

    const result = await handleResearch(input, [stubEngine], stubRouter);

    expect(result.error).toBeUndefined();
    expect(result.report.length).toBeGreaterThan(0);
    expect(result.sub_queries.length).toBe(2);
    expect(result.sources.length).toBeGreaterThan(0);
    expect(result.citations.length).toBeGreaterThan(0);
    expect(result.depth).toBe('quick');
    expect(result.total_time_ms).toBeGreaterThanOrEqual(0);
    expect(result.sampling_supported).toBe(false);
  });

  it('standard depth produces more sub-queries and sources', async () => {
    const input: ResearchInput = {
      question: 'Comprehensive guide to TypeScript type system',
      depth: 'standard',
    };

    const result = await handleResearch(input, [stubEngine], stubRouter);

    expect(result.sub_queries.length).toBe(4);
    expect(result.sources.length).toBeGreaterThan(0);
    expect(result.depth).toBe('standard');
  });

  it('comprehensive depth produces most sub-queries', async () => {
    const input: ResearchInput = {
      question: 'Full analysis of TypeScript vs other typed languages',
      depth: 'comprehensive',
    };

    const result = await handleResearch(input, [stubEngine], stubRouter);

    expect(result.sub_queries.length).toBe(7);
    expect(result.depth).toBe('comprehensive');
  });

  it('citations reference actual sources', async () => {
    const input: ResearchInput = {
      question: 'TypeScript generics',
      depth: 'quick',
    };

    const result = await handleResearch(input, [stubEngine], stubRouter);

    for (const citation of result.citations) {
      const matchingSource = result.sources.find((s) => s.url === citation.url);
      expect(matchingSource).toBeDefined();
      expect(citation.index).toBeGreaterThan(0);
    }
  });

  it('handles partial fetch failures in pipeline', async () => {
    let callCount = 0;
    const flakeyRouter = {
      fetch: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount % 2 === 0) {
          return Promise.reject(new Error('intermittent failure'));
        }
        return Promise.resolve({
          url: 'https://example.com',
          finalUrl: 'https://example.com',
          html: '<html><body><p>Content</p></body></html>',
          contentType: 'text/html',
          statusCode: 200,
          method: 'http' as const,
          headers: {},
        });
      }),
    } as unknown as SmartRouter;

    const input: ResearchInput = { question: 'Flakey test', depth: 'quick' };
    const result = await handleResearch(input, [stubEngine], flakeyRouter);

    expect(result.error).toBeUndefined();
    expect(result.report.length).toBeGreaterThan(0);
    const failedSources = result.sources.filter((s) => s.fetch_error);
    expect(failedSources.length).toBeGreaterThan(0);
  });

  it('max_sources limits the number of sources fetched', async () => {
    const input: ResearchInput = {
      question: 'TypeScript patterns',
      depth: 'standard',
      max_sources: 2,
    };

    const result = await handleResearch(input, [stubEngine], stubRouter);

    expect(result.sources.length).toBeLessThanOrEqual(2);
  });

  it('report is well-structured markdown', async () => {
    const input: ResearchInput = {
      question: 'TypeScript generics best practices',
      depth: 'quick',
    };

    const result = await handleResearch(input, [stubEngine], stubRouter);

    expect(result.report).toContain('#');
    expect(result.report.length).toBeGreaterThan(50);
  });

  it('full pipeline with include_domains', async () => {
    const input: ResearchInput = {
      question: 'TypeScript generics',
      depth: 'quick',
      include_domains: ['typescriptlang.org'],
    };

    const result = await handleResearch(input, [stubEngine], stubRouter);

    expect(result.error).toBeUndefined();
    expect(result.report.length).toBeGreaterThan(0);
  });

  it('total_time_ms is populated', async () => {
    const input: ResearchInput = { question: 'Quick timing test', depth: 'quick' };

    const result = await handleResearch(input, [stubEngine], stubRouter);

    expect(result.total_time_ms).toBeGreaterThanOrEqual(0);
  });

  it('input validation errors return structured output, not exceptions', async () => {
    const result1 = await handleResearch({ question: '' } as ResearchInput, [stubEngine], stubRouter);
    expect(result1.error).toBeDefined();
    expect(result1.report).toBe('');

    const result2 = await handleResearch({ question: 'test', depth: 'wrong' as any }, [stubEngine], stubRouter);
    expect(result2.error).toBeDefined();

    const result3 = await handleResearch({ question: 'test', max_sources: -5 }, [stubEngine], stubRouter);
    expect(result3.error).toBeDefined();
  });
});
