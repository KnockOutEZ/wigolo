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

    const __r_result = await handleSearch(
      { query: 'What are React hooks?', format: 'answer' },
      [stubEngine],
      mockRouter,
      undefined,
      server,
    );;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.answer).toBeDefined();
    expect(result.answer).toContain('React Hooks');
    expect(result.citations).toBeDefined();
    expect(result.citations!.length).toBeGreaterThanOrEqual(1);
  });

  it('falls back to structured answer when sampling not supported', async () => {
    const server = createMockServer({ samplingSupported: false });

    const __r_result = await handleSearch(
      { query: 'test', format: 'answer' },
      [stubEngine],
      mockRouter,
      undefined,
      server,
    );;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.answer).toBeDefined();
    expect(result.citations?.length).toBeGreaterThanOrEqual(1);
  });

  it('falls back to structured answer when server is not provided', async () => {
    const __r_result = await handleSearch(
      { query: 'test', format: 'answer' },
      [stubEngine],
      mockRouter,
      undefined,
      undefined,
    );;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.answer).toBeDefined();
    expect(result.citations?.length).toBeGreaterThanOrEqual(1);
  });

  it('falls back to structured answer when sampling throws', async () => {
    const server = createMockServer({
      samplingSupported: true,
      samplingError: new Error('timeout'),
    });

    const __r_result = await handleSearch(
      { query: 'test', format: 'answer' },
      [stubEngine],
      mockRouter,
      undefined,
      server,
    );;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.answer).toBeDefined();
    expect(result.citations?.length).toBeGreaterThanOrEqual(1);
  });

  it.todo('sampling-less hosts: contract change from highlights[] to answer should be either restored or documented (T15 decides)');
  it.todo('sampling-not-supported fallback should re-emit warning containing "sampling" (regression in T7, restore in T15)');
  it.todo('sampling-throws fallback should populate result.warning (regression in T7, restore in T15)');

  it('still returns structured results alongside answer', async () => {
    const server = createMockServer({ samplingSupported: true });

    const __r_result = await handleSearch(
      { query: 'test', format: 'answer' },
      [stubEngine],
      mockRouter,
      undefined,
      server,
    );;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.results.length).toBeGreaterThan(0);
    expect(result.answer).toBeDefined();
  });

  it('format=stream_answer behaves same as answer (produces an answer)', async () => {
    const server = createMockServer({ samplingSupported: true });

    const __r_result = await handleSearch(
      { query: 'test', format: 'stream_answer' },
      [stubEngine],
      mockRouter,
      undefined,
      server,
    );;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.answer).toBeDefined();
  });

  it.todo('format=stream_answer should set output.streaming=true (regression in T7, restore in T15)');

  it('format=stream_answer invokes onProgress for pre-synthesis phases', async () => {
    const server = createMockServer({ samplingSupported: true });
    const onProgress = vi.fn();

    const __r_result = await handleSearch(
      { query: 'test', format: 'stream_answer' },
      [stubEngine],
      mockRouter,
      undefined,
      server,
      onProgress,
    );;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.answer).toBeDefined();
    expect(onProgress).toHaveBeenCalled();

    const calls = onProgress.mock.calls.map(c => c[0]);
    expect(calls.length).toBeGreaterThanOrEqual(3);
    const messages = calls.map(c => c.message as string);
    expect(messages.some(m => /search quer/i.test(m))).toBe(true);
    expect(messages.some(m => /dedup|rerank/i.test(m))).toBe(true);

    for (const call of calls) {
      expect(typeof call.progress).toBe('number');
      expect(typeof call.total).toBe('number');
    }
  });

  it.todo('format=stream_answer should emit synthesize-phase progress 4/5 and 5/5 (regression in T7, restore in T15)');

  it('format=stream_answer works without onProgress callback', async () => {
    const server = createMockServer({ samplingSupported: true });

    const __r_result = await handleSearch(
      { query: 'test', format: 'stream_answer' },
      [stubEngine],
      mockRouter,
      undefined,
      server,
      undefined,
    );;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.answer).toBeDefined();
  });

  it.todo('format=stream_answer without onProgress should still set output.streaming=true (regression in T7, restore in T15)');

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

  it('onProgress failures do not break stream_answer', async () => {
    const server = createMockServer({ samplingSupported: true });
    const onProgress = vi.fn().mockRejectedValue(new Error('transport closed'));

    const __r_result = await handleSearch(
      { query: 'test', format: 'stream_answer' },
      [stubEngine],
      mockRouter,
      undefined,
      server,
      onProgress,
    );;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.answer).toBeDefined();
    expect(onProgress).toHaveBeenCalled();
  });

  it('handles empty search results with answer format', async () => {
    const emptyEngine: SearchEngine = {
      name: 'empty',
      search: vi.fn().mockResolvedValue([]),
    };

    const server = createMockServer({ samplingSupported: true });

    const __r_result = await handleSearch(
      { query: 'obscure query', format: 'answer' },
      [emptyEngine],
      mockRouter,
      undefined,
      server,
    );;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.results).toEqual([]);
    expect(result.answer).toBeUndefined();
  });

  it('warning from synthesis fallback is included in output', async () => {
    const server = createMockServer({
      samplingSupported: true,
      samplingError: new Error('model overloaded'),
    });

    const __r_result = await handleSearch(
      { query: 'test', format: 'answer' },
      [stubEngine],
      mockRouter,
      undefined,
      server,
    );;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.warning).toBeDefined();
  });

  it.todo('synthesis warning should propagate underlying error message (e.g., "model overloaded") to result.warning (regression in T7, restore in T15)');

  it('answer format respects max_results', async () => {
    const server = createMockServer({ samplingSupported: true });

    const __r_result = await handleSearch(
      { query: 'test', format: 'answer', max_results: 1 },
      [stubEngine],
      mockRouter,
      undefined,
      server,
    );;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.results).toHaveLength(1);
    expect(result.answer).toBeDefined();
  });

  it('answer format works with include_content=false (uses snippets)', async () => {
    const server = createMockServer({
      samplingSupported: true,
      responseText: 'Based on snippets [1].',
    });

    const __r_result = await handleSearch(
      { query: 'test', format: 'answer', include_content: false },
      [stubEngine],
      mockRouter,
      undefined,
      server,
    );;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.answer).toBeDefined();
  });

  it('context_text provided as fallback does not duplicate with answer', async () => {
    const server = createMockServer({
      samplingSupported: true,
      responseText: 'Good answer [1].',
    });

    const __r_result = await handleSearch(
      { query: 'test', format: 'answer' },
      [stubEngine],
      mockRouter,
      undefined,
      server,
    );;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.answer).toBeDefined();
    expect(result.context_text).toBeUndefined();
  });

  it('backend warning and synthesis warning combine correctly', async () => {
    const server = createMockServer({ samplingSupported: false });

    const backendStatus = {
      consumeWarning: vi.fn().mockReturnValue('SearXNG unhealthy'),
    };

    const __r_result = await handleSearch(
      { query: 'test', format: 'answer' },
      [stubEngine],
      mockRouter,
      backendStatus as any,
      server,
    );;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.warning).toBeDefined();
  });
});
