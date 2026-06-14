import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SearchEngine, RawSearchResult, ResearchInput } from '../../../src/types.js';
import type { SmartRouter } from '../../../src/fetch/router.js';

const ON_TOPIC = Array.from(
  { length: 30 },
  () => 'SQLite FTS5 full text search versus a dedicated vector database tradeoffs for local semantic ranking',
).join('. ');

vi.mock('../../../src/providers/extract-provider.js', () => ({
  getExtractProvider: vi.fn(async () => ({
    name: 'v1' as const,
    extract: vi.fn(async (_html: string, url: string) => ({
      title: `Title for ${url}`,
      markdown: ON_TOPIC,
      metadata: {},
      links: [],
      images: [],
      extractor: 'defuddle' as const,
    })),
  })),
  _resetExtractProviderForTest: vi.fn(),
}));

vi.mock('../../../src/cache/store.js', () => ({
  cacheContent: vi.fn(),
  normalizeUrl: vi.fn((url: string) => url),
}));

const { runResearchPipeline } = await import('../../../src/research/pipeline.js');

function createStubEngine(results: RawSearchResult[]): SearchEngine {
  return { name: 'stub', search: vi.fn().mockResolvedValue(results) } as unknown as SearchEngine;
}

function createStubRouter(): SmartRouter {
  return {
    fetch: vi.fn(async (url: string) => ({
      url,
      finalUrl: url,
      html: `<html><body><p>content</p></body></html>`,
      contentType: 'text/html',
      statusCode: 200,
      method: 'http' as const,
      headers: {},
    })),
  } as unknown as SmartRouter;
}

function goodResult(i: number, score: number): RawSearchResult {
  return {
    title: `FTS5 vs vector DB article ${i}`,
    url: `https://content${i}.example.com/articles/fts5-vs-vector-${i}`,
    snippet: 'SQLite FTS5 versus a dedicated vector database tradeoffs.',
    relevance_score: score,
    engine: 'stub',
  };
}

const QUESTION = 'SQLite FTS5 vs dedicated vector database tradeoffs';

describe('research pipeline relevance-score floor', () => {
  beforeEach(() => vi.clearAllMocks());

  it('drops negative-scored off-topic real-content sources and tags them score-floor', async () => {
    // WHY: the C1 benchmark leaked YouTube / Google Play / Zhihu / MyBroadband
    // into the 15-source pool with NEGATIVE reranker scores. They are real
    // content (so the url-shape + content gates pass them) but off-topic — the
    // cross-encoder scored them below 0. The score floor is the cheap
    // pre-filter that drops them before the url-shape loop.
    const results: RawSearchResult[] = [
      ...Array.from({ length: 10 }, (_, i) => goodResult(i, 0.9 - i * 0.05)),
      { title: 'Some video', url: 'https://www.youtube.com/watch?v=abc123', snippet: 'unrelated', relevance_score: -0.4, engine: 'stub' },
      { title: 'An app', url: 'https://play.google.com/store/apps/details?id=x', snippet: 'unrelated', relevance_score: -1.2, engine: 'stub' },
      { title: 'Zhihu answer', url: 'https://www.zhihu.com/question/12345', snippet: 'unrelated', relevance_score: -0.8, engine: 'stub' },
    ];
    const input: ResearchInput = { question: QUESTION, depth: 'quick' };

    const result = await runResearchPipeline(input, [createStubEngine(results)], createStubRouter());

    const urls = result.sources.map((s) => s.url);
    expect(urls).not.toContain('https://www.youtube.com/watch?v=abc123');
    expect(urls).not.toContain('https://play.google.com/store/apps/details?id=x');
    expect(urls).not.toContain('https://www.zhihu.com/question/12345');

    const floorRejects = (result.rejected_sources ?? []).filter((r) => r.stage === 'score-floor');
    expect(floorRejects.map((r) => r.url).sort()).toEqual(
      [
        'https://play.google.com/store/apps/details?id=x',
        'https://www.youtube.com/watch?v=abc123',
        'https://www.zhihu.com/question/12345',
      ].sort(),
    );
    for (const r of floorRejects) expect(r.reason).toBe('negative-score');
  });

  it('back-fills dropped junk so the source count stays at max_sources', async () => {
    // WHY: dropping negative-scored junk must not shrink the brief — the floor
    // runs before the slice so a next-ranked legitimate candidate fills the slot.
    const results: RawSearchResult[] = [
      ...Array.from({ length: 10 }, (_, i) => goodResult(i, 0.9 - i * 0.05)),
      { title: 'video', url: 'https://www.youtube.com/watch?v=x', snippet: 'unrelated', relevance_score: -0.5, engine: 'stub' },
      { title: 'video2', url: 'https://www.youtube.com/watch?v=y', snippet: 'unrelated', relevance_score: -0.6, engine: 'stub' },
    ];
    const input: ResearchInput = { question: QUESTION, depth: 'quick' }; // max_sources 8

    const result = await runResearchPipeline(input, [createStubEngine(results)], createStubRouter());

    expect(result.sources).toHaveLength(8);
  });

  it('keeps positive-scored sources untouched (keyless passthrough path unaffected)', async () => {
    // WHY: without the cross-encoder, scores are positive engine/RRF values —
    // the floor must be a no-op on them so the keyless path is never thinned.
    const results: RawSearchResult[] = Array.from({ length: 6 }, (_, i) => goodResult(i, 0.5 - i * 0.05));
    const input: ResearchInput = { question: QUESTION, depth: 'quick' };

    const result = await runResearchPipeline(input, [createStubEngine(results)], createStubRouter());

    const floorRejects = (result.rejected_sources ?? []).filter((r) => r.stage === 'score-floor');
    expect(floorRejects).toHaveLength(0);
    expect(result.sources.length).toBeGreaterThanOrEqual(6);
  });

  it('never empties the pool: keeps the top source even if every score is negative', async () => {
    // WHY: degenerate case — the reranker damped everything below zero. A
    // single best source still beats an empty brief.
    const results: RawSearchResult[] = [
      goodResult(0, -0.1),
      goodResult(1, -0.5),
      goodResult(2, -0.9),
    ];
    const input: ResearchInput = { question: QUESTION, depth: 'quick' };

    const result = await runResearchPipeline(input, [createStubEngine(results)], createStubRouter());

    expect(result.sources.length).toBeGreaterThanOrEqual(1);
  });

  it('standard depth keeps >=6 on-topic sources when the reranker damps the whole pool slightly negative', async () => {
    // WHY (C1 breadth wobble): the cross-encoder scores a *moderately*-relevant
    // pool slightly below zero across the board — these are genuine on-topic
    // articles (they pass url-shape + content gates), not the off-topic junk the
    // floor was built to drop. The old floor kept only merged[0] and dropped the
    // rest, collapsing standard depth to ~1-5 sources. The fix keeps the top
    // minSources candidates by rank so standard reliably back-fills to >=6 when
    // that many on-topic survivors exist. These 9 are the genuine pool; the two
    // off-topic videos rank below the keep-floor and must still be dropped.
    const results: RawSearchResult[] = [
      ...Array.from({ length: 9 }, (_, i) => goodResult(i, -0.05 - i * 0.02)),
      { title: 'Unrelated video', url: 'https://www.youtube.com/watch?v=junk1', snippet: 'unrelated', relevance_score: -0.95, engine: 'stub' },
      { title: 'Unrelated video 2', url: 'https://www.youtube.com/watch?v=junk2', snippet: 'unrelated', relevance_score: -0.99, engine: 'stub' },
    ];
    const input: ResearchInput = { question: QUESTION, depth: 'standard' };

    const result = await runResearchPipeline(input, [createStubEngine(results)], createStubRouter());

    expect(result.sources.length).toBeGreaterThanOrEqual(6);
    const urls = result.sources.map((s) => s.url);
    expect(urls).not.toContain('https://www.youtube.com/watch?v=junk1');
    expect(urls).not.toContain('https://www.youtube.com/watch?v=junk2');
  });

  it('standard depth keeps >=6 canonical sources even when the reranker damps the whole pool BELOW -0.35', async () => {
    // WHY (C1 LIVE failure, the regression PR #123's -0.35 floor did NOT fix):
    // on the niche query "tradeoffs between SQLite FTS5 and a dedicated vector
    // database for local semantic search" LIVE runs returned only 1 and 5
    // sources. The rejected breakdown showed CANONICAL, on-topic pages
    // (sqlite.org/fts5.html, the sqlite-vec author's observablehq post,
    // dev.to/deepwiki/kentcdodds explainers) all rejected as `negative-score`
    // — i.e. the cross-encoder damped the WHOLE pool below the -0.35
    // HARD_JUNK_FLOOR, not merely below 0. The reranker's ABSOLUTE logits are
    // miscalibrated for this niche query; its RELATIVE ordering is still good.
    // So any fixed absolute floor (0 or -0.35) collapses breadth.
    //
    // These 12 candidates ALL pass url-shape + the content gate and ALL score
    // in the -0.1 .. -0.6 band (below -0.35), mirroring the live data. Inside
    // the top-minSources (standard=10) rank window the fix trusts the
    // reranker's relative order + the upstream gates and keeps by rank
    // regardless of the negative score, so standard reliably back-fills to >=6.
    // On current main HARD_JUNK_FLOOR=-0.35 rejects every candidate below -0.35
    // (only merged[0] survives via i===0), collapsing to ~1 — this asserts >=6.
    const results: RawSearchResult[] = Array.from(
      { length: 12 },
      (_, i) => goodResult(i, -0.4 - i * 0.05), // -0.4, -0.45, ... -0.95 — ALL below -0.35
    );
    const input: ResearchInput = { question: QUESTION, depth: 'standard' };

    const result = await runResearchPipeline(input, [createStubEngine(results)], createStubRouter());

    expect(result.sources.length).toBeGreaterThanOrEqual(6);
    // No score-floor reject inside the top-minSources window: the canonical
    // pool is kept by rank, not by an absolute cutoff.
    const floorRejects = (result.rejected_sources ?? []).filter((r) => r.stage === 'score-floor');
    const keptUrls = new Set(result.sources.map((s) => s.url));
    for (let i = 0; i < 6; i++) {
      expect(keptUrls).toContain(`https://content${i}.example.com/articles/fts5-vs-vector-${i}`);
    }
    // Whatever the floor rejected (the long tail beyond the window) must NOT be
    // among the kept sources — rank-keep widens breadth without re-admitting it.
    for (const r of floorRejects) expect(keptUrls.has(r.url)).toBe(false);
  });

  it('still drops a negative-scored off-topic source that ranks OUTSIDE the breadth window', async () => {
    // WHY: rank-keep applies ONLY inside the top-minSources window. A genuine
    // off-topic page (negative score) that ranks past the window must still hit
    // the strict `< 0` floor — that is what keeps junk out of the long tail
    // while the window stays wide. minSources for standard is 10, so an
    // off-topic candidate at rank 11+ (with a clearly-negative score, lower than
    // the on-topic tail) is dropped even though the on-topic pool above it is
    // also slightly negative.
    const results: RawSearchResult[] = [
      ...Array.from({ length: 10 }, (_, i) => goodResult(i, -0.4 - i * 0.02)), // ranks 0..9, inside window, all < -0.35
      { title: 'Off-topic forum', url: 'https://www.zhihu.com/question/99', snippet: 'unrelated', relevance_score: -0.8, engine: 'stub' }, // rank 10, outside window
    ];
    const input: ResearchInput = { question: QUESTION, depth: 'standard' };

    const result = await runResearchPipeline(input, [createStubEngine(results)], createStubRouter());

    const urls = result.sources.map((s) => s.url);
    expect(urls).not.toContain('https://www.zhihu.com/question/99');
    const floorRejects = (result.rejected_sources ?? []).filter((r) => r.stage === 'score-floor');
    expect(floorRejects.map((r) => r.url)).toContain('https://www.zhihu.com/question/99');
  });
});
