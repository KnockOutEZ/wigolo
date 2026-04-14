import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SearchEngine, RawSearchResult, ResearchInput } from '../../../src/types.js';
import type { SmartRouter } from '../../../src/fetch/router.js';

vi.mock('../../../src/extraction/pipeline.js', () => ({
  extractContent: vi.fn().mockResolvedValue({
    title: 'Mock Title',
    markdown: '# Mock Content\n\nExtracted content for research.',
    metadata: {},
    links: [],
    images: [],
    extractor: 'defuddle' as const,
  }),
}));

vi.mock('../../../src/cache/store.js', () => ({
  cacheContent: vi.fn(),
  normalizeUrl: vi.fn((url: string) => url),
}));

const { handleResearch } = await import('../../../src/tools/research.js');

const stubEngine: SearchEngine = {
  name: 'test-stub',
  search: vi.fn().mockResolvedValue([
    { title: 'Article 1', url: 'https://example.com/1', snippet: 'Content 1', relevance_score: 0.9, engine: 'test-stub' },
    { title: 'Article 2', url: 'https://example.com/2', snippet: 'Content 2', relevance_score: 0.8, engine: 'test-stub' },
  ] as RawSearchResult[]),
};

const stubRouter = {
  fetch: vi.fn().mockResolvedValue({
    url: 'https://example.com/1',
    finalUrl: 'https://example.com/1',
    html: '<html><body><h1>Title</h1><p>Content for research.</p></body></html>',
    contentType: 'text/html',
    statusCode: 200,
    method: 'http' as const,
    headers: {},
  }),
} as unknown as SmartRouter;

describe('handleResearch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns structured ResearchOutput', async () => {
    const input: ResearchInput = { question: 'What is TypeScript?' };

    const result = await handleResearch(input, [stubEngine], stubRouter);

    expect(result.report).toBeDefined();
    expect(typeof result.report).toBe('string');
    expect(result.citations).toBeDefined();
    expect(Array.isArray(result.citations)).toBe(true);
    expect(result.sources).toBeDefined();
    expect(Array.isArray(result.sources)).toBe(true);
    expect(result.sub_queries).toBeDefined();
    expect(Array.isArray(result.sub_queries)).toBe(true);
    expect(result.depth).toBe('standard');
    expect(typeof result.total_time_ms).toBe('number');
    expect(typeof result.sampling_supported).toBe('boolean');
  });

  it('validates question is required', async () => {
    const input = {} as ResearchInput;

    const result = await handleResearch(input, [stubEngine], stubRouter);

    expect(result.error).toBeDefined();
    expect(result.error).toContain('question');
  });

  it('validates empty question', async () => {
    const input: ResearchInput = { question: '' };

    const result = await handleResearch(input, [stubEngine], stubRouter);

    expect(result.error).toBeDefined();
  });

  it('validates invalid depth', async () => {
    const input = { question: 'test', depth: 'invalid' as any };

    const result = await handleResearch(input, [stubEngine], stubRouter);

    expect(result.error).toBeDefined();
    expect(result.error).toContain('depth');
  });

  it('accepts quick depth', async () => {
    const input: ResearchInput = { question: 'Quick test', depth: 'quick' };

    const result = await handleResearch(input, [stubEngine], stubRouter);

    expect(result.depth).toBe('quick');
    expect(result.error).toBeUndefined();
  });

  it('accepts comprehensive depth', async () => {
    const input: ResearchInput = { question: 'Deep test', depth: 'comprehensive' };

    const result = await handleResearch(input, [stubEngine], stubRouter);

    expect(result.depth).toBe('comprehensive');
    expect(result.error).toBeUndefined();
  });

  it('passes include_domains through', async () => {
    const input: ResearchInput = {
      question: 'React hooks',
      include_domains: ['react.dev'],
    };

    const result = await handleResearch(input, [stubEngine], stubRouter);

    expect(result.error).toBeUndefined();
    expect(result.report.length).toBeGreaterThan(0);
  });

  it('passes exclude_domains through', async () => {
    const input: ResearchInput = {
      question: 'JavaScript tutorials',
      exclude_domains: ['w3schools.com'],
    };

    const result = await handleResearch(input, [stubEngine], stubRouter);

    expect(result.error).toBeUndefined();
  });

  it('passes max_sources through', async () => {
    const input: ResearchInput = {
      question: 'Limited sources test',
      max_sources: 3,
    };

    const result = await handleResearch(input, [stubEngine], stubRouter);

    expect(result.error).toBeUndefined();
    expect(result.sources.length).toBeLessThanOrEqual(3);
  });

  it('handles engine failure gracefully', async () => {
    const brokenEngine: SearchEngine = {
      name: 'broken',
      search: vi.fn().mockRejectedValue(new Error('engine down')),
    };

    const input: ResearchInput = { question: 'Error test' };
    const result = await handleResearch(input, [brokenEngine], stubRouter);

    expect(result).toBeDefined();
    expect(typeof result.total_time_ms).toBe('number');
  });

  it('handles router failure gracefully', async () => {
    const brokenRouter = {
      fetch: vi.fn().mockRejectedValue(new Error('network down')),
    } as unknown as SmartRouter;

    const input: ResearchInput = { question: 'Router error test' };
    const result = await handleResearch(input, [stubEngine], brokenRouter);

    expect(result).toBeDefined();
    expect(result.report.length).toBeGreaterThan(0);
  });

  it('never throws -- always returns structured output', async () => {
    const input: ResearchInput = { question: 'Stability test' };

    const result = await handleResearch(input, [], stubRouter);

    expect(result).toBeDefined();
    expect(result.report).toBeDefined();
  });

  it('validates max_sources is positive', async () => {
    const input: ResearchInput = { question: 'test', max_sources: -1 };

    const result = await handleResearch(input, [stubEngine], stubRouter);

    expect(result.error).toBeDefined();
  });

  it('validates max_sources is not excessively large', async () => {
    const input: ResearchInput = { question: 'test', max_sources: 1000 };

    const result = await handleResearch(input, [stubEngine], stubRouter);

    expect(result.error).toBeDefined();
  });

  it('sampling_supported is false when no server provided', async () => {
    const input: ResearchInput = { question: 'test' };

    const result = await handleResearch(input, [stubEngine], stubRouter);

    expect(result.sampling_supported).toBe(false);
  });
});
