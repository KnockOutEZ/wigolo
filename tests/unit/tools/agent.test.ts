import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleAgent } from '../../../src/tools/agent.js';
import type { SearchEngine, RawSearchResult, AgentInput } from '../../../src/types.js';
import type { SmartRouter } from '../../../src/fetch/router.js';

const stubEngine: SearchEngine = {
  name: 'test-stub',
  search: vi.fn().mockResolvedValue([
    { title: 'Result 1', url: 'https://example.com/1', snippet: 'Content 1', relevance_score: 0.9, engine: 'test-stub' },
  ] as RawSearchResult[]),
};

const stubRouter = {
  fetch: vi.fn().mockResolvedValue({
    url: 'https://example.com/1',
    finalUrl: 'https://example.com/1',
    html: '<html><body><h1>Title</h1><p>Content.</p></body></html>',
    contentType: 'text/html',
    statusCode: 200,
    method: 'http' as const,
    headers: {},
  }),
} as unknown as SmartRouter;

describe('handleAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns structured AgentOutput', async () => {
    const input: AgentInput = { prompt: 'Find CRM pricing' };

    const result = await handleAgent(input, [stubEngine], stubRouter);

    expect(result.result).toBeDefined();
    expect(result.sources).toBeDefined();
    expect(Array.isArray(result.sources)).toBe(true);
    expect(typeof result.pages_fetched).toBe('number');
    expect(result.steps).toBeDefined();
    expect(Array.isArray(result.steps)).toBe(true);
    expect(typeof result.total_time_ms).toBe('number');
    expect(typeof result.sampling_supported).toBe('boolean');
  });

  it('validates prompt is required', async () => {
    const input = {} as AgentInput;

    const result = await handleAgent(input, [stubEngine], stubRouter);

    expect(result.error).toBeDefined();
    expect(result.error).toContain('prompt');
  });

  it('validates empty prompt', async () => {
    const input: AgentInput = { prompt: '' };

    const result = await handleAgent(input, [stubEngine], stubRouter);

    expect(result.error).toBeDefined();
  });

  it('validates max_pages is positive', async () => {
    const input: AgentInput = { prompt: 'test', max_pages: 0 };

    const result = await handleAgent(input, [stubEngine], stubRouter);

    expect(result.error).toBeDefined();
    expect(result.error).toContain('max_pages');
  });

  it('validates max_pages is not too large', async () => {
    const input: AgentInput = { prompt: 'test', max_pages: 1000 };

    const result = await handleAgent(input, [stubEngine], stubRouter);

    expect(result.error).toBeDefined();
  });

  it('validates max_time_ms is positive', async () => {
    const input: AgentInput = { prompt: 'test', max_time_ms: 0 };

    const result = await handleAgent(input, [stubEngine], stubRouter);

    expect(result.error).toBeDefined();
    expect(result.error).toContain('max_time_ms');
  });

  it('validates max_time_ms is not too large', async () => {
    const input: AgentInput = { prompt: 'test', max_time_ms: 600001 };

    const result = await handleAgent(input, [stubEngine], stubRouter);

    expect(result.error).toBeDefined();
  });

  it('accepts valid max_pages', async () => {
    const input: AgentInput = { prompt: 'Find data', max_pages: 5 };

    const result = await handleAgent(input, [stubEngine], stubRouter);

    expect(result.error).toBeUndefined();
    expect(result.pages_fetched).toBeLessThanOrEqual(5);
  });

  it('accepts valid max_time_ms', async () => {
    const input: AgentInput = { prompt: 'Find data', max_time_ms: 30000 };

    const result = await handleAgent(input, [stubEngine], stubRouter);

    expect(result.error).toBeUndefined();
  });

  it('passes urls through to pipeline', async () => {
    const input: AgentInput = {
      prompt: 'Check these',
      urls: ['https://example.com/a', 'https://example.com/b'],
    };

    const result = await handleAgent(input, [stubEngine], stubRouter);

    expect(result.error).toBeUndefined();
    expect(result.sources.length).toBeGreaterThanOrEqual(2);
  });

  it('passes schema through to pipeline', async () => {
    const input: AgentInput = {
      prompt: 'Extract product data',
      schema: { type: 'object', properties: { name: { type: 'string' } } },
    };

    const result = await handleAgent(input, [stubEngine], stubRouter);

    expect(result.error).toBeUndefined();
  });

  it('never throws -- always returns structured output', async () => {
    const result = await handleAgent(
      { prompt: 'test' },
      [],
      stubRouter,
    );

    expect(result).toBeDefined();
    expect(result.result).toBeDefined();
  });

  it('handles engine failure gracefully', async () => {
    const brokenEngine: SearchEngine = {
      name: 'broken',
      search: vi.fn().mockRejectedValue(new Error('engine down')),
    };

    const result = await handleAgent(
      { prompt: 'Error test' },
      [brokenEngine],
      stubRouter,
    );

    expect(result).toBeDefined();
    expect(typeof result.total_time_ms).toBe('number');
  });

  it('handles router failure gracefully', async () => {
    const brokenRouter = {
      fetch: vi.fn().mockRejectedValue(new Error('network down')),
    } as unknown as SmartRouter;

    const result = await handleAgent(
      { prompt: 'Router error test' },
      [stubEngine],
      brokenRouter,
    );

    expect(result).toBeDefined();
  });

  it('sampling_supported is false when no server provided', async () => {
    const result = await handleAgent(
      { prompt: 'test' },
      [stubEngine],
      stubRouter,
    );

    expect(result.sampling_supported).toBe(false);
  });

  it('validates urls contains valid URL strings', async () => {
    const input: AgentInput = {
      prompt: 'test',
      urls: ['not-a-url', 'also-not-valid'],
    };

    const result = await handleAgent(input, [stubEngine], stubRouter);

    expect(result.error).toBeDefined();
    expect(result.error).toContain('url');
  });
});
