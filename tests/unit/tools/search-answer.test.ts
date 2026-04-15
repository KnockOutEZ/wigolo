import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SearchInput, SearchEngine, RawSearchResult } from '../../../src/types.js';
import type { SmartRouter } from '../../../src/fetch/router.js';
import { resetConfig } from '../../../src/config.js';
import { initDatabase, closeDatabase } from '../../../src/cache/db.js';

vi.mock('../../../src/extraction/pipeline.js', () => ({
  extractContent: vi.fn().mockResolvedValue({
    title: 'Mock Title',
    markdown: '# Mock Content\n\nExtracted content.',
    metadata: {},
    links: [],
    images: [],
    extractor: 'defuddle' as const,
  }),
}));

const { handleSearch } = await import('../../../src/tools/search.js');

function createMockServer(opts: {
  samplingSupported?: boolean;
  responseText?: string;
  samplingError?: Error;
} = {}) {
  return {
    getClientCapabilities: vi.fn().mockReturnValue(
      opts.samplingSupported !== false ? { sampling: {} } : {},
    ),
    createMessage: opts.samplingError
      ? vi.fn().mockRejectedValue(opts.samplingError)
      : vi.fn().mockResolvedValue({
          model: 'test-model',
          content: {
            type: 'text',
            text: opts.responseText ?? 'This is a synthesized answer about the topic [1].',
          },
        }),
  };
}

describe('handleSearch with format=answer', () => {
  const originalEnv = process.env;

  const stubEngine: SearchEngine = {
    name: 'stub',
    search: vi.fn().mockResolvedValue([
      {
        title: 'React Hooks',
        url: 'https://react.dev/hooks',
        snippet: 'Hooks let you use state.',
        relevance_score: 0.95,
        engine: 'stub',
      },
      {
        title: 'Vue API',
        url: 'https://vuejs.org/api',
        snippet: 'The Composition API.',
        relevance_score: 0.85,
        engine: 'stub',
      },
    ] satisfies RawSearchResult[]),
  };

  const mockRouter = {
    fetch: vi.fn().mockResolvedValue({
      url: 'https://react.dev/hooks',
      finalUrl: 'https://react.dev/hooks',
      html: '<html><body><h1>Test</h1><p>Content</p></body></html>',
      contentType: 'text/html',
      statusCode: 200,
      method: 'http' as const,
      headers: {},
    }),
  } as unknown as SmartRouter;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      VALIDATE_LINKS: 'false',
      LOG_LEVEL: 'error',
    };
    resetConfig();
    initDatabase(':memory:');
    vi.clearAllMocks();
  });

  afterEach(() => {
    closeDatabase();
    process.env = originalEnv;
    resetConfig();
  });

  it('returns answer and citations when format=answer and sampling supported', async () => {
    const server = createMockServer({
      samplingSupported: true,
      responseText: 'React Hooks enable state management [1].',
    });

    const result = await handleSearch(
      { query: 'What are React hooks?', format: 'answer' },
      [stubEngine],
      mockRouter,
      undefined,
      server,
    );

    expect(result.answer).toBeDefined();
    expect(result.answer).toContain('React Hooks');
    expect(result.citations).toBeDefined();
    expect(result.citations!.length).toBeGreaterThanOrEqual(1);
  });

  it('falls back to heuristic key-point summary when sampling not supported', async () => {
    const server = createMockServer({ samplingSupported: false });

    const result = await handleSearch(
      { query: 'test', format: 'answer' },
      [stubEngine],
      mockRouter,
      undefined,
      server,
    );

    expect(result.answer).toBeDefined();
    expect(result.answer).toContain('[1]');
    expect(result.citations?.length).toBeGreaterThanOrEqual(1);
    expect(result.warning).toContain('sampling');
  });

  it('falls back to heuristic summary when server is not provided', async () => {
    const result = await handleSearch(
      { query: 'test', format: 'answer' },
      [stubEngine],
      mockRouter,
      undefined,
      undefined,
    );

    expect(result.answer).toBeDefined();
    expect(result.answer).toContain('[1]');
    expect(result.citations?.length).toBeGreaterThanOrEqual(1);
  });

  it('falls back to heuristic summary when sampling throws', async () => {
    const server = createMockServer({
      samplingSupported: true,
      samplingError: new Error('timeout'),
    });

    const result = await handleSearch(
      { query: 'test', format: 'answer' },
      [stubEngine],
      mockRouter,
      undefined,
      server,
    );

    expect(result.answer).toBeDefined();
    expect(result.citations?.length).toBeGreaterThanOrEqual(1);
    expect(result.warning).toBeDefined();
  });

  it('still returns structured results alongside answer', async () => {
    const server = createMockServer({ samplingSupported: true });

    const result = await handleSearch(
      { query: 'test', format: 'answer' },
      [stubEngine],
      mockRouter,
      undefined,
      server,
    );

    expect(result.results.length).toBeGreaterThan(0);
    expect(result.answer).toBeDefined();
  });

  it('format=stream_answer behaves same as answer (streaming flag set)', async () => {
    const server = createMockServer({ samplingSupported: true });

    const result = await handleSearch(
      { query: 'test', format: 'stream_answer' },
      [stubEngine],
      mockRouter,
      undefined,
      server,
    );

    expect(result.answer).toBeDefined();
    expect(result.streaming).toBe(true);
  });

  it('format=stream_answer invokes onProgress at each pipeline phase', async () => {
    const server = createMockServer({ samplingSupported: true });
    const onProgress = vi.fn();

    const result = await handleSearch(
      { query: 'test', format: 'stream_answer' },
      [stubEngine],
      mockRouter,
      undefined,
      server,
      onProgress,
    );

    expect(result.answer).toBeDefined();
    expect(onProgress).toHaveBeenCalled();

    const calls = onProgress.mock.calls.map(c => c[0]);
    // Expect: search (1/5), dedup (2/5), fetch (3/5), synthesize (4/5), complete (5/5)
    expect(calls.length).toBeGreaterThanOrEqual(4);
    const messages = calls.map(c => c.message as string);
    expect(messages.some(m => /search quer/i.test(m))).toBe(true);
    expect(messages.some(m => /dedup|rerank/i.test(m))).toBe(true);
    expect(messages.some(m => /synthesiz/i.test(m))).toBe(true);

    // Each progress update should have numeric progress and total
    for (const call of calls) {
      expect(typeof call.progress).toBe('number');
      expect(typeof call.total).toBe('number');
    }
  });

  it('format=stream_answer works without onProgress callback', async () => {
    const server = createMockServer({ samplingSupported: true });

    const result = await handleSearch(
      { query: 'test', format: 'stream_answer' },
      [stubEngine],
      mockRouter,
      undefined,
      server,
      undefined,
    );

    expect(result.answer).toBeDefined();
    expect(result.streaming).toBe(true);
  });

  it('format=answer does NOT invoke onProgress (progress is stream_answer only)', async () => {
    const server = createMockServer({ samplingSupported: true });
    const onProgress = vi.fn();

    await handleSearch(
      { query: 'test', format: 'answer' },
      [stubEngine],
      mockRouter,
      undefined,
      server,
      onProgress,
    );

    expect(onProgress).not.toHaveBeenCalled();
  });

  it('format=full does NOT invoke onProgress', async () => {
    const server = createMockServer({ samplingSupported: true });
    const onProgress = vi.fn();

    await handleSearch(
      { query: 'test', format: 'full' },
      [stubEngine],
      mockRouter,
      undefined,
      server,
      onProgress,
    );

    expect(onProgress).not.toHaveBeenCalled();
  });

  it('onProgress failures do not break stream_answer', async () => {
    const server = createMockServer({ samplingSupported: true });
    const onProgress = vi.fn().mockRejectedValue(new Error('transport closed'));

    const result = await handleSearch(
      { query: 'test', format: 'stream_answer' },
      [stubEngine],
      mockRouter,
      undefined,
      server,
      onProgress,
    );

    expect(result.answer).toBeDefined();
    expect(onProgress).toHaveBeenCalled();
  });

  it('format=full does not trigger answer synthesis', async () => {
    const server = createMockServer({ samplingSupported: true });

    const result = await handleSearch(
      { query: 'test', format: 'full' },
      [stubEngine],
      mockRouter,
      undefined,
      server,
    );

    expect(result.answer).toBeUndefined();
    expect(result.citations).toBeUndefined();
    expect(server.createMessage).not.toHaveBeenCalled();
  });

  it('format=context does not trigger answer synthesis', async () => {
    const server = createMockServer({ samplingSupported: true });

    const result = await handleSearch(
      { query: 'test', format: 'context', include_content: false },
      [stubEngine],
      mockRouter,
      undefined,
      server,
    );

    expect(result.answer).toBeUndefined();
    expect(result.context_text).toBeDefined();
    expect(server.createMessage).not.toHaveBeenCalled();
  });

  it('handles empty search results with answer format', async () => {
    const emptyEngine: SearchEngine = {
      name: 'empty',
      search: vi.fn().mockResolvedValue([]),
    };

    const server = createMockServer({ samplingSupported: true });

    const result = await handleSearch(
      { query: 'obscure query', format: 'answer' },
      [emptyEngine],
      mockRouter,
      undefined,
      server,
    );

    expect(result.results).toEqual([]);
    expect(result.answer).toBeUndefined();
  });

  it('warning from synthesis is included in output', async () => {
    const server = createMockServer({
      samplingSupported: true,
      samplingError: new Error('model overloaded'),
    });

    const result = await handleSearch(
      { query: 'test', format: 'answer' },
      [stubEngine],
      mockRouter,
      undefined,
      server,
    );

    expect(result.warning).toBeDefined();
    expect(result.warning).toContain('model overloaded');
  });

  it('answer format respects max_results', async () => {
    const server = createMockServer({ samplingSupported: true });

    const result = await handleSearch(
      { query: 'test', format: 'answer', max_results: 1 },
      [stubEngine],
      mockRouter,
      undefined,
      server,
    );

    expect(result.results).toHaveLength(1);
    expect(result.answer).toBeDefined();
  });

  it('answer format works with include_content=false (uses snippets)', async () => {
    const server = createMockServer({
      samplingSupported: true,
      responseText: 'Based on snippets [1].',
    });

    const result = await handleSearch(
      { query: 'test', format: 'answer', include_content: false },
      [stubEngine],
      mockRouter,
      undefined,
      server,
    );

    expect(result.answer).toBeDefined();
  });

  it('context_text provided as fallback does not duplicate with answer', async () => {
    const server = createMockServer({
      samplingSupported: true,
      responseText: 'Good answer [1].',
    });

    const result = await handleSearch(
      { query: 'test', format: 'answer' },
      [stubEngine],
      mockRouter,
      undefined,
      server,
    );

    expect(result.answer).toBeDefined();
    expect(result.context_text).toBeUndefined();
  });

  it('backend warning and synthesis warning combine correctly', async () => {
    const server = createMockServer({ samplingSupported: false });

    const backendStatus = {
      consumeWarning: vi.fn().mockReturnValue('SearXNG unhealthy'),
    };

    const result = await handleSearch(
      { query: 'test', format: 'answer' },
      [stubEngine],
      mockRouter,
      backendStatus as any,
      server,
    );

    expect(result.warning).toBeDefined();
  });
});
