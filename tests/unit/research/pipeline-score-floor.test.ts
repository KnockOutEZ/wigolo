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
});
