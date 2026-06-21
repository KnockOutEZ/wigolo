import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SearchEngine, RawSearchResult, RawFetchResult, ExtractionResult } from '../../../src/types.js';
import type { SmartRouter } from '../../../src/fetch/router.js';
import { resetConfig } from '../../../src/config.js';
import { initDatabase, closeDatabase, getDatabase } from '../../../src/cache/db.js';
import { captureFromPage, captureHumanNote, curateArtifact } from '../../../src/studio/capture/artifacts.js';
import { cacheContent } from '../../../src/cache/store.js';

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

// A non-matching concept: its key terms do not appear in any seeded url_cache
// page, so the FTS path cannot surface those pages — they can ONLY arrive via the
// embedding path, which is what these pins exercise.
const NONMATCHING_CONCEPT = 'xyzabc quantum teleportation manuscript';

function seedUrlCache(url: string, title: string, markdown: string): void {
  const raw: RawFetchResult = {
    url, finalUrl: url, html: `<html><body><h1>${title}</h1><p>${markdown}</p></body></html>`,
    contentType: 'text/html', statusCode: 200, method: 'http', headers: {},
  };
  const extraction: ExtractionResult = {
    title, markdown, metadata: {}, links: [], images: [], extractor: 'defuddle',
  };
  cacheContent(raw, extraction);
}

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
      { db: getDatabase(), enqueue: () => undefined, credentialContext: {} },
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

  it('does NOT abort the batch — a co-resident url_cache hit still surfaces (collateral fix)', async () => {
    // The headline regression the RED exposed: a studio key in the KNN window
    // threw in url_cache hydration and the batch catch returned [], silently
    // dropping the co-resident url_cache hit too. NONMATCHING_CONCEPT keeps the
    // cached page out of the FTS path, so it can ONLY surface via embedding.
    seedUrlCache('https://realpage.example.com/revenue', 'Quarterly Revenue', 'Q3 revenue grew on cloud demand.');
    const capture = captureFromPage(
      { type: 'clip', sessionId: 'sess-coll', url: 'https://x.example.com/p', title: 'Clip', markdown: CLIP_MARKDOWN },
      { db: getDatabase(), enqueue: () => undefined, credentialContext: {} },
    );
    const studioKey = `studio://clip|${capture.id}`;

    mockEmbeddingState.available = true;
    mockEmbeddingState.subprocessReady = true;
    mockEmbeddingState.vectors.set(studioKey, 1);
    mockEmbeddingState.vectors.set('https://realpage.example.com/revenue', 1);
    // studio key FIRST, so the old loop throws before the url hit is even reached.
    mockEmbeddingState.findSimilarImpl = async () => [
      { url: studioKey, score: 0.99 },
      { url: 'https://realpage.example.com/revenue', score: 0.95 },
    ];

    const out = await handleFindSimilar(
      { concept: NONMATCHING_CONCEPT, include_cache: true, include_web: false, include_full_markdown: true },
      [mockSearchEngine],
      mockRouter,
    );
    expect(out.ok).toBe(true);
    const urls = (out.ok ? out.data.results : []).map((r) => r.url);
    expect(urls).toContain('https://realpage.example.com/revenue'); // survived the studio key in the window
    expect(urls).toContain(studioKey);
  });

  it('skips an orphan studio key (no row) — absent, never surfaced empty', async () => {
    const orphanKey = 'studio://clip|99999';
    mockEmbeddingState.available = true;
    mockEmbeddingState.subprocessReady = true;
    mockEmbeddingState.vectors.set(orphanKey, 1);
    mockEmbeddingState.findSimilarImpl = async () => [{ url: orphanKey, score: 0.9 }];

    const out = await handleFindSimilar(
      { concept: NONMATCHING_CONCEPT, include_cache: true, include_web: false, include_full_markdown: true },
      [mockSearchEngine],
      mockRouter,
    );
    expect(out.ok).toBe(true);
    const results = out.ok ? out.data.results : [];
    expect(results.find((r) => r.url === orphanKey)).toBeUndefined();
  });

  it('tags studio clip + url_cache results trusted:false (mirrors content_trusted, page-derived)', async () => {
    seedUrlCache('https://page.example.com/doc', 'Doc', 'A fetched page body.');
    const capture = captureFromPage(
      { type: 'clip', sessionId: 'sess-trust', url: 'https://x.example.com/c', title: 'Clip', markdown: CLIP_MARKDOWN },
      { db: getDatabase(), enqueue: () => undefined, credentialContext: {} },
    );
    const studioKey = `studio://clip|${capture.id}`;
    mockEmbeddingState.available = true;
    mockEmbeddingState.subprocessReady = true;
    mockEmbeddingState.vectors.set(studioKey, 1);
    mockEmbeddingState.vectors.set('https://page.example.com/doc', 1);
    mockEmbeddingState.findSimilarImpl = async () => [
      { url: studioKey, score: 0.99 },
      { url: 'https://page.example.com/doc', score: 0.95 },
    ];

    const out = await handleFindSimilar(
      { concept: NONMATCHING_CONCEPT, include_cache: true, include_web: false, include_full_markdown: true },
      [mockSearchEngine],
      mockRouter,
    );
    const results = out.ok ? out.data.results : [];
    expect(results.find((r) => r.url === studioKey)?.trusted).toBe(false);
    expect(results.find((r) => r.url === 'https://page.example.com/doc')?.trusted).toBe(false);
  });

  it('tags a human-authored studio note trusted:true (content_trusted=1)', async () => {
    const note = captureHumanNote(
      { sessionId: 'sess-note', text: 'A note the human typed — safe as instructions.' },
      { db: getDatabase(), enqueue: () => undefined, credentialContext: {} },
    );
    const noteKey = `studio://note|${note.id}`;
    mockEmbeddingState.available = true;
    mockEmbeddingState.subprocessReady = true;
    mockEmbeddingState.vectors.set(noteKey, 1);
    mockEmbeddingState.findSimilarImpl = async () => [{ url: noteKey, score: 0.99 }];

    const out = await handleFindSimilar(
      { concept: NONMATCHING_CONCEPT, include_cache: true, include_web: false, include_full_markdown: true },
      [mockSearchEngine],
      mockRouter,
    );
    const results = out.ok ? out.data.results : [];
    const hit = results.find((r) => r.url === noteKey);
    expect(hit?.source).toBe('studio');
    expect(hit?.trusted).toBe(true);
  });

  it('a curated studio clip stays trusted:false (trusted tracks content_trusted, NOT curation)', async () => {
    const capture = captureFromPage(
      { type: 'clip', sessionId: 'sess-cur', url: 'https://x.example.com/cur', title: 'Clip', markdown: CLIP_MARKDOWN },
      { db: getDatabase(), enqueue: () => undefined, credentialContext: {} },
    );
    curateArtifact(capture.id, { db: getDatabase() }); // curated_by_human = 1; content_trusted untouched
    const studioKey = `studio://clip|${capture.id}`;
    mockEmbeddingState.available = true;
    mockEmbeddingState.subprocessReady = true;
    mockEmbeddingState.vectors.set(studioKey, 1);
    mockEmbeddingState.findSimilarImpl = async () => [{ url: studioKey, score: 0.99 }];

    const out = await handleFindSimilar(
      { concept: NONMATCHING_CONCEPT, include_cache: true, include_web: false, include_full_markdown: true },
      [mockSearchEngine],
      mockRouter,
    );
    const results = out.ok ? out.data.results : [];
    expect(results.find((r) => r.url === studioKey)?.trusted).toBe(false);
  });

  it('keeps studio + cache identities distinct when they share an integer rowid (no merge)', async () => {
    // First insert into each table => both rowid 1. The raw INTEGER rowid must
    // NOT be the cross-surface identity — the URI key + source tag keep them apart.
    seedUrlCache('https://shared-rowid.example.com/p', 'Shared', 'Shares integer rowid with the clip.');
    const capture = captureFromPage(
      { type: 'clip', sessionId: 'sess-id', url: 'https://x.example.com/id', title: 'Clip', markdown: CLIP_MARKDOWN },
      { db: getDatabase(), enqueue: () => undefined, credentialContext: {} },
    );
    const cacheRow = getDatabase().prepare('SELECT id FROM url_cache LIMIT 1').get() as { id: number };
    expect(cacheRow.id).toBe(capture.id); // both share the same integer rowid

    const studioKey = `studio://clip|${capture.id}`;
    mockEmbeddingState.available = true;
    mockEmbeddingState.subprocessReady = true;
    mockEmbeddingState.vectors.set(studioKey, 1);
    mockEmbeddingState.vectors.set('https://shared-rowid.example.com/p', 1);
    mockEmbeddingState.findSimilarImpl = async () => [
      { url: studioKey, score: 0.99 },
      { url: 'https://shared-rowid.example.com/p', score: 0.9 },
    ];

    const out = await handleFindSimilar(
      { concept: NONMATCHING_CONCEPT, include_cache: true, include_web: false, include_full_markdown: true },
      [mockSearchEngine],
      mockRouter,
    );
    const results = out.ok ? out.data.results : [];
    const studioHit = results.find((r) => r.source === 'studio');
    const cacheHit = results.find((r) => r.source === 'cache');
    expect(studioHit?.url).toBe(studioKey);
    expect(cacheHit?.url).toBe('https://shared-rowid.example.com/p');
    expect(studioHit?.url).not.toBe(cacheHit?.url);
  });
});
