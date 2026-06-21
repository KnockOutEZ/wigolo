import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SearchEngine, RawSearchResult } from '../../../src/types.js';
import type { SmartRouter } from '../../../src/fetch/router.js';
import { resetConfig } from '../../../src/config.js';
import { initDatabase, closeDatabase, getDatabase } from '../../../src/cache/db.js';
import { captureFromPage } from '../../../src/studio/capture/artifacts.js';

/**
 * 4d slice-2 — union studio_artifacts into find_similar's FTS path (+ cross-path
 * dedup with slice-1's embedding path + evidence trust-tagging).
 *
 * The embedding service is stubbed; FTS-lane tests set available=false so the
 * studio row can ONLY arrive via the FTS path (studio_artifacts_fts), isolating
 * this slice from slice-1's embedding path. Cross-path / embedding-evidence tests
 * flip available=true and pin a deterministic top-hit.
 */

const mockEmbeddingState = {
  available: false,
  subprocessReady: false,
  vectors: new Map<string, number>(),
  findSimilarImpl: null as
    | ((q: string, k: number, ex?: Set<string>) => Promise<Array<{ url: string; score: number }>>)
    | null,
};

const mockIndex = {
  size: () => mockEmbeddingState.vectors.size,
  add: vi.fn(), remove: vi.fn(), has: vi.fn(), get: vi.fn(), clear: vi.fn(),
  findSimilar: vi.fn(), loadFromBuffers: vi.fn(), getAllUrls: vi.fn(),
};

const mockService = {
  isAvailable: () => mockEmbeddingState.available,
  isSubprocessReady: () => mockEmbeddingState.subprocessReady,
  setAvailable: vi.fn(),
  getIndex: () => mockIndex,
  init: vi.fn(),
  embedAsync: vi.fn(),
  embedAndStore: vi.fn().mockResolvedValue(undefined),
  findSimilar: vi.fn(async (q: string, k: number, ex?: Set<string>) =>
    mockEmbeddingState.findSimilarImpl ? mockEmbeddingState.findSimilarImpl(q, k, ex) : []),
  shutdown: vi.fn(),
};

vi.mock('../../../src/embedding/embed.js', () => ({
  getEmbeddingService: () => mockService,
  resetEmbeddingService: vi.fn(),
  EmbeddingService: class {},
}));

const { handleFindSimilar } = await import('../../../src/tools/find-similar.js');

// Distinctive terms so the FTS query matches the clip (title+markdown indexed)
// and nothing else; the concept reuses them.
const CLIP_MD = 'Wigolo studio capture pipeline architecture and dedup notes — the knowledge moat layer.';
const CONCEPT = 'wigolo studio capture pipeline moat';

const engine: SearchEngine = { name: 'mock', search: vi.fn().mockResolvedValue([] satisfies RawSearchResult[]) };
const router = { fetch: vi.fn() } as unknown as SmartRouter;

describe('find_similar — captured studio clip via the FTS path (4d slice-2)', () => {
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

  it('surfaces a term-matching studio clip via FTS (embedding OFF), hydrated + source=studio + trusted:false', async () => {
    const capture = captureFromPage(
      { type: 'clip', sessionId: 'sess-fts', url: 'https://x.example.com/p', title: 'Capture Notes', markdown: CLIP_MD },
      { db: getDatabase(), enqueue: () => undefined, credentialContext: {} },
    );
    const studioKey = `studio://clip|${capture.id}`;

    // embedding OFF — the only way the clip can surface is the FTS path.
    mockEmbeddingState.available = false;

    const out = await handleFindSimilar(
      { concept: CONCEPT, include_cache: true, include_web: false, include_full_markdown: true },
      [engine],
      router,
    );
    expect(out.ok).toBe(true);
    const results = out.ok ? out.data.results : [];
    const hit = results.find((r) => r.url === studioKey);
    expect(
      hit,
      `expected a FTS-path find_similar result for ${studioKey}; got ${JSON.stringify(results.map((r) => r.url))}`,
    ).toBeDefined();
    expect(hit!.markdown).toBe(CLIP_MD);
    const source: string = hit!.source;
    expect(source).toBe('studio');
    expect(hit!.trusted).toBe(false);
  });

  it('dedups a clip matching BOTH the FTS and embedding paths to ONE fused result with both signals', async () => {
    const capture = captureFromPage(
      { type: 'clip', sessionId: 'sess-x', url: 'https://x.example.com/p', title: 'Capture Notes', markdown: CLIP_MD },
      { db: getDatabase(), enqueue: () => undefined, credentialContext: {} },
    );
    const studioKey = `studio://clip|${capture.id}`;

    // BOTH paths return the SAME clip: embedding (stub) + FTS (CONCEPT matches CLIP_MD).
    mockEmbeddingState.available = true;
    mockEmbeddingState.subprocessReady = true;
    mockEmbeddingState.vectors.set(studioKey, 1);
    mockEmbeddingState.findSimilarImpl = async () => [{ url: studioKey, score: 0.99 }];

    const out = await handleFindSimilar(
      { concept: CONCEPT, include_cache: true, include_web: false, include_full_markdown: true, include_ranking_debug: true },
      [engine],
      router,
    );
    const results = out.ok ? out.data.results : [];
    // Count ALL studio-sourced results: if the two paths emitted divergent URIs
    // they would NOT fuse and we'd see two — dedup REQUIRES the identical URI,
    // so this catches a path whose URI drifts (not just a missing studioKey).
    const studioResults = results.filter((r) => r.source === 'studio');
    expect(studioResults).toHaveLength(1); // fused once, not one-per-path
    expect(studioResults[0].url).toBe(studioKey); // the canonical studio URI
    // Both signals merged into the one fused result.
    expect(studioResults[0].ranking_debug?.embedding_rank).toBeDefined();
    expect(studioResults[0].ranking_debug?.fts5_rank).toBeDefined();
  });

  it('evidence from an FTS-sourced studio clip carries trusted:false (include_full_markdown)', async () => {
    captureFromPage(
      { type: 'clip', sessionId: 'sess-evf', url: 'https://x.example.com/p', title: 'Capture Notes', markdown: CLIP_MD },
      { db: getDatabase(), enqueue: () => undefined, credentialContext: {} },
    );
    mockEmbeddingState.available = false; // FTS lane

    const out = await handleFindSimilar(
      { concept: CONCEPT, include_cache: true, include_web: false, include_full_markdown: true },
      [engine],
      router,
    );
    expect(out.ok).toBe(true);
    const evidence = out.ok ? (out.data.evidence ?? []) : [];
    expect(evidence.length).toBeGreaterThan(0);
    for (const e of evidence) expect(e.trusted).toBe(false);
  });

  it('evidence from an EMBEDDING-sourced studio clip carries trusted:false (covers the merged path)', async () => {
    const capture = captureFromPage(
      { type: 'clip', sessionId: 'sess-eve', url: 'https://x.example.com/p', title: 'Capture Notes', markdown: CLIP_MD },
      { db: getDatabase(), enqueue: () => undefined, credentialContext: {} },
    );
    const studioKey = `studio://clip|${capture.id}`;
    mockEmbeddingState.available = true;
    mockEmbeddingState.subprocessReady = true;
    mockEmbeddingState.vectors.set(studioKey, 1);
    mockEmbeddingState.findSimilarImpl = async () => [{ url: studioKey, score: 0.99 }];

    // unrelated concept → the clip arrives ONLY via the embedding path here.
    const out = await handleFindSimilar(
      { concept: 'unrelated zzqqx topic', include_cache: true, include_web: false, include_full_markdown: true },
      [engine],
      router,
    );
    expect(out.ok).toBe(true);
    const evidence = out.ok ? (out.data.evidence ?? []) : [];
    expect(evidence.length).toBeGreaterThan(0);
    for (const e of evidence) expect(e.trusted).toBe(false);
  });

  // C5 PIN-5: a url-less qa pair surfaces type-agnostically, exactly like a clip. Written via
  // captureFromPage (the primitive the dispatch/handler calls; the write chain is pinned at the
  // dispatch seam) — this file is a pure surfacing test.
  it('surfaces a captured qa pair via FTS (embedding OFF), source=studio + trusted:false, keyed studio://qa|<id> (C5 PIN-5)', async () => {
    const capture = captureFromPage(
      { type: 'qa', sessionId: 'sess-qa-fts', question: 'How does the capture pipeline work?', answer: CLIP_MD },
      { db: getDatabase(), enqueue: () => undefined, credentialContext: {} },
    );
    const qaKey = `studio://qa|${capture.id}`;
    mockEmbeddingState.available = false; // FTS lane — the only way the qa can surface
    const out = await handleFindSimilar(
      { concept: CONCEPT, include_cache: true, include_web: false, include_full_markdown: true },
      [engine],
      router,
    );
    expect(out.ok).toBe(true);
    const results = out.ok ? out.data.results : [];
    const hit = results.find((r) => r.url === qaKey);
    expect(hit, `expected a FTS-path find_similar result for ${qaKey}; got ${JSON.stringify(results.map((r) => r.url))}`).toBeDefined();
    expect(hit!.markdown).toBe(CLIP_MD);
    expect(hit!.source).toBe('studio');
    expect(hit!.trusted).toBe(false);
  });

  it('surfaces a captured qa pair via the embedding/concept path, keyed studio://qa|<id> + trusted:false (C5 PIN-5)', async () => {
    const capture = captureFromPage(
      { type: 'qa', sessionId: 'sess-qa-emb', question: 'session capture seed', answer: CLIP_MD },
      { db: getDatabase(), enqueue: () => undefined, credentialContext: {} },
    );
    const qaKey = `studio://qa|${capture.id}`;
    mockEmbeddingState.available = true;
    mockEmbeddingState.subprocessReady = true;
    mockEmbeddingState.vectors.set(qaKey, 1);
    mockEmbeddingState.findSimilarImpl = async () => [{ url: qaKey, score: 0.99 }];
    // unrelated concept → the qa arrives ONLY via the embedding path here (not FTS).
    const out = await handleFindSimilar(
      { concept: 'unrelated zzqqx topic', include_cache: true, include_web: false, include_full_markdown: true },
      [engine],
      router,
    );
    expect(out.ok).toBe(true);
    const results = out.ok ? out.data.results : [];
    const hit = results.find((r) => r.url === qaKey);
    expect(hit, `expected an embedding-path find_similar result for ${qaKey}`).toBeDefined();
    expect(hit!.trusted).toBe(false);
  });
});
