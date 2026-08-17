import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SearchEngine, RawFetchResult, ExtractionResult } from '../../../src/types.js';
import type { SmartRouter } from '../../../src/fetch/router.js';
import { resetConfig } from '../../../src/config.js';
import { initDatabase, closeDatabase } from '../../../src/cache/db.js';
import { cacheContent, getCachedContent } from '../../../src/cache/store.js';

vi.mock('../../../src/providers/extract-provider.js', () => ({
  getExtractProvider: vi.fn(async () => ({
    name: 'v1' as const,
    extract: vi.fn(),
  })),
  _resetExtractProviderForTest: vi.fn(),
}));

const mockEmbeddingState = {
  available: false,
  subprocessReady: false,
  indexSize: 0,
  hits: [] as Array<{ url: string; score: number }>,
};

const mockService = {
  isAvailable: () => mockEmbeddingState.available,
  isSubprocessReady: () => mockEmbeddingState.subprocessReady,
  ensureProviderReady: vi.fn(async () => mockEmbeddingState.subprocessReady),
  setAvailable: vi.fn(),
  getIndex: () => ({ size: () => mockEmbeddingState.indexSize, has: () => false }),
  init: vi.fn(),
  embedAsync: vi.fn(),
  embedAndStore: vi.fn().mockResolvedValue(undefined),
  findSimilar: vi.fn(async () => mockEmbeddingState.hits),
  shutdown: vi.fn(),
};

vi.mock('../../../src/embedding/embed.js', () => ({
  getEmbeddingService: () => mockService,
  resetEmbeddingService: vi.fn(),
  EmbeddingService: class {},
}));

const { findSimilar } = await import('../../../src/search/find-similar.js');

const SHELL_URL = 'https://walled.example/quantum-annealing';
const FULL_URL = 'https://good.example/quantum-annealing';

/** Shared vocabulary so both pages are genuine candidates for the same query. */
const TOPIC = 'quantum annealing optimisation solver benchmark hardware topology';

function seed(url: string, title: string, markdown: string, level?: 'shell' | 'full' | 'partial'): void {
  const raw: RawFetchResult = {
    url,
    finalUrl: url,
    html: `<html><body><h1>${title}</h1><p>${markdown}</p></body></html>`,
    contentType: 'text/html',
    statusCode: 200,
    method: 'browser',
    headers: {},
    ...(level ? { contentCompleteness: { level, reason: 'empty' as const, settled_by: 'budget' as const } } : {}),
  };
  const extraction: ExtractionResult = {
    title,
    markdown,
    metadata: {},
    links: [],
    images: [],
    extractor: 'defuddle',
  };
  cacheContent(raw, extraction);
}

/**
 * `fetch` already treats a cached shell capture as stale and refetches it once.
 * `find_similar` had no counterpart, so an un-rendered frame or a bot-wall
 * interstitial could be returned as a similar page on the strength of the
 * boilerplate that survived extraction. Both lanes that read url_cache — FTS
 * and embedding hydration — have to agree on that, or suppressing one just
 * moves the result between lanes.
 */
describe('find_similar suppresses shell-level cached captures', () => {
  const engines: SearchEngine[] = [];
  const router = { fetch: vi.fn() } as unknown as SmartRouter;

  beforeEach(() => {
    resetConfig();
    initDatabase(':memory:');
    vi.clearAllMocks();
    mockEmbeddingState.available = false;
    mockEmbeddingState.subprocessReady = false;
    mockEmbeddingState.indexSize = 0;
    mockEmbeddingState.hits = [];
  });

  afterEach(() => {
    closeDatabase();
    resetConfig();
  });

  it('the FTS lane returns the full page and not the shell', async () => {
    seed(SHELL_URL, 'Just a moment', TOPIC, 'shell');
    seed(FULL_URL, 'Annealing guide', `${TOPIC} and a long real explanation of the method`, 'full');
    // Precondition: the label really is persisted, or this test proves nothing.
    expect(getCachedContent(SHELL_URL)?.contentCompleteness?.level).toBe('shell');

    const out = await findSimilar(
      { concept: TOPIC, include_web: false, max_results: 10 },
      engines,
      router,
    );

    const urls = out.results.map(r => r.url);
    expect(urls).not.toContain(SHELL_URL);
    expect(urls).toContain(FULL_URL);
  });

  it('the embedding lane returns the full page and not the shell', async () => {
    seed(SHELL_URL, 'Just a moment', TOPIC, 'shell');
    seed(FULL_URL, 'Annealing guide', `${TOPIC} and a long real explanation of the method`, 'full');
    mockEmbeddingState.available = true;
    mockEmbeddingState.subprocessReady = true;
    mockEmbeddingState.indexSize = 2;
    // The vector index ranks the shell FIRST — exactly the measured failure.
    mockEmbeddingState.hits = [
      { url: SHELL_URL, score: 0.91 },
      { url: FULL_URL, score: 0.72 },
    ];

    const out = await findSimilar(
      { concept: TOPIC, include_web: false, max_results: 10 },
      engines,
      router,
    );

    const urls = out.results.map(r => r.url);
    expect(urls).not.toContain(SHELL_URL);
    expect(urls).toContain(FULL_URL);
  });

  it('keeps pages with no completeness verdict — an absent label is not "incomplete"', async () => {
    // The other direction. Most cached rows carry no label at all (HTTP tier,
    // rows written before the column existed). Treating those as shells would
    // empty the local lane instead of cleaning it.
    seed(FULL_URL, 'Annealing guide', TOPIC);
    expect(getCachedContent(FULL_URL)?.contentCompleteness).toBeUndefined();

    const out = await findSimilar(
      { concept: TOPIC, include_web: false, max_results: 10 },
      engines,
      router,
    );

    expect(out.results.map(r => r.url)).toContain(FULL_URL);
  });

  it('keeps partial captures — content was lost, but usable text survived', async () => {
    seed(FULL_URL, 'Annealing guide', TOPIC, 'partial');

    const out = await findSimilar(
      { concept: TOPIC, include_web: false, max_results: 10 },
      engines,
      router,
    );

    expect(out.results.map(r => r.url)).toContain(FULL_URL);
  });

  it('a cache holding only shells returns nothing rather than the shells', async () => {
    seed(SHELL_URL, 'Just a moment', TOPIC, 'shell');
    mockEmbeddingState.available = true;
    mockEmbeddingState.subprocessReady = true;
    mockEmbeddingState.indexSize = 1;
    mockEmbeddingState.hits = [{ url: SHELL_URL, score: 0.99 }];

    const out = await findSimilar(
      { concept: TOPIC, include_web: false, max_results: 10 },
      engines,
      router,
    );

    expect(out.results).toEqual([]);
  });
});
