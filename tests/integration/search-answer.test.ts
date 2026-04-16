import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SearchEngine, RawSearchResult } from '../../src/types.js';
import type { SmartRouter } from '../../src/fetch/router.js';
import { resetConfig } from '../../src/config.js';
import { initDatabase, closeDatabase } from '../../src/cache/db.js';

vi.mock('../../src/extraction/pipeline.js', () => ({
  extractContent: vi.fn().mockResolvedValue({
    title: 'Integration Page',
    markdown: '# Integration Test\n\nContent about React Server Components and their architecture.',
    metadata: {},
    links: [],
    images: [],
    extractor: 'defuddle' as const,
  }),
}));

const { handleSearch } = await import('../../src/tools/search.js');

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
          model: 'integration-model',
          content: {
            type: 'text',
            text: opts.responseText ?? 'React Server Components render ahead of time on the server [1]. This enables better performance [2].',
          },
        }),
  };
}

describe('search answer synthesis -- integration', () => {
  const originalEnv = process.env;

  const stubEngine: SearchEngine = {
    name: 'integration-stub',
    search: vi.fn().mockResolvedValue([
      {
        title: 'React Server Components',
        url: 'https://react.dev/reference/rsc/server-components',
        snippet: 'React Server Components render ahead of time.',
        relevance_score: 0.95,
        engine: 'integration-stub',
      },
      {
        title: 'Understanding RSC',
        url: 'https://vercel.com/blog/understanding-rsc',
        snippet: 'RSC enables a new mental model for React apps.',
        relevance_score: 0.88,
        engine: 'integration-stub',
      },
      {
        title: 'RSC Deep Dive',
        url: 'https://blog.example.com/rsc-deep-dive',
        snippet: 'Comprehensive deep dive into RSC architecture.',
        relevance_score: 0.75,
        engine: 'integration-stub',
      },
    ] satisfies RawSearchResult[]),
  };

  const mockRouter = {
    fetch: vi.fn().mockResolvedValue({
      url: 'https://react.dev',
      finalUrl: 'https://react.dev',
      html: '<html><body>Content</body></html>',
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

  it('end-to-end: format=answer returns answer with citations', async () => {
    const server = createMockServer({
      samplingSupported: true,
      responseText: 'React Server Components render on the server before bundling [1]. This improves performance [2].',
    });

    const result = await handleSearch(
      { query: 'What are React Server Components?', format: 'answer' },
      [stubEngine],
      mockRouter,
      undefined,
      server,
    );

    expect(result.answer).toBeDefined();
    expect(result.answer).toContain('React Server Components');
    expect(result.citations).toBeDefined();
    expect(result.citations!.length).toBeGreaterThanOrEqual(1);
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.context_text).toBeUndefined();
    expect(result.total_time_ms).toBeGreaterThanOrEqual(0);
  });

  it('end-to-end: format=answer falls back to highlights when sampling unavailable', async () => {
    const server = createMockServer({ samplingSupported: false });

    const result = await handleSearch(
      { query: 'React Server Components', format: 'answer', include_content: false },
      [stubEngine],
      mockRouter,
      undefined,
      server,
    );

    expect(result.answer).toBeUndefined();
    expect(result.highlights).toBeDefined();
    expect(result.highlights!.length).toBeGreaterThan(0);
    expect(result.citations).toBeDefined();
    expect(result.citations!.length).toBeGreaterThan(0);
    expect(result.warning).toBeDefined();
  });

  it('end-to-end: format=answer without server falls back to highlights', async () => {
    const result = await handleSearch(
      { query: 'React Server Components', format: 'answer', include_content: false },
      [stubEngine],
      mockRouter,
      undefined,
      undefined,
    );

    expect(result.answer).toBeUndefined();
    expect(result.highlights).toBeDefined();
    expect(result.highlights!.length).toBeGreaterThan(0);
  });

  it('end-to-end: format=stream_answer sets streaming flag', async () => {
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

  it('end-to-end: sampling error falls back to highlights with warning', async () => {
    const server = createMockServer({
      samplingSupported: true,
      samplingError: new Error('context window exceeded'),
    });

    const result = await handleSearch(
      { query: 'test', format: 'answer' },
      [stubEngine],
      mockRouter,
      undefined,
      server,
    );

    expect(result.answer).toBeUndefined();
    expect(result.highlights).toBeDefined();
    expect(result.highlights!.length).toBeGreaterThan(0);
    expect(result.warning).toContain('context window exceeded');
  });

  it('end-to-end: citations reference correct source URLs', async () => {
    const server = createMockServer({
      samplingSupported: true,
      responseText: 'RSC renders on server [1]. Vercel explains the model [2]. Deep dive covers architecture [3].',
    });

    const result = await handleSearch(
      { query: 'React Server Components', format: 'answer' },
      [stubEngine],
      mockRouter,
      undefined,
      server,
    );

    expect(result.citations).toBeDefined();
    const citationUrls = result.citations!.map(c => c.url);

    if (citationUrls.length >= 1) {
      expect(citationUrls[0]).toBe('https://react.dev/reference/rsc/server-components');
    }
    if (citationUrls.length >= 2) {
      expect(citationUrls[1]).toBe('https://vercel.com/blog/understanding-rsc');
    }
  });

  it('end-to-end: format=full is unaffected by answer synthesis', async () => {
    const server = createMockServer({ samplingSupported: true });

    const result = await handleSearch(
      { query: 'test', format: 'full', include_content: false },
      [stubEngine],
      mockRouter,
      undefined,
      server,
    );

    expect(result.answer).toBeUndefined();
    expect(result.citations).toBeUndefined();
    expect(result.context_text).toBeUndefined();
    expect(result.streaming).toBeUndefined();
    expect(result.results.length).toBeGreaterThan(0);
  });

  it('end-to-end: format=context is unaffected by answer synthesis', async () => {
    const server = createMockServer({ samplingSupported: true });

    const result = await handleSearch(
      { query: 'test', format: 'context', include_content: false },
      [stubEngine],
      mockRouter,
      undefined,
      server,
    );

    expect(result.context_text).toBeDefined();
    expect(result.answer).toBeUndefined();
    expect(result.citations).toBeUndefined();
  });

  it('end-to-end: empty search results with answer format', async () => {
    const emptyEngine: SearchEngine = {
      name: 'empty',
      search: vi.fn().mockResolvedValue([]),
    };

    const server = createMockServer({ samplingSupported: true });

    const result = await handleSearch(
      { query: 'nonexistent topic xyz123', format: 'answer' },
      [emptyEngine],
      mockRouter,
      undefined,
      server,
    );

    expect(result.results).toEqual([]);
    expect(result.answer).toBeUndefined();
    expect(result.error).toBeDefined();
  });

  it('end-to-end: answer synthesis prompt includes query', async () => {
    const server = createMockServer({ samplingSupported: true });

    await handleSearch(
      { query: 'specific technical question about RSC', format: 'answer' },
      [stubEngine],
      mockRouter,
      undefined,
      server,
    );

    expect(server.createMessage).toHaveBeenCalled();
    const callArgs = server.createMessage.mock.calls[0][0];
    const messageText = callArgs.messages[0].content.text;
    expect(messageText).toContain('specific technical question about RSC');
  });

  it('end-to-end: maxTokens passed correctly to sampling', async () => {
    const server = createMockServer({ samplingSupported: true });

    await handleSearch(
      { query: 'test', format: 'answer' },
      [stubEngine],
      mockRouter,
      undefined,
      server,
    );

    const callArgs = server.createMessage.mock.calls[0][0];
    expect(callArgs.maxTokens).toBe(1500);
  });

  it('end-to-end: concurrent answer requests do not interfere', async () => {
    const server = createMockServer({
      samplingSupported: true,
      responseText: 'Concurrent answer [1].',
    });

    const [result1, result2] = await Promise.all([
      handleSearch(
        { query: 'query one', format: 'answer' },
        [stubEngine],
        mockRouter,
        undefined,
        server,
      ),
      handleSearch(
        { query: 'query two', format: 'answer' },
        [stubEngine],
        mockRouter,
        undefined,
        server,
      ),
    ]);

    expect(result1.answer).toBeDefined();
    expect(result2.answer).toBeDefined();
    expect(result1.query).toBe('query one');
    expect(result2.query).toBe('query two');
  });
});
