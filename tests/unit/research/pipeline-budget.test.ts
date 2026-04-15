import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SearchEngine, RawSearchResult, ResearchInput } from '../../../src/types.js';
import type { SmartRouter } from '../../../src/fetch/router.js';

vi.mock('../../../src/extraction/pipeline.js', () => ({
  extractContent: vi.fn().mockResolvedValue({
    title: 'Big Source',
    markdown: 'x'.repeat(30000),
    metadata: {},
    links: [],
    images: [],
    extractor: 'defuddle' as const,
  }),
}));

vi.mock('../../../src/cache/store.js', () => ({
  cacheContent: vi.fn(),
  normalizeUrl: vi.fn((url: string) => url),
}));

const { runResearchPipeline } = await import('../../../src/research/pipeline.js');

function stubEngine(n: number): SearchEngine {
  const results: RawSearchResult[] = Array.from({ length: n }, (_, i) => ({
    title: `Source ${i + 1}`,
    url: `https://e.com/${i + 1}`,
    snippet: `snippet ${i + 1}`,
    relevance_score: 1 - i * 0.01,
    engine: 'stub',
  }));
  return {
    name: 'stub',
    search: vi.fn().mockResolvedValue(results),
  };
}

function stubRouter(): SmartRouter {
  return {
    fetch: vi.fn().mockImplementation(async (url: string) => ({
      url, finalUrl: url,
      html: '<html></html>',
      contentType: 'text/html',
      statusCode: 200,
      method: 'http' as const,
      headers: {},
    })),
  } as unknown as SmartRouter;
}

describe('research output budget', () => {
  beforeEach(() => vi.clearAllMocks());

  it('caps per-source markdown at ~3000 chars with smart truncation marker', async () => {
    const engine = stubEngine(10);
    const router = stubRouter();
    const input: ResearchInput = { question: 'q', depth: 'standard' };
    const out = await runResearchPipeline(input, [engine], router);
    for (const s of out.sources) {
      expect(s.markdown_content.length).toBeLessThanOrEqual(3030);
    }
    // At least one source should be flagged as truncated via marker
    const anyTruncated = out.sources.some(s => s.markdown_content.endsWith('[... content truncated]'));
    expect(anyTruncated).toBe(true);
  });

  it('caps total returned source chars at 40000', async () => {
    const engine = stubEngine(25);
    const router = stubRouter();
    const input: ResearchInput = { question: 'q', depth: 'comprehensive' };
    const out = await runResearchPipeline(input, [engine], router);
    const total = out.sources.reduce((sum, s) => sum + s.markdown_content.length, 0);
    expect(total).toBeLessThanOrEqual(40000 + 500); // small marker slack
  });
});
