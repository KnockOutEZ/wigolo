import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SearchEngine, RawSearchResult, ResearchInput } from '../../../src/types.js';
import type { SmartRouter } from '../../../src/fetch/router.js';

const extractMock = vi.fn().mockResolvedValue({
  title: 'Extracted Title',
  markdown: '# Extracted Content\n\nArticle content about the topic.',
  metadata: {},
  links: [],
  images: [],
  extractor: 'defuddle' as const,
});
vi.mock('../../../src/providers/extract-provider.js', () => ({
  getExtractProvider: vi.fn(async () => ({
    name: 'v1' as const,
    extract: extractMock,
  })),
  _resetExtractProviderForTest: vi.fn(),
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

  it('preserves original question phrasing as the first sub-query', async () => {
    // Closes the "A2A clause drop" bench complaint — the decomposer used to
    // rewrite the question into synthetic phrasings and lose specific tokens
    // from the original (e.g. "A2A" stripped during noun-phrase extraction).
    // Pipeline now prepends the verbatim question so the seed phrasing
    // always feeds the search fan-out.
    const engine = createStubEngine(defaultResults);
    const router = createStubRouter();
    const input: ResearchInput = {
      question: 'Anthropic A2A SDK vs OpenAI Swarm for agent orchestration',
      depth: 'standard',
    };

    const result = await runResearchPipeline(input, [engine], router);

    expect(result.sub_queries[0]).toBe(
      'Anthropic A2A SDK vs OpenAI Swarm for agent orchestration',
    );
    // The verbatim string survives — proves the token wasn't dropped.
    expect(result.sub_queries[0]).toContain('A2A');
  });

  it('does not double-include the original question when the decomposer already produced it', async () => {
    // If the synthetic set happens to include the verbatim question (case-
    // insensitive), the prepend is a no-op so we don't waste a search slot.
    const engine = createStubEngine(defaultResults);
    const router = createStubRouter();
    // 'react hooks' is short enough that decompose-fallback may emit it
    // verbatim as one of the noun-phrase variants.
    const input: ResearchInput = { question: 'React hooks', depth: 'quick' };

    const result = await runResearchPipeline(input, [engine], router);

    const lowered = result.sub_queries.map((q) => q.toLowerCase());
    const occurrences = lowered.filter((q) => q === 'react hooks').length;
    expect(occurrences).toBeLessThanOrEqual(1);
  });

  it('defaults depth to standard when not provided', async () => {
    const engine = createStubEngine(defaultResults);
    const router = createStubRouter();
    const input: ResearchInput = { question: 'What is TypeScript?' };

    const result = await runResearchPipeline(input, [engine], router);

    expect(result.depth).toBe('standard');
    // Original question prepended to the 4 synthetic sub-queries.
    expect(result.sub_queries).toHaveLength(5);
    expect(result.sub_queries[0]).toBe('What is TypeScript?');
  });

  it('respects quick depth (2 synthetic sub-queries + original, fewer sources)', async () => {
    const engine = createStubEngine(defaultResults);
    const router = createStubRouter();
    const input: ResearchInput = { question: 'What is Deno?', depth: 'quick' };

    const result = await runResearchPipeline(input, [engine], router);

    expect(result.depth).toBe('quick');
    expect(result.sub_queries).toHaveLength(3);
    expect(result.sub_queries[0]).toBe('What is Deno?');
    expect(result.sources.length).toBeLessThanOrEqual(8);
  });

  it('respects comprehensive depth (7 synthetic sub-queries + original)', async () => {
    const engine = createStubEngine(defaultResults);
    const router = createStubRouter();
    const input: ResearchInput = {
      question: 'Comprehensive analysis of modern JavaScript build tools',
      depth: 'comprehensive',
    };

    const result = await runResearchPipeline(input, [engine], router);

    expect(result.depth).toBe('comprehensive');
    // 7 synthetic + original (deduped if the synthetic set already contains it
    // case-insensitively, so length is 7 or 8).
    expect(result.sub_queries.length).toBeGreaterThanOrEqual(7);
    expect(result.sub_queries.length).toBeLessThanOrEqual(8);
    expect(result.sub_queries[0]).toBe('Comprehensive analysis of modern JavaScript build tools');
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

  // Parity attack 7 / slice 1: in keyless template mode (no sampling server,
  // no local LLM), the returned `report` must be the rendered brief — the
  // organized "— Research Brief" document — NOT the flat buildFallbackReport
  // per-source dump. WHY: this is the parity lever vs an LLM essay; a flat
  // source dump was the C1 benchmark gap.
  it('template mode renders the brief into the report (not the flat dump)', async () => {
    const engine = createStubEngine(defaultResults);
    const router = createStubRouter();
    const input: ResearchInput = {
      question: 'Compare frontend state management approaches',
      depth: 'standard',
    };

    const result = await runResearchPipeline(input, [engine], router);

    // The rendered-brief title is the signature of the new renderer.
    expect(result.report).toContain('— Research Brief');
    expect(result.report).toContain('### Sources');
    // The old flat-dump header must NOT be what we returned.
    expect(result.report).not.toMatch(/^## Research: /);
    // The brief is still attached for host-LLM consumers.
    expect(result.brief).toBeDefined();
  });

  // WHY: when the brief is unavailable the renderer can't run, so the ultimate
  // safety net (buildFallbackReport via synthesizeReport) must still produce a
  // report. Sampling mode sets brief=undefined; the report must be untouched
  // by the renderer.
  it('does not render a brief when sampling produced the report', async () => {
    const engine = createStubEngine(defaultResults);
    const router = createStubRouter();
    const input: ResearchInput = { question: 'Sampling report test', depth: 'quick' };

    const samplingServer = {
      getClientCapabilities: () => ({ sampling: {} }),
      createMessage: vi.fn().mockResolvedValue({
        content: { type: 'text', text: 'An LLM-authored synthesis report [1].' },
      }),
    } as any;

    const result = await runResearchPipeline(input, [engine], router, samplingServer);

    // Sampling path keeps its own report and attaches no brief.
    expect(result.report).toContain('LLM-authored synthesis report');
    expect(result.report).not.toContain('— Research Brief');
    expect(result.brief).toBeUndefined();
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
