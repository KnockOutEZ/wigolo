import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SearchEngine, RawSearchResult } from '../../src/types.js';
import type { SmartRouter } from '../../src/fetch/router.js';
import { handleSearch } from '../../src/tools/search.js';
import { initDatabase, closeDatabase } from '../../src/cache/db.js';
import { resetConfig } from '../../src/config.js';

// Mock extraction pipeline to avoid Playwright
vi.mock('../../src/extraction/pipeline.js', () => ({
  extractContent: vi.fn().mockResolvedValue({
    title: 'Mock Title',
    markdown: '# React Hooks Guide\n\nReact hooks let you use state and other React features without writing a class. The useState hook is the most common hook for managing local component state. Effects run after every render by default.\n\nUseReducer is an alternative to useState for complex state logic. It accepts a reducer function and returns the current state paired with a dispatch method.',
    metadata: {},
    links: [],
    images: [],
    extractor: 'defuddle' as const,
  }),
}));

vi.mock('../../src/embedding/embed.js', () => ({
  getEmbeddingService: () => ({
    isAvailable: () => false,
    isSubprocessReady: () => false,
    embedAsync: vi.fn(),
  }),
}));

vi.mock('../../src/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const stubEngine: SearchEngine = {
  name: 'stub',
  search: vi.fn().mockResolvedValue([
    {
      title: 'React Hooks Guide',
      url: 'https://react.dev/hooks',
      snippet: 'React hooks let you use state and other React features.',
      relevance_score: 0.95,
      engine: 'stub',
    },
    {
      title: 'React State Management',
      url: 'https://react.dev/state',
      snippet: 'Managing state in React applications with hooks.',
      relevance_score: 0.85,
      engine: 'stub',
    },
  ] satisfies RawSearchResult[]),
};

const stubRouter = {
  fetch: vi.fn().mockResolvedValue({
    url: 'https://react.dev/hooks',
    finalUrl: 'https://react.dev/hooks',
    html: '<html><body><p>Content</p></body></html>',
    contentType: 'text/html',
    statusCode: 200,
    method: 'http' as const,
    headers: {},
  }),
} as unknown as SmartRouter;

describe('search format:highlights end-to-end', () => {
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

  it('returns highlights array with citations for format:highlights', async () => {
    const output = await handleSearch(
      { query: 'React hooks state', format: 'highlights' },
      [stubEngine],
      stubRouter,
    );

    expect(output.highlights).toBeDefined();
    expect(output.highlights!.length).toBeGreaterThan(0);
    expect(output.citations).toBeDefined();
    expect(output.citations!.length).toBeGreaterThan(0);

    // Each highlight should have source info
    for (const h of output.highlights!) {
      expect(h.text.length).toBeGreaterThan(0);
      expect(h.source_url).toBeDefined();
      expect(h.source_index).toBeGreaterThanOrEqual(1);
    }
  });

  it('highlights contain relevant passages scored by relevance', async () => {
    const output = await handleSearch(
      { query: 'React hooks', format: 'highlights', max_highlights: 5 },
      [stubEngine],
      stubRouter,
    );

    expect(output.highlights).toBeDefined();
    // Should have at least 1 highlight with relevance score
    for (const h of output.highlights!) {
      expect(h.relevance_score).toBeGreaterThan(0);
    }
  });

  it('citations reference source URLs from results', async () => {
    const output = await handleSearch(
      { query: 'React hooks', format: 'highlights' },
      [stubEngine],
      stubRouter,
    );

    expect(output.citations).toBeDefined();
    for (const c of output.citations!) {
      expect(c.url).toMatch(/^https?:\/\//);
      expect(c.index).toBeGreaterThanOrEqual(1);
    }
  });
});
