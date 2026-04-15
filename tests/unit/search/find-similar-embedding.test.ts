import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SearchEngine, RawSearchResult, RawFetchResult, ExtractionResult } from '../../../src/types.js';
import type { SmartRouter } from '../../../src/fetch/router.js';
import { resetConfig } from '../../../src/config.js';
import { initDatabase, closeDatabase } from '../../../src/cache/db.js';
import { cacheContent } from '../../../src/cache/store.js';

// Mock extraction pipeline to avoid Playwright
vi.mock('../../../src/extraction/pipeline.js', () => ({
  extractContent: vi.fn().mockResolvedValue({
    title: 'Mock Title',
    markdown: '# Mock Content\n\nSome extracted content here.',
    metadata: {},
    links: [],
    images: [],
    extractor: 'defuddle' as const,
  }),
}));

// Mock the embedding service singleton. These hoisted helpers let
// individual tests configure the mock's behavior.
const mockEmbeddingState = {
  available: false,
  vectors: new Map<string, number>(), // url -> mock score stored in-index
  findSimilarImpl: null as
    | ((queryText: string, topK: number, excludeUrls?: Set<string>) => Promise<Array<{ url: string; score: number }>>)
    | null,
};

const mockIndex = {
  size: () => mockEmbeddingState.vectors.size,
  add: vi.fn(),
  remove: vi.fn(),
  has: vi.fn(),
  get: vi.fn(),
  clear: vi.fn(),
  findSimilar: vi.fn(),
  loadFromBuffers: vi.fn(),
  getAllUrls: vi.fn(),
};

const mockService = {
  isAvailable: () => mockEmbeddingState.available,
  setAvailable: vi.fn(),
  getIndex: () => mockIndex,
  init: vi.fn(),
  embedAsync: vi.fn(),
  embedAndStore: vi.fn(),
  findSimilar: vi.fn(async (queryText: string, topK: number, excludeUrls?: Set<string>) => {
    if (mockEmbeddingState.findSimilarImpl) {
      return mockEmbeddingState.findSimilarImpl(queryText, topK, excludeUrls);
    }
    return [];
  }),
  shutdown: vi.fn(),
};

vi.mock('../../../src/embedding/embed.js', () => ({
  getEmbeddingService: () => mockService,
  resetEmbeddingService: vi.fn(),
  EmbeddingService: class {},
}));

// Import after mocks are registered
const { findSimilar } = await import('../../../src/search/find-similar.js');

function seedCache(url: string, title: string, markdown: string): void {
  const rawResult: RawFetchResult = {
    url,
    finalUrl: url,
    html: `<html><body><h1>${title}</h1><p>${markdown}</p></body></html>`,
    contentType: 'text/html',
    statusCode: 200,
    method: 'http',
    headers: {},
  };
  const extraction: ExtractionResult = {
    title,
    markdown,
    metadata: {},
    links: [],
    images: [],
    extractor: 'defuddle',
  };
  cacheContent(rawResult, extraction);
}

describe('findSimilar embedding integration', () => {
  const originalEnv = process.env;

  const mockSearchEngine: SearchEngine = {
    name: 'mock',
    search: vi.fn().mockResolvedValue([
      {
        title: 'Web Result',
        url: 'https://web.example.com/1',
        snippet: 'A web search result',
        relevance_score: 0.9,
        engine: 'mock',
      },
    ] satisfies RawSearchResult[]),
  };

  const mockRouter = {
    fetch: vi.fn().mockResolvedValue({
      url: 'https://example.com/page',
      finalUrl: 'https://example.com/page',
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
    // Reset mock state
    mockEmbeddingState.available = false;
    mockEmbeddingState.vectors.clear();
    mockEmbeddingState.findSimilarImpl = null;
  });

  afterEach(() => {
    closeDatabase();
    process.env = originalEnv;
    resetConfig();
  });

  it('embedding_available=false when service not available', async () => {
    mockEmbeddingState.available = false;
    mockEmbeddingState.vectors.set('any', 1); // index has vectors but service not available

    const result = await findSimilar(
      { concept: 'React hooks', include_web: false },
      [mockSearchEngine],
      mockRouter,
    );

    expect(result.embedding_available).toBe(false);
  });

  it('embedding_available=false when index is empty even if service is available', async () => {
    mockEmbeddingState.available = true;
    mockEmbeddingState.vectors.clear();

    const result = await findSimilar(
      { concept: 'React hooks', include_web: false },
      [mockSearchEngine],
      mockRouter,
    );

    expect(result.embedding_available).toBe(false);
  });

  it('embedding_available=true when service available and index has vectors', async () => {
    mockEmbeddingState.available = true;
    mockEmbeddingState.vectors.set('https://example.com/', 1);
    mockEmbeddingState.findSimilarImpl = async () => [];

    const result = await findSimilar(
      { concept: 'React hooks', include_web: false },
      [mockSearchEngine],
      mockRouter,
    );

    expect(result.embedding_available).toBe(true);
  });

  it('uses embedding path when available and produces hybrid method', async () => {
    seedCache(
      'https://react.dev/hooks',
      'React Hooks',
      '# React Hooks\n\nHooks for **state** management.',
    );

    mockEmbeddingState.available = true;
    mockEmbeddingState.vectors.set('https://react.dev/hooks', 1);
    mockEmbeddingState.findSimilarImpl = async () => [
      { url: 'https://react.dev/hooks', score: 0.95 },
    ];

    const result = await findSimilar(
      { concept: 'React hooks state', include_web: false },
      [mockSearchEngine],
      mockRouter,
    );

    expect(result.embedding_available).toBe(true);
    // Both FTS5 and embedding hit the same URL -> 2 sources -> hybrid
    expect(result.method).toBe('hybrid');
    expect(mockService.findSimilar).toHaveBeenCalled();
  });

  it('embedding results appear even with no keyword match', async () => {
    // Seed a page whose content has NO keyword overlap with the query
    seedCache(
      'https://semantic-match.example.com/page',
      'Functional Programming Paradigm',
      '# Pure functions\n\nImmutable data and higher-order combinators.',
    );

    mockEmbeddingState.available = true;
    mockEmbeddingState.vectors.set('https://semantic-match.example.com/page', 1);
    // Embedding returns this page as similar despite no keyword match
    mockEmbeddingState.findSimilarImpl = async () => [
      { url: 'https://semantic-match.example.com/page', score: 0.88 },
    ];

    const result = await findSimilar(
      { concept: 'React hooks state management', include_web: false },
      [mockSearchEngine],
      mockRouter,
    );

    const urls = result.results.map(r => r.url);
    expect(urls).toContain('https://semantic-match.example.com/page');
    expect(result.embedding_available).toBe(true);
    // Check match_signals includes embedding_rank for this result
    const embeddingHit = result.results.find(r => r.url === 'https://semantic-match.example.com/page');
    expect(embeddingHit?.match_signals.embedding_rank).toBe(1);
  });

  it('method=embedding when only embedding path produces results', async () => {
    seedCache(
      'https://semantic-only.example.com/page',
      'Functional Programming',
      '# Content unrelated to query keywords\n\nImmutable combinators.',
    );

    mockEmbeddingState.available = true;
    mockEmbeddingState.vectors.set('https://semantic-only.example.com/page', 1);
    mockEmbeddingState.findSimilarImpl = async () => [
      { url: 'https://semantic-only.example.com/page', score: 0.88 },
    ];

    // Use a concept that won't match the cached page keywords AND disable web
    const result = await findSimilar(
      { concept: 'xyzabc quantum teleportation', include_cache: true, include_web: false },
      [mockSearchEngine],
      mockRouter,
    );

    // Only embedding path contributes
    expect(result.method).toBe('embedding');
    expect(result.results.length).toBeGreaterThan(0);
  });

  it('3-way RRF: fused ranks beat single-source ranks', async () => {
    // Page A: appears in FTS5 rank 2 and embedding rank 1 -> should fuse to top
    // Page B: appears only in FTS5 rank 1 -> should fuse below A
    seedCache(
      'https://a.com/react-hooks',
      'React Hooks Deep Dive',
      '# React Hooks\n\nHooks for **state** management and effects.',
    );
    seedCache(
      'https://b.com/react-hooks',
      'React Hooks Tutorial',
      '# React Hooks Guide\n\nBasic **state** hooks tutorial.',
    );

    mockEmbeddingState.available = true;
    mockEmbeddingState.vectors.set('https://a.com/react-hooks', 1);
    mockEmbeddingState.findSimilarImpl = async () => [
      { url: 'https://a.com/react-hooks', score: 0.99 },
    ];

    const result = await findSimilar(
      { concept: 'React hooks state', include_web: false, max_results: 2 },
      [mockSearchEngine],
      mockRouter,
    );

    // A should beat B because it appears in both ranked lists
    expect(result.results[0].url).toBe('https://a.com/react-hooks');
    expect(result.method).toBe('hybrid');
  });

  it('embedding path excludes input url', async () => {
    seedCache(
      'https://react.dev/hooks',
      'Input Page',
      '# Hooks\n\nInput content.',
    );
    seedCache(
      'https://other.dev/hooks',
      'Related Page',
      '# Related\n\nSimilar hooks content.',
    );

    mockEmbeddingState.available = true;
    mockEmbeddingState.vectors.set('https://react.dev/hooks', 1);
    mockEmbeddingState.vectors.set('https://other.dev/hooks', 1);
    // Embedding service would normally filter via excludeUrls; verify it's called correctly
    mockEmbeddingState.findSimilarImpl = async (_q, _k, excludeUrls) => {
      const results = [
        { url: 'https://react.dev/hooks', score: 0.99 },
        { url: 'https://other.dev/hooks', score: 0.9 },
      ];
      return results.filter(r => !excludeUrls?.has(r.url));
    };

    const result = await findSimilar(
      { url: 'https://react.dev/hooks', include_web: false },
      [mockSearchEngine],
      mockRouter,
    );

    const urls = result.results.map(r => r.url);
    expect(urls).not.toContain('https://react.dev/hooks');
  });

  it('embedding respects exclude_domains filter', async () => {
    seedCache(
      'https://good.com/page',
      'Good Page',
      '# Good content.',
    );
    seedCache(
      'https://spam.com/page',
      'Spam Page',
      '# Spam content.',
    );

    mockEmbeddingState.available = true;
    mockEmbeddingState.vectors.set('https://good.com/page', 1);
    mockEmbeddingState.vectors.set('https://spam.com/page', 1);
    mockEmbeddingState.findSimilarImpl = async () => [
      { url: 'https://spam.com/page', score: 0.99 },
      { url: 'https://good.com/page', score: 0.9 },
    ];

    const result = await findSimilar(
      {
        concept: 'content',
        exclude_domains: ['spam.com'],
        include_web: false,
      },
      [mockSearchEngine],
      mockRouter,
    );

    for (const r of result.results) {
      expect(r.url).not.toContain('spam.com');
    }
  });

  it('embedding skipped when include_cache=false', async () => {
    mockEmbeddingState.available = true;
    mockEmbeddingState.vectors.set('https://foo.com/', 1);
    mockEmbeddingState.findSimilarImpl = async () => [
      { url: 'https://foo.com/', score: 0.9 },
    ];

    await findSimilar(
      { concept: 'anything', include_cache: false, include_web: false },
      [mockSearchEngine],
      mockRouter,
    );

    expect(mockService.findSimilar).not.toHaveBeenCalled();
  });

  it('embedding failure does not break find_similar', async () => {
    seedCache(
      'https://react.dev/hooks',
      'React Hooks',
      '# React Hooks\n\nHooks for **state**.',
    );

    mockEmbeddingState.available = true;
    mockEmbeddingState.vectors.set('https://something', 1);
    mockEmbeddingState.findSimilarImpl = async () => {
      throw new Error('subprocess crashed');
    };

    const result = await findSimilar(
      { concept: 'React hooks state', include_web: false },
      [mockSearchEngine],
      mockRouter,
    );

    // FTS5 still works
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.error).toBeUndefined();
  });
});
