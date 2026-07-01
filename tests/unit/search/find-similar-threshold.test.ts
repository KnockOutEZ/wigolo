import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  FindSimilarInput,
  SearchEngine,
  RawSearchResult,
  RawFetchResult,
  ExtractionResult,
} from '../../../src/types.js';
import type { SmartRouter } from '../../../src/fetch/router.js';
import { resetConfig } from '../../../src/config.js';
import { initDatabase, closeDatabase } from '../../../src/cache/db.js';
import { cacheContent } from '../../../src/cache/store.js';

const extractMock = vi.fn().mockResolvedValue({
  title: 'Mock Title',
  markdown: '# Mock Content',
  metadata: {},
  links: [],
  images: [],
  extractor: 'defuddle' as const,
});
vi.mock('../../../src/providers/extract-provider.js', () => ({
  getExtractProvider: vi.fn(async () => ({
    name: 'v1' as const,
    extract: extractMock,
  })),
  _resetExtractProviderForTest: vi.fn(),
}));

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

// find_similar `threshold` parameter must be enforced as a HARD post-filter
// on the per-result fused_score (the actual signal strength). For example:
// threshold: 0.95 returned 3 results with fused_score: 0.029. Today the field
// is silently ignored.
describe('find_similar — threshold enforcement (H8)', () => {
  const originalEnv = process.env;

  const mockSearchEngine: SearchEngine = {
    name: 'mock',
    search: vi.fn().mockResolvedValue([] satisfies RawSearchResult[]),
  };

  const mockRouter = {
    fetch: vi.fn().mockResolvedValue({
      url: 'https://example.com',
      finalUrl: 'https://example.com',
      html: '<html></html>',
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
      // Disable the cold_start weak-signal rescore so we can assert against
      // fused_score directly without it being replaced by the normalized score
      // and without separate paths interfering with threshold filtering.
      WIGOLO_FIND_SIMILAR_COLD_START_THRESHOLD: '0',
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

  it('drops results whose fused_score is below the threshold', async () => {
    // Seed enough cache pages so we get multiple hits. The raw RRF fused_score
    // is small (~1/61 ≈ 0.016 per page in this setup). A threshold of 0.9
    // should reject ALL results.
    for (let i = 0; i < 5; i++) {
      seedCache(
        `https://noise-${i}.example`,
        `Framework Note ${i}`,
        `# Framework Note ${i}\n\nA short note about an unrelated **framework**.`,
      );
    }

    const input: FindSimilarInput = {
      concept: 'framework',
      include_cache: true,
      include_web: false,
      threshold: 0.9,
    };

    const result = await findSimilar(input, [mockSearchEngine], mockRouter);

    // Every kept result must clear the threshold.
    for (const r of result.results) {
      expect(r.match_signals.fused_score).toBeGreaterThanOrEqual(0.9);
    }
    // For example: threshold:0.95 returned 3 results with fused_score:0.029.
    // After the fix the answer must be an empty array (or at least zero
    // sub-threshold leaks).
    const subThreshold = result.results.filter(
      (r) => r.match_signals.fused_score < 0.9,
    );
    expect(subThreshold).toEqual([]);
  });

  it('keeps results whose fused_score meets or exceeds the threshold', async () => {
    seedCache(
      'https://react.dev/hooks',
      'React Hooks',
      '# React Hooks\n\nHooks for **state** management.',
    );

    // Threshold of 0 keeps everything; baseline that find_similar still returns
    // results when threshold doesn't reject.
    const input: FindSimilarInput = {
      concept: 'React hooks state',
      include_cache: true,
      include_web: false,
      threshold: 0,
    };

    const result = await findSimilar(input, [mockSearchEngine], mockRouter);

    expect(result.results.length).toBeGreaterThan(0);
  });

  it('empty results when no candidates meet the threshold (no silent relax)', async () => {
    // Threshold > any possible fused_score must yield zero results, not a
    // best-effort partial set.
    seedCache(
      'https://a.com/x',
      'A',
      '# A\n\nSome **framework** content.',
    );
    seedCache(
      'https://b.com/x',
      'B',
      '# B\n\nMore **framework** content.',
    );

    const input: FindSimilarInput = {
      concept: 'framework',
      include_cache: true,
      include_web: false,
      threshold: 0.999,
    };

    const result = await findSimilar(input, [mockSearchEngine], mockRouter);

    expect(result.results).toEqual([]);
  });

  it('threshold:0 (or omitted) preserves existing behavior', async () => {
    seedCache(
      'https://react.dev/hooks',
      'React Hooks',
      '# React Hooks\n\nHooks for **state**.',
    );

    const baselineResult = await findSimilar(
      { concept: 'React hooks', include_cache: true, include_web: false },
      [mockSearchEngine],
      mockRouter,
    );
    const thresholdZeroResult = await findSimilar(
      { concept: 'React hooks', include_cache: true, include_web: false, threshold: 0 },
      [mockSearchEngine],
      mockRouter,
    );

    expect(thresholdZeroResult.results.length).toBe(baselineResult.results.length);
  });
});
