import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SearchEngine, RawSearchResult } from '../../../src/types.js';
import type { SmartRouter } from '../../../src/fetch/router.js';
import { resetConfig } from '../../../src/config.js';
import { initDatabase, closeDatabase, getDatabase } from '../../../src/cache/db.js';
import { captureFromPage } from '../../../src/studio/capture/artifacts.js';

/**
 * 4d slice-1 — does find_similar surface a captured studio clip through the
 * EMBEDDING path? (Adjudicates LIVE vs LATENT.)
 *
 * Setup reality: a 4c clip capture embeds under the shared vec-store key
 * `studio://<type>|<id>` (artifacts.ts), so the embedding KNN can already return
 * that key as a candidate. But find_similar's embedding hydration is url_cache-
 * only (`getCachedContent`), so the studio key never resolves to its captured
 * content.
 *
 * This runs in the EMBEDDING lane (embedding ranker live): the embedding service
 * is stubbed available + subprocess-ready with a fixed `findSimilar` that
 * deterministically returns the studio key as the top hit — no model, no flaky
 * similarity. The studio_artifacts row is inserted via the real 4c capture path
 * so a correct (GREEN) union could hydrate its markdown by id.
 *
 * Asserts the contract the 4d union must satisfy (RED today; trusted/
 * content_trusted intentionally excluded — that is C4):
 *   1. the studio key surfaces as a result at all,
 *   2. its markdown == the captured clip markdown (non-empty, hydrated),
 *   3. it is tagged source = 'studio' under the stable URI studio://<type>|<id> (C1).
 *
 * READ THE FAILURE to adjudicate:
 *   - no result for the studio key  => dropped before output  => LATENT
 *     (slice-1 reframes "fix junk" -> "add surfacing").
 *   - result present, markdown ''   => surfaced unhydrated     => LIVE.
 */

const mockEmbeddingState = {
  available: false,
  subprocessReady: false,
  vectors: new Map<string, number>(),
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
  isSubprocessReady: () => mockEmbeddingState.subprocessReady,
  setAvailable: vi.fn(),
  getIndex: () => mockIndex,
  init: vi.fn(),
  embedAsync: vi.fn(),
  embedAndStore: vi.fn().mockResolvedValue(undefined),
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

// Avoid Playwright in the (unused, include_web:false) extraction import.
vi.mock('../../../src/providers/extract-provider.js', () => ({
  getExtractProvider: vi.fn(async () => ({
    name: 'v1' as const,
    extract: vi.fn().mockResolvedValue({
      title: 't', markdown: 'm', metadata: {}, links: [], images: [], extractor: 'defuddle' as const,
    }),
  })),
  _resetExtractProviderForTest: vi.fn(),
}));

// Import the public entry AFTER the mocks register (it transitively imports the
// mocked embedding service).
const { handleFindSimilar } = await import('../../../src/tools/find-similar.js');

const CLIP_MARKDOWN = '# Captured Research\n\nThe quarterly figures the human clipped while co-browsing.';

const mockSearchEngine: SearchEngine = {
  name: 'mock',
  search: vi.fn().mockResolvedValue([] satisfies RawSearchResult[]),
};
const mockRouter = { fetch: vi.fn() } as unknown as SmartRouter;

describe('find_similar — captured studio clip via the embedding path (4d slice-1 leak)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, LOG_LEVEL: 'error' };
    resetConfig();
    initDatabase(':memory:');
    vi.clearAllMocks();
    mockEmbeddingState.available = false;
    mockEmbeddingState.subprocessReady = false;
    mockEmbeddingState.vectors.clear();
    mockEmbeddingState.findSimilarImpl = null;
  });

  afterEach(() => {
    closeDatabase();
    process.env = originalEnv;
    resetConfig();
  });

  it('surfaces the studio clip with hydrated content + source=studio through the public entry', async () => {
    // 1. Real 4c capture → a studio_artifacts row with known markdown. no-op
    //    enqueue so the capture does not touch the background index queue.
    const capture = captureFromPage(
      { type: 'clip', sessionId: 'sess-leak', url: 'https://research.example.com/q3', title: 'Q3', markdown: CLIP_MARKDOWN },
      { db: getDatabase(), enqueue: () => undefined },
    );
    expect(capture.inserted).toBe(true);

    // The 4c embed key — what the shared vec store holds and the KNN returns.
    const studioKey = `studio://clip|${capture.id}`;

    // 2. Embedding lane live + the studio key is the deterministic top hit.
    mockEmbeddingState.available = true;
    mockEmbeddingState.subprocessReady = true;
    mockEmbeddingState.vectors.set(studioKey, 1);
    mockEmbeddingState.findSimilarImpl = async () => [{ url: studioKey, score: 0.99 }];

    // 3. Public entry. include_web:false isolates the embedding path (no web
    //    fallback dilution); include_full_markdown:true keeps hydrated content
    //    (handleFindSimilar otherwise blanks markdown for the evidence budget).
    const out = await handleFindSimilar(
      { concept: 'similar to my captured research clip', include_cache: true, include_web: false, include_full_markdown: true },
      [mockSearchEngine],
      mockRouter,
    );

    expect(out.ok).toBe(true);
    const results = out.ok ? out.data.results : [];

    const hit = results.find((r) => r.url === studioKey);
    // Adjudicator — see the file header. Failure here with an empty list => LATENT.
    expect(
      hit,
      `expected a find_similar result for ${studioKey}; got ${JSON.stringify(results.map((r) => r.url))}`,
    ).toBeDefined();

    expect(hit!.markdown, 'studio clip must surface its captured markdown, hydrated from studio_artifacts').toBe(CLIP_MARKDOWN);

    const source: string = hit!.source;
    expect(source, 'a studio-sourced result must be tagged source=studio (C1)').toBe('studio');

    expect(hit!.url).toBe(studioKey);
  });
});
