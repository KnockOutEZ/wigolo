import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SearchEngine, RawSearchResult } from '../../src/types.js';
import type { SmartRouter } from '../../src/fetch/router.js';
import { initDatabase, closeDatabase } from '../../src/cache/db.js';
import { resetConfig } from '../../src/config.js';

const extractMock = vi.fn().mockResolvedValue({
  title: 'Big Page',
  // Long markdown so the test can distinguish "stripped" from "carried".
  markdown:
    '# Big Page\n\n' +
    'This is a deliberately long body about React Server Components and their architecture. '.repeat(
      30,
    ),
  metadata: {},
  links: [],
  images: [],
  extractor: 'defuddle' as const,
});
vi.mock('../../src/providers/extract-provider.js', () => ({
  getExtractProvider: vi.fn(async () => ({
    name: 'v1' as const,
    extract: extractMock,
  })),
  _resetExtractProviderForTest: vi.fn(),
}));

const { handleSearch } = await import('../../src/tools/search.js');

function createMockServer() {
  return {
    getClientCapabilities: vi.fn().mockReturnValue({ sampling: {} }),
    createMessage: vi.fn().mockResolvedValue({
      model: 'test-model',
      content: {
        type: 'text',
        text: 'React Server Components render on the server [1]. Better performance follows [2].',
      },
    }),
  };
}

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
  ] satisfies RawSearchResult[]),
};

const mockRouter = {
  fetch: vi.fn().mockResolvedValue({
    url: 'https://react.dev',
    finalUrl: 'https://react.dev',
    html: '<html><body><p>Content body</p></body></html>',
    contentType: 'text/html',
    statusCode: 200,
    method: 'http' as const,
    headers: {},
  }),
} as unknown as SmartRouter;

// format=answer must not return full markdown bodies. The synthesized
// answer + thin citations are the contract; per-result markdown_content is
// pure overhead at that point and must be dropped.
describe('search format=answer — H2 slim payload', () => {
  const originalEnv = process.env;

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

  it('does NOT carry full markdown_content on results when format=answer', async () => {
    const server = createMockServer();
    const __r = await handleSearch(
      { query: 'React Server Components', format: 'answer' },
      [stubEngine],
      mockRouter,
      undefined,
      server,
    );
    const out = __r.ok ? __r.data : ({ ...__r } as any);

    expect(out.answer).toBeDefined();
    expect(out.answer.length).toBeGreaterThan(0);
    expect(out.results.length).toBeGreaterThan(0);
    // Slim payload: no per-result markdown body in the response.
    for (const r of out.results) {
      expect(r.markdown_content).toBeFalsy();
    }
  });

  it('does NOT carry full markdown_content on results when format=stream_answer', async () => {
    const server = createMockServer();
    const __r = await handleSearch(
      { query: 'React Server Components', format: 'stream_answer' },
      [stubEngine],
      mockRouter,
      undefined,
      server,
    );
    const out = __r.ok ? __r.data : ({ ...__r } as any);

    expect(out.answer).toBeDefined();
    expect(out.streaming).toBe(true);
    for (const r of out.results) {
      expect(r.markdown_content).toBeFalsy();
    }
  });

  it('keeps citations thin — url, title (no full body)', async () => {
    const server = createMockServer();
    const __r = await handleSearch(
      { query: 'React Server Components', format: 'answer' },
      [stubEngine],
      mockRouter,
      undefined,
      server,
    );
    const out = __r.ok ? __r.data : ({ ...__r } as any);

    expect(out.citations).toBeDefined();
    expect(out.citations!.length).toBeGreaterThan(0);
    for (const c of out.citations!) {
      expect(c.url).toBeTruthy();
      expect(c.title).toBeTruthy();
      // No `markdown_content` or other heavy field smuggled on the citation.
      expect((c as Record<string, unknown>).markdown_content).toBeUndefined();
    }
  });

  it('still honors include_full_markdown=true when caller opts in explicitly', async () => {
    const server = createMockServer();
    const __r = await handleSearch(
      {
        query: 'React Server Components',
        format: 'answer',
        include_full_markdown: true,
      },
      [stubEngine],
      mockRouter,
      undefined,
      server,
    );
    const out = __r.ok ? __r.data : ({ ...__r } as any);
    const anyFull = out.results.some(
      (r: { markdown_content?: string }) =>
        typeof r.markdown_content === 'string' && r.markdown_content.length > 0,
    );
    // When caller explicitly asks for full markdown, the response keeps it.
    expect(anyFull).toBe(true);
  });
});
