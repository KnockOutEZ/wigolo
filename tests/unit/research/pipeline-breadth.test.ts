import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SearchEngine, RawSearchResult, ResearchInput } from '../../../src/types.js';
import type { SmartRouter } from '../../../src/fetch/router.js';

// Substantial on-topic prose so the content gate keeps real candidates and the
// only drops are the deliberate url-shape junk (homepage / SERP / LinkedIn).
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

const { runResearchPipeline, DEPTH_CONFIG, OVER_FETCH_BUFFER_FACTOR } = await import(
  '../../../src/research/pipeline.js'
);

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

describe('research pipeline source breadth (standard depth)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('standard depth config widens to minSources=15, maxSources=20, buffer=0.6', () => {
    // WHY: the live COLD MCP call retained only 10 sources / 5 cited because the
    // breadth window (minSources) + slice (maxSources) + over-fetch buffer were
    // too small for the niche query — 56 sources (incl. canonical sqlite.org)
    // were rejected. The fix raises the window so the rank-based in-window keep
    // readmits more on-topic/canonical sources. These exact knobs are the fix:
    // FAILS on the prior 10 / 15 / 0.4.
    expect(DEPTH_CONFIG.standard.minSources).toBe(15);
    expect(DEPTH_CONFIG.standard.maxSources).toBe(20);
    expect(OVER_FETCH_BUFFER_FACTOR).toBe(0.6);
  });

  it('keeps a wide on-topic set at the larger window while url-shape junk is still dropped', async () => {
    // WHY: widening minSources must readmit more on-topic/canonical sources
    // WITHOUT re-admitting junk. This mirrors the niche live query: 30 genuine
    // on-topic candidates whose reranker logits are damped slightly negative
    // (so the rank-based in-window keep — not an absolute floor — is what
    // retains them) plus a bare homepage, a SERP URL, and a LinkedIn activity
    // post that the cross-encoder ranked INSIDE the breadth window (slightly
    // less negative). Inside the window the score-floor is disabled, so the junk
    // survives the score-floor by rank and reaches the url-shape gate — which
    // must drop all three. Guards the no-junk-leak invariant at the larger
    // window. On the OLD config (minSources=10) the on-topic yield collapsed
    // toward the lower band; the widened window lifts it into the 10-12 target.
    const junkHomepage = 'https://example.org/';
    const junkSerp = 'https://www.bing.com/search?q=fts5';
    const junkLinkedIn =
      'https://www.linkedin.com/posts/jane_sqlite-vector-activity-7123456789012345678-AbCd';

    const results: RawSearchResult[] = [
      // Junk ranks at the very top of the window (least negative), exactly where
      // it would steal slots if url-shape did not drop it.
      { title: 'Homepage', url: junkHomepage, snippet: 'x', relevance_score: -0.02, engine: 'stub' },
      { title: 'Bing search', url: junkSerp, snippet: 'x', relevance_score: -0.03, engine: 'stub' },
      { title: 'Promo post', url: junkLinkedIn, snippet: 'check out my post', relevance_score: -0.04, engine: 'stub' },
      // 30 genuine on-topic candidates, all slightly negative (niche-query
      // miscalibration) and ranked below the junk.
      ...Array.from({ length: 30 }, (_, i) => goodResult(i, -0.1 - i * 0.01)),
    ];
    const input: ResearchInput = { question: QUESTION, depth: 'standard' };

    const result = await runResearchPipeline(input, [createStubEngine(results)], createStubRouter());

    const urls = result.sources.map((s) => s.url);

    // No junk leaked into a source slot at the wider window.
    expect(urls).not.toContain(junkHomepage);
    expect(urls).not.toContain(junkSerp);
    expect(urls).not.toContain(junkLinkedIn);

    // The junk was rejected via the url-shape gate, surfaced not swallowed.
    const urlShapeRejects = (result.rejected_sources ?? []).filter((r) => r.stage === 'url-shape');
    const rejectedUrls = urlShapeRejects.map((r) => r.url);
    expect(rejectedUrls).toContain(junkHomepage);
    expect(rejectedUrls).toContain(junkSerp);
    expect(rejectedUrls).toContain(junkLinkedIn);

    // Retained set is bounded by the maxSources slice and reaches the 10-12
    // clean-source target band the widened window unlocks. Every retained
    // source is one of the on-topic candidates (no junk slipped in).
    expect(result.sources.length).toBeLessThanOrEqual(DEPTH_CONFIG.standard.maxSources);
    expect(result.sources.length).toBeGreaterThanOrEqual(10);
    for (const s of result.sources) {
      expect(s.url).toMatch(/^https:\/\/content\d+\.example\.com\/articles\/fts5-vs-vector-\d+$/);
    }
  });
});
