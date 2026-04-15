import { describe, it, expect, vi, beforeEach } from 'vitest';
import { rerankResults } from '../../../src/search/rerank.js';
import type { MergedSearchResult } from '../../../src/search/dedup.js';

vi.mock('../../../src/search/flashrank.js', () => ({
  isFlashRankAvailable: vi.fn(),
  flashRankRerank: vi.fn(),
}));

vi.mock('../../../src/config.js', () => ({
  getConfig: vi.fn(),
}));

vi.mock('../../../src/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { isFlashRankAvailable, flashRankRerank } from '../../../src/search/flashrank.js';
import { getConfig } from '../../../src/config.js';

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

function makeResult(title: string, score: number, publishedDays?: number): MergedSearchResult {
  return {
    title,
    url: `https://${title.toLowerCase().replace(/\s+/g, '-')}.com`,
    snippet: `Snippet about ${title}`,
    relevance_score: score,
    engines: ['test'],
    ...(publishedDays !== undefined ? { published_date: isoDaysAgo(publishedDays) } : {}),
  };
}

describe('rerankResults recency boost', () => {
  beforeEach(() => vi.clearAllMocks());

  it('boosts fresh (<7d) by 1.2×', async () => {
    vi.mocked(getConfig).mockReturnValue({ reranker: 'none', relevanceThreshold: 0 } as any);
    const results = [makeResult('Fresh', 0.5, 3)];
    const out = await rerankResults('q', results);
    expect(out[0].relevance_score).toBeCloseTo(0.5 * 1.2, 5);
  });

  it('boosts 7-30d by 1.1×', async () => {
    vi.mocked(getConfig).mockReturnValue({ reranker: 'none', relevanceThreshold: 0 } as any);
    const results = [makeResult('Recent', 0.5, 20)];
    const out = await rerankResults('q', results);
    expect(out[0].relevance_score).toBeCloseTo(0.5 * 1.1, 5);
  });

  it('boosts 30-90d by 1.05×', async () => {
    vi.mocked(getConfig).mockReturnValue({ reranker: 'none', relevanceThreshold: 0 } as any);
    const results = [makeResult('Older', 0.5, 60)];
    const out = await rerankResults('q', results);
    expect(out[0].relevance_score).toBeCloseTo(0.5 * 1.05, 5);
  });

  it('does not boost >90d', async () => {
    vi.mocked(getConfig).mockReturnValue({ reranker: 'none', relevanceThreshold: 0 } as any);
    const results = [makeResult('Old', 0.5, 200)];
    const out = await rerankResults('q', results);
    expect(out[0].relevance_score).toBe(0.5);
  });

  it('passes through results without published_date unchanged', async () => {
    vi.mocked(getConfig).mockReturnValue({ reranker: 'none', relevanceThreshold: 0 } as any);
    const results = [makeResult('NoDate', 0.5)];
    const out = await rerankResults('q', results);
    expect(out[0].relevance_score).toBe(0.5);
  });

  it('applies boost AFTER FlashRank scoring', async () => {
    vi.mocked(getConfig).mockReturnValue({ reranker: 'flashrank', relevanceThreshold: 0 } as any);
    vi.mocked(isFlashRankAvailable).mockResolvedValue(true);
    vi.mocked(flashRankRerank).mockResolvedValue([{ index: 0, score: 0.8 }]);

    const results = [makeResult('Fresh', 0.1, 3)];
    const out = await rerankResults('q', results);
    expect(out[0].relevance_score).toBeCloseTo(0.8 * 1.2, 5);
  });

  it('applies boost BEFORE threshold filter', async () => {
    // Score 0.5 × 1.2 = 0.6, so threshold 0.55 should keep it
    vi.mocked(getConfig).mockReturnValue({ reranker: 'none', relevanceThreshold: 0.55 } as any);
    const results = [makeResult('Fresh', 0.5, 3)];
    const out = await rerankResults('q', results);
    expect(out).toHaveLength(1);
    expect(out[0].relevance_score).toBeCloseTo(0.6, 5);
  });

  it('invalid published_date passes through unchanged', async () => {
    vi.mocked(getConfig).mockReturnValue({ reranker: 'none', relevanceThreshold: 0 } as any);
    const results: MergedSearchResult[] = [{
      title: 'Bad',
      url: 'https://bad.com',
      snippet: '',
      relevance_score: 0.5,
      engines: ['a'],
      published_date: 'not-a-date',
    }];
    const out = await rerankResults('q', results);
    expect(out[0].relevance_score).toBe(0.5);
  });
});
