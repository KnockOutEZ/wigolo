import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleSearch } from '../../src/tools/search.js';
import type { SearchEngine, RawSearchResult } from '../../src/types.js';
import type { SmartRouter } from '../../src/fetch/router.js';
import { resetConfig } from '../../src/config.js';
import { initDatabase, closeDatabase } from '../../src/cache/db.js';

vi.mock('../../src/extraction/pipeline.js', () => ({
  extractContent: vi.fn().mockResolvedValue({
    title: 'Mock Title',
    markdown: '# Mock Content',
    metadata: {},
    links: [],
    images: [],
    extractor: 'defuddle' as const,
  }),
}));

const fakeRouter = {
  fetch: vi.fn().mockRejectedValue(new Error('no network in test')),
} as unknown as SmartRouter;

const stubEngine: SearchEngine = {
  name: 'integration-stub',
  async search(query: string): Promise<RawSearchResult[]> {
    return [
      {
        title: 'React Server Components',
        url: 'https://react.dev/reference/rsc/server-components',
        snippet: 'React Server Components are a new kind of Component that renders ahead of time.',
        relevance_score: 0.95,
        engine: 'integration-stub',
      },
      {
        title: 'Understanding RSC',
        url: 'https://vercel.com/blog/understanding-react-server-components',
        snippet: 'RSC enables a new mental model for building React applications.',
        relevance_score: 0.88,
        engine: 'integration-stub',
      },
      {
        title: 'Server Components Deep Dive',
        url: 'https://blog.example.com/rsc-deep-dive',
        snippet: 'A comprehensive deep dive into the architecture of React Server Components.',
        relevance_score: 0.75,
        engine: 'integration-stub',
      },
    ];
  },
};

describe('search context format — integration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, VALIDATE_LINKS: 'false' };
    resetConfig();
    initDatabase(':memory:');
    vi.clearAllMocks();
  });

  afterEach(() => {
    closeDatabase();
    process.env = originalEnv;
    resetConfig();
  });

  it('full pipeline: search with format=context returns budgeted text', async () => {
    const result = await handleSearch(
      {
        query: 'react server components',
        format: 'context',
        include_content: false,
        max_total_chars: 5000,
      },
      [stubEngine],
      fakeRouter,
    );

    expect(result.context_text).toBeDefined();
    expect(result.context_text!.length).toBeGreaterThan(0);
    expect(result.context_text!.length).toBeLessThanOrEqual(5000);
    expect(result.context_text).toContain('Source: React Server Components');
    expect(result.context_text).toContain('Source: Understanding RSC');
    expect(result.context_text).toContain('Source: Server Components Deep Dive');
    expect(result.results.length).toBe(3);
  });

  it('full pipeline: tight budget truncates results', async () => {
    const result = await handleSearch(
      {
        query: 'react server components',
        format: 'context',
        include_content: false,
        max_total_chars: 200,
      },
      [stubEngine],
      fakeRouter,
    );

    expect(result.context_text).toBeDefined();
    expect(result.context_text!.length).toBeLessThanOrEqual(200);
    expect(result.context_text).toContain('Source: React Server Components');
  });

  it('full pipeline: format=full does not include context_text', async () => {
    const result = await handleSearch(
      {
        query: 'react server components',
        format: 'full',
        include_content: false,
      },
      [stubEngine],
      fakeRouter,
    );

    expect(result.context_text).toBeUndefined();
    expect(result.results.length).toBe(3);
  });

  it('full pipeline: no format specified defaults to no context_text', async () => {
    const result = await handleSearch(
      {
        query: 'react server components',
        include_content: false,
      },
      [stubEngine],
      fakeRouter,
    );

    expect(result.context_text).toBeUndefined();
  });

  it('context_text is well-formatted for LLM injection', async () => {
    const result = await handleSearch(
      {
        query: 'react server components',
        format: 'context',
        include_content: false,
        max_total_chars: 10000,
      },
      [stubEngine],
      fakeRouter,
    );

    const text = result.context_text!;
    expect(text.startsWith('Source:')).toBe(true);
    expect(text).toBe(text.trimEnd());
  });
});
