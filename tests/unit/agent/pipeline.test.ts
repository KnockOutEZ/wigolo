import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runAgentPipeline } from '../../../src/agent/pipeline.js';
import type { SearchEngine, RawSearchResult, AgentInput } from '../../../src/types.js';
import type { SmartRouter } from '../../../src/fetch/router.js';

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
      html: '<html><body><h1>Title</h1><p>Content about pricing and features.</p></body></html>',
      contentType: 'text/html',
      statusCode: 200,
      method: 'http' as const,
      headers: {},
    }),
  } as unknown as SmartRouter;
}

const defaultResults: RawSearchResult[] = [
  { title: 'CRM Pricing', url: 'https://example.com/crm-pricing', snippet: 'CRM pricing comparison', relevance_score: 0.95, engine: 'stub' },
  { title: 'Best CRM 2025', url: 'https://example.com/best-crm', snippet: 'Top CRM tools', relevance_score: 0.88, engine: 'stub' },
];

describe('runAgentPipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs full pipeline: plan -> execute -> synthesize', async () => {
    const engine = createStubEngine(defaultResults);
    const router = createStubRouter();
    const input: AgentInput = { prompt: 'Find pricing for top CRM tools' };

    const result = await runAgentPipeline(input, [engine], router);

    expect(result.result).toBeDefined();
    expect(result.sources.length).toBeGreaterThan(0);
    expect(result.pages_fetched).toBeGreaterThan(0);
    expect(result.steps.length).toBeGreaterThan(0);
    expect(result.total_time_ms).toBeGreaterThanOrEqual(0);
    expect(typeof result.sampling_supported).toBe('boolean');
    expect(result.error).toBeUndefined();
  });

  it('includes plan step in steps array', async () => {
    const engine = createStubEngine(defaultResults);
    const router = createStubRouter();
    const input: AgentInput = { prompt: 'Find data' };

    const result = await runAgentPipeline(input, [engine], router);

    const planStep = result.steps.find((s) => s.action === 'plan');
    expect(planStep).toBeDefined();
    expect(planStep!.time_ms).toBeGreaterThanOrEqual(0);
  });

  it('includes synthesize step in steps array', async () => {
    const engine = createStubEngine(defaultResults);
    const router = createStubRouter();
    const input: AgentInput = { prompt: 'Find data' };

    const result = await runAgentPipeline(input, [engine], router);

    const synthStep = result.steps.find((s) => s.action === 'synthesize');
    expect(synthStep).toBeDefined();
  });

  it('respects max_pages', async () => {
    const engine = createStubEngine(defaultResults);
    const router = createStubRouter();
    const input: AgentInput = { prompt: 'Find data', max_pages: 2 };

    const result = await runAgentPipeline(input, [engine], router);

    expect(result.pages_fetched).toBeLessThanOrEqual(2);
  });

  it('respects max_time_ms', async () => {
    const engine = createStubEngine(defaultResults);
    const router = createStubRouter();
    const input: AgentInput = { prompt: 'Find data', max_time_ms: 60000 };

    const result = await runAgentPipeline(input, [engine], router);

    expect(result.total_time_ms).toBeLessThanOrEqual(65000);
  });

  it('uses explicit URLs from input', async () => {
    const engine = createStubEngine([]);
    const router = createStubRouter();
    const input: AgentInput = {
      prompt: 'Check these pages',
      urls: ['https://example.com/page1', 'https://example.com/page2'],
    };

    const result = await runAgentPipeline(input, [engine], router);

    expect(result.sources.length).toBeGreaterThanOrEqual(2);
  });

  it('applies schema extraction when schema is provided', async () => {
    const router = {
      fetch: vi.fn().mockResolvedValue({
        url: 'https://example.com',
        finalUrl: 'https://example.com',
        html: '<html><body><span class="price">$49.99</span><h1 class="name">Product X</h1></body></html>',
        contentType: 'text/html',
        statusCode: 200,
        method: 'http' as const,
        headers: {},
      }),
    } as unknown as SmartRouter;
    const engine = createStubEngine(defaultResults);
    const input: AgentInput = {
      prompt: 'Extract product info',
      schema: {
        type: 'object',
        properties: {
          price: { type: 'string' },
          name: { type: 'string' },
        },
      },
    };

    const result = await runAgentPipeline(input, [engine], router);

    expect(result.result).toBeDefined();
    const extractStep = result.steps.find((s) => s.action === 'extract');
    expect(extractStep).toBeDefined();
  });

  it('handles empty prompt', async () => {
    const engine = createStubEngine([]);
    const router = createStubRouter();
    const input: AgentInput = { prompt: '' };

    const result = await runAgentPipeline(input, [engine], router);

    expect(result).toBeDefined();
    expect(result.steps.length).toBeGreaterThan(0);
  });

  it('handles all search engines failing', async () => {
    const brokenEngine: SearchEngine = {
      name: 'broken',
      search: vi.fn().mockRejectedValue(new Error('all broken')),
    };
    const router = createStubRouter();
    const input: AgentInput = { prompt: 'Find data' };

    const result = await runAgentPipeline(input, [brokenEngine], router);

    expect(result).toBeDefined();
    expect(result.error).toBeUndefined();
  });

  it('handles all fetches failing', async () => {
    const engine = createStubEngine(defaultResults);
    const brokenRouter = {
      fetch: vi.fn().mockRejectedValue(new Error('network down')),
    } as unknown as SmartRouter;
    const input: AgentInput = { prompt: 'Find data' };

    const result = await runAgentPipeline(input, [engine], brokenRouter);

    expect(result).toBeDefined();
    expect(result.sources.some((s) => s.fetch_error)).toBe(true);
  });

  it('pages_fetched matches actual successful fetches', async () => {
    const engine = createStubEngine(defaultResults);
    const router = createStubRouter();
    const input: AgentInput = { prompt: 'Count test' };

    const result = await runAgentPipeline(input, [engine], router);

    const actualFetched = result.sources.filter((s) => s.fetched).length;
    expect(result.pages_fetched).toBe(actualFetched);
  });

  it('sampling_supported is false without server', async () => {
    const engine = createStubEngine(defaultResults);
    const router = createStubRouter();
    const input: AgentInput = { prompt: 'Test' };

    const result = await runAgentPipeline(input, [engine], router);

    expect(result.sampling_supported).toBe(false);
  });

  it('steps have valid action types', async () => {
    const engine = createStubEngine(defaultResults);
    const router = createStubRouter();
    const input: AgentInput = { prompt: 'Step validation test' };

    const result = await runAgentPipeline(input, [engine], router);

    const validActions = new Set(['plan', 'search', 'fetch', 'extract', 'synthesize']);
    for (const step of result.steps) {
      expect(validActions.has(step.action)).toBe(true);
    }
  });

  it('returns string result when no schema provided', async () => {
    const engine = createStubEngine(defaultResults);
    const router = createStubRouter();
    const input: AgentInput = { prompt: 'Find info' };

    const result = await runAgentPipeline(input, [engine], router);

    expect(typeof result.result).toBe('string');
  });

  it('total_time_ms reflects execution duration', async () => {
    const engine = createStubEngine(defaultResults);
    const router = createStubRouter();
    const input: AgentInput = { prompt: 'Timing test' };

    const before = Date.now();
    const result = await runAgentPipeline(input, [engine], router);
    const after = Date.now();

    expect(result.total_time_ms).toBeGreaterThanOrEqual(0);
    expect(result.total_time_ms).toBeLessThanOrEqual(after - before + 100);
  });

  it('handles concurrent access safely', async () => {
    const engine = createStubEngine(defaultResults);
    const router = createStubRouter();

    const results = await Promise.all([
      runAgentPipeline({ prompt: 'Task A' }, [engine], router),
      runAgentPipeline({ prompt: 'Task B' }, [engine], router),
      runAgentPipeline({ prompt: 'Task C' }, [engine], router),
    ]);

    for (const result of results) {
      expect(result.error).toBeUndefined();
      expect(result.steps.length).toBeGreaterThan(0);
    }
  });
});
