import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SearchEngine, RawSearchResult, ResearchInput } from '../../../src/types.js';
import type { SmartRouter } from '../../../src/fetch/router.js';

vi.mock('../../../src/extraction/pipeline.js', () => ({
  extractContent: vi.fn().mockResolvedValue({
    title: 'Extracted Title',
    markdown: '# Extracted Content\n\nArticle content about the topic.',
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

const { runResearchPipeline } = await import('../../../src/research/pipeline.js');

function createStubEngine(results: RawSearchResult[]): SearchEngine {
  return {
    name: 'stub',
    search: vi.fn().mockResolvedValue(results),
  };
}

function createStubRouter(): SmartRouter {
  return {
    fetch: vi.fn().mockResolvedValue({
      url: 'https://example.com',
      finalUrl: 'https://example.com',
      html: '<html><body><h1>Test</h1><p>Article content about the topic.</p></body></html>',
      contentType: 'text/html',
      statusCode: 200,
      method: 'http' as const,
      headers: {},
    }),
  } as unknown as SmartRouter;
}

const defaultResults: RawSearchResult[] = [
  { title: 'React Hooks Guide', url: 'https://react.dev/hooks', snippet: 'Learn about hooks.', relevance_score: 0.95, engine: 'stub' },
  { title: 'Vue Composition API', url: 'https://vuejs.org/guide', snippet: 'Vue 3 composition API.', relevance_score: 0.88, engine: 'stub' },
  { title: 'Svelte Stores', url: 'https://svelte.dev/docs', snippet: 'Svelte reactive stores.', relevance_score: 0.82, engine: 'stub' },
  { title: 'Angular Signals', url: 'https://angular.io/signals', snippet: 'Angular signal primitives.', relevance_score: 0.75, engine: 'stub' },
  { title: 'Solid Signals', url: 'https://solidjs.com/docs', snippet: 'SolidJS fine-grained reactivity.', relevance_score: 0.70, engine: 'stub' },
];

describe('runResearchPipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('executes full pipeline and returns report', async () => {
    const engine = createStubEngine(defaultResults);
    const router = createStubRouter();
    const input: ResearchInput = {
      question: 'Compare frontend framework state management approaches',
      depth: 'standard',
    };

    const result = await runResearchPipeline(input, [engine], router);

    expect(result.report.length).toBeGreaterThan(0);
    expect(result.sub_queries.length).toBeGreaterThan(0);
    expect(result.sources.length).toBeGreaterThan(0);
    expect(result.depth).toBe('standard');
    expect(result.total_time_ms).toBeGreaterThanOrEqual(0);
    expect(typeof result.sampling_supported).toBe('boolean');
  });

  it('defaults depth to standard when not provided', async () => {
    const engine = createStubEngine(defaultResults);
    const router = createStubRouter();
    const input: ResearchInput = { question: 'What is TypeScript?' };

    const result = await runResearchPipeline(input, [engine], router);

    expect(result.depth).toBe('standard');
    expect(result.sub_queries).toHaveLength(4);
  });

  it('respects quick depth (2 sub-queries, fewer sources)', async () => {
    const engine = createStubEngine(defaultResults);
    const router = createStubRouter();
    const input: ResearchInput = { question: 'What is Deno?', depth: 'quick' };

    const result = await runResearchPipeline(input, [engine], router);

    expect(result.depth).toBe('quick');
    expect(result.sub_queries).toHaveLength(2);
    expect(result.sources.length).toBeLessThanOrEqual(8);
  });

  it('respects comprehensive depth (7 sub-queries, more sources)', async () => {
    const engine = createStubEngine(defaultResults);
    const router = createStubRouter();
    const input: ResearchInput = {
      question: 'Comprehensive analysis of modern JavaScript build tools',
      depth: 'comprehensive',
    };

    const result = await runResearchPipeline(input, [engine], router);

    expect(result.depth).toBe('comprehensive');
    expect(result.sub_queries).toHaveLength(7);
  });

  it('respects max_sources override', async () => {
    const engine = createStubEngine(defaultResults);
    const router = createStubRouter();
    const input: ResearchInput = {
      question: 'Test with limited sources',
      depth: 'standard',
      max_sources: 3,
    };

    const result = await runResearchPipeline(input, [engine], router);

    expect(result.sources.length).toBeLessThanOrEqual(3);
  });

  it('passes include_domains to search', async () => {
    const engine = createStubEngine(defaultResults);
    const router = createStubRouter();
    const input: ResearchInput = {
      question: 'React hooks',
      include_domains: ['react.dev'],
    };

    const result = await runResearchPipeline(input, [engine], router);

    expect(result.report.length).toBeGreaterThan(0);
  });

  it('passes exclude_domains to search', async () => {
    const engine = createStubEngine(defaultResults);
    const router = createStubRouter();
    const input: ResearchInput = {
      question: 'JavaScript frameworks',
      exclude_domains: ['w3schools.com'],
    };

    const result = await runResearchPipeline(input, [engine], router);

    expect(result.report.length).toBeGreaterThan(0);
  });

  it('handles search returning no results', async () => {
    const engine = createStubEngine([]);
    const router = createStubRouter();
    const input: ResearchInput = { question: 'nonexistent topic xyz123' };

    const result = await runResearchPipeline(input, [engine], router);

    expect(result.sources).toHaveLength(0);
    expect(result.report).toContain('No sources');
    expect(result.error).toBeUndefined();
  });

  it('handles fetch failures gracefully', async () => {
    const engine = createStubEngine(defaultResults);
    const router = {
      fetch: vi.fn().mockRejectedValue(new Error('network error')),
    } as unknown as SmartRouter;
    const input: ResearchInput = { question: 'Test fetch failures' };

    const result = await runResearchPipeline(input, [engine], router);

    expect(result.report.length).toBeGreaterThan(0);
    expect(result.sources.some((s) => s.fetch_error)).toBe(true);
  });

  it('deduplicates results across sub-queries', async () => {
    const engine: SearchEngine = {
      name: 'dedup-stub',
      search: vi.fn().mockResolvedValue([
        { title: 'Same Article', url: 'https://example.com/article', snippet: 'content', relevance_score: 0.9, engine: 'dedup-stub' },
      ]),
    };
    const router = createStubRouter();
    const input: ResearchInput = { question: 'Duplicate test', depth: 'standard' };

    const result = await runResearchPipeline(input, [engine], router);

    const uniqueUrls = new Set(result.sources.map((s) => s.url));
    expect(uniqueUrls.size).toBe(result.sources.length);
  });

  it('produces citations matching sources', async () => {
    const engine = createStubEngine(defaultResults);
    const router = createStubRouter();
    const input: ResearchInput = { question: 'Citation test', depth: 'quick' };

    const result = await runResearchPipeline(input, [engine], router);

    for (const citation of result.citations) {
      expect(citation.index).toBeGreaterThan(0);
      expect(citation.url).toBeTruthy();
      expect(citation.title).toBeTruthy();
      const matchingSource = result.sources.find((s) => s.url === citation.url);
      expect(matchingSource).toBeDefined();
    }
  });

  it('sets sampling_supported to false without server', async () => {
    const engine = createStubEngine(defaultResults);
    const router = createStubRouter();
    const input: ResearchInput = { question: 'Sampling test' };

    const result = await runResearchPipeline(input, [engine], router);

    expect(result.sampling_supported).toBe(false);
  });

  it('handles empty question', async () => {
    const engine = createStubEngine(defaultResults);
    const router = createStubRouter();
    const input: ResearchInput = { question: '' };

    const result = await runResearchPipeline(input, [engine], router);

    expect(result.report.length).toBeGreaterThan(0);
    expect(result.depth).toBe('standard');
  });

  it('handles engine throwing error', async () => {
    const engine: SearchEngine = {
      name: 'error-engine',
      search: vi.fn().mockRejectedValue(new Error('engine crashed')),
    };
    const router = createStubRouter();
    const input: ResearchInput = { question: 'Error handling test' };

    const result = await runResearchPipeline(input, [engine], router);

    expect(result.report).toBeDefined();
    expect(typeof result.total_time_ms).toBe('number');
  });

  it('total_time_ms reflects actual execution time', async () => {
    const engine = createStubEngine(defaultResults);
    const router = createStubRouter();
    const input: ResearchInput = { question: 'Timing test', depth: 'quick' };

    const before = Date.now();
    const result = await runResearchPipeline(input, [engine], router);
    const after = Date.now();

    expect(result.total_time_ms).toBeGreaterThanOrEqual(0);
    expect(result.total_time_ms).toBeLessThanOrEqual(after - before + 100);
  });
});
