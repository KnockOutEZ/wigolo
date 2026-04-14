import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentStep, AgentSource, SearchEngine, RawSearchResult } from '../../../src/types.js';
import type { SmartRouter } from '../../../src/fetch/router.js';
import type { AgentPlan } from '../../../src/agent/planner.js';

vi.mock('../../../src/extraction/pipeline.js', () => ({
  extractContent: vi.fn().mockResolvedValue({
    title: 'Extracted Title',
    markdown: '# Content\n\nPage content for testing.',
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

const { executeAgentPlan } = await import('../../../src/agent/executor.js');

function createStubEngine(results: RawSearchResult[] = []): SearchEngine {
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
      html: '<html><body><h1>Title</h1><p>Page content for testing.</p></body></html>',
      contentType: 'text/html',
      statusCode: 200,
      method: 'http' as const,
      headers: {},
    }),
  } as unknown as SmartRouter;
}

const defaultSearchResults: RawSearchResult[] = [
  { title: 'Result 1', url: 'https://example.com/1', snippet: 'First result', relevance_score: 0.95, engine: 'stub' },
  { title: 'Result 2', url: 'https://example.com/2', snippet: 'Second result', relevance_score: 0.85, engine: 'stub' },
  { title: 'Result 3', url: 'https://example.com/3', snippet: 'Third result', relevance_score: 0.75, engine: 'stub' },
];

describe('executeAgentPlan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('executes search queries and returns sources', async () => {
    const plan: AgentPlan = { searches: ['CRM pricing', 'best CRM tools'], urls: [], notes: '', samplingUsed: false };
    const engine = createStubEngine(defaultSearchResults);
    const router = createStubRouter();

    const result = await executeAgentPlan(plan, [engine], router, { maxPages: 10, deadlineMs: Date.now() + 60000 });

    expect(result.sources.length).toBeGreaterThan(0);
    expect(result.steps.length).toBeGreaterThan(0);
    expect(result.steps.some((s) => s.action === 'search')).toBe(true);
    expect(result.steps.some((s) => s.action === 'fetch')).toBe(true);
  });

  it('fetches explicit URLs from plan', async () => {
    const plan: AgentPlan = { searches: [], urls: ['https://example.com/pricing', 'https://example.com/about'], notes: '', samplingUsed: false };
    const engine = createStubEngine([]);
    const router = createStubRouter();

    const result = await executeAgentPlan(plan, [engine], router, { maxPages: 10, deadlineMs: Date.now() + 60000 });

    expect(result.sources.length).toBe(2);
    expect(result.steps.some((s) => s.action === 'fetch')).toBe(true);
  });

  it('combines search results and explicit URLs', async () => {
    const plan: AgentPlan = { searches: ['CRM tools'], urls: ['https://example.com/explicit'], notes: '', samplingUsed: false };
    const engine = createStubEngine(defaultSearchResults);
    const router = createStubRouter();

    const result = await executeAgentPlan(plan, [engine], router, { maxPages: 10, deadlineMs: Date.now() + 60000 });

    expect(result.sources.length).toBeGreaterThan(1);
  });

  it('respects max_pages budget', async () => {
    const plan: AgentPlan = { searches: ['query 1', 'query 2'], urls: ['https://example.com/1', 'https://example.com/2', 'https://example.com/3'], notes: '', samplingUsed: false };
    const engine = createStubEngine(defaultSearchResults);
    const router = createStubRouter();

    const result = await executeAgentPlan(plan, [engine], router, { maxPages: 3, deadlineMs: Date.now() + 60000 });

    expect(result.sources.filter((s) => s.fetched).length).toBeLessThanOrEqual(3);
  });

  it('respects deadline and stops fetching', async () => {
    const plan: AgentPlan = { searches: ['slow query'], urls: ['https://example.com/slow1', 'https://example.com/slow2', 'https://example.com/slow3'], notes: '', samplingUsed: false };
    const slowRouter = {
      fetch: vi.fn().mockImplementation(() =>
        new Promise((resolve) =>
          setTimeout(() => resolve({
            url: 'https://example.com',
            finalUrl: 'https://example.com',
            html: '<html><body><p>Content</p></body></html>',
            contentType: 'text/html',
            statusCode: 200,
            method: 'http' as const,
            headers: {},
          }), 100),
        ),
      ),
    } as unknown as SmartRouter;
    const engine = createStubEngine([]);

    const result = await executeAgentPlan(plan, [engine], slowRouter, { maxPages: 10, deadlineMs: Date.now() + 50 });

    expect(result.steps.length).toBeGreaterThan(0);
  });

  it('records step for each action with timing', async () => {
    const plan: AgentPlan = { searches: ['test query'], urls: [], notes: '', samplingUsed: false };
    const engine = createStubEngine(defaultSearchResults);
    const router = createStubRouter();

    const result = await executeAgentPlan(plan, [engine], router, { maxPages: 10, deadlineMs: Date.now() + 60000 });

    for (const step of result.steps) {
      expect(['plan', 'search', 'fetch', 'extract', 'synthesize']).toContain(step.action);
      expect(typeof step.detail).toBe('string');
      expect(step.detail.length).toBeGreaterThan(0);
      expect(typeof step.time_ms).toBe('number');
      expect(step.time_ms).toBeGreaterThanOrEqual(0);
    }
  });

  it('handles search engine failure gracefully', async () => {
    const plan: AgentPlan = { searches: ['broken query'], urls: [], notes: '', samplingUsed: false };
    const brokenEngine: SearchEngine = { name: 'broken', search: vi.fn().mockRejectedValue(new Error('engine crashed')) };
    const router = createStubRouter();

    const result = await executeAgentPlan(plan, [brokenEngine], router, { maxPages: 10, deadlineMs: Date.now() + 60000 });

    expect(result).toBeDefined();
    expect(result.steps.length).toBeGreaterThan(0);
  });

  it('handles fetch failure for individual URLs', async () => {
    const plan: AgentPlan = { searches: [], urls: ['https://broken.com', 'https://working.com'], notes: '', samplingUsed: false };
    let callCount = 0;
    const flakeyRouter = {
      fetch: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.reject(new Error('connection refused'));
        return Promise.resolve({
          url: 'https://working.com', finalUrl: 'https://working.com',
          html: '<html><body><p>Working</p></body></html>', contentType: 'text/html',
          statusCode: 200, method: 'http' as const, headers: {},
        });
      }),
    } as unknown as SmartRouter;
    const engine = createStubEngine([]);

    const result = await executeAgentPlan(plan, [engine], flakeyRouter, { maxPages: 10, deadlineMs: Date.now() + 60000 });

    expect(result.sources.filter((s) => s.fetch_error).length).toBeGreaterThan(0);
    expect(result.sources.filter((s) => s.fetched).length).toBeGreaterThan(0);
  });

  it('deduplicates URLs from search results', async () => {
    const duplicateResults: RawSearchResult[] = [
      { title: 'Same', url: 'https://example.com/same', snippet: 'dup', relevance_score: 0.9, engine: 'stub' },
      { title: 'Same Again', url: 'https://example.com/same', snippet: 'dup2', relevance_score: 0.8, engine: 'stub' },
    ];
    const plan: AgentPlan = { searches: ['dup test'], urls: [], notes: '', samplingUsed: false };
    const engine = createStubEngine(duplicateResults);
    const router = createStubRouter();

    const result = await executeAgentPlan(plan, [engine], router, { maxPages: 10, deadlineMs: Date.now() + 60000 });

    const urls = result.sources.map((s) => s.url);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it('handles empty plan (no searches, no urls)', async () => {
    const plan: AgentPlan = { searches: [], urls: [], notes: '', samplingUsed: false };
    const engine = createStubEngine([]);
    const router = createStubRouter();

    const result = await executeAgentPlan(plan, [engine], router, { maxPages: 10, deadlineMs: Date.now() + 60000 });

    expect(result.sources).toHaveLength(0);
  });

  it('sources have correct structure', async () => {
    const plan: AgentPlan = { searches: ['test'], urls: [], notes: '', samplingUsed: false };
    const engine = createStubEngine(defaultSearchResults);
    const router = createStubRouter();

    const result = await executeAgentPlan(plan, [engine], router, { maxPages: 10, deadlineMs: Date.now() + 60000 });

    for (const source of result.sources) {
      expect(typeof source.url).toBe('string');
      expect(typeof source.title).toBe('string');
      expect(typeof source.markdown_content).toBe('string');
      expect(typeof source.fetched).toBe('boolean');
    }
  });

  it('caches fetched content', async () => {
    const plan: AgentPlan = { searches: [], urls: ['https://example.com/cache-test'], notes: '', samplingUsed: false };
    const engine = createStubEngine([]);
    const router = createStubRouter();

    const result = await executeAgentPlan(plan, [engine], router, { maxPages: 10, deadlineMs: Date.now() + 60000 });

    expect(result.sources.length).toBe(1);
    expect(result.sources[0].fetched).toBe(true);
  });
});
