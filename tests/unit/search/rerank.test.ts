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

const makeResult = (title: string, score: number): MergedSearchResult => ({
  title,
  url: `https://${title.toLowerCase().replace(/\s+/g, '-')}.com`,
  snippet: `Snippet about ${title}`,
  relevance_score: score,
  engines: ['test'],
});

describe('rerankResults with FlashRank', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses FlashRank when configured and available -- verify reordering', async () => {
    vi.mocked(getConfig).mockReturnValue({ reranker: 'flashrank', relevanceThreshold: 0 } as any);
    vi.mocked(isFlashRankAvailable).mockResolvedValue(true);
    vi.mocked(flashRankRerank).mockResolvedValue([
      { index: 2, score: 0.98 },
      { index: 0, score: 0.75 },
      { index: 1, score: 0.42 },
    ]);

    const results = [makeResult('A', 0.9), makeResult('B', 0.5), makeResult('C', 0.3)];
    const reranked = await rerankResults('query', results);

    expect(reranked[0].title).toBe('C');
    expect(reranked[0].relevance_score).toBe(0.98);
    expect(reranked[1].title).toBe('A');
    expect(reranked[1].relevance_score).toBe(0.75);
    expect(reranked[2].title).toBe('B');
    expect(reranked[2].relevance_score).toBe(0.42);
  });

  it('falls back to passthrough when FlashRank configured but not available', async () => {
    vi.mocked(getConfig).mockReturnValue({ reranker: 'flashrank', relevanceThreshold: 0 } as any);
    vi.mocked(isFlashRankAvailable).mockResolvedValue(false);

    const results = [makeResult('A', 0.9), makeResult('B', 0.5)];
    const reranked = await rerankResults('query', results);

    expect(reranked).toEqual(results);
    expect(flashRankRerank).not.toHaveBeenCalled();
  });

  it('falls back gracefully when FlashRank subprocess fails mid-execution', async () => {
    vi.mocked(getConfig).mockReturnValue({ reranker: 'flashrank', relevanceThreshold: 0 } as any);
    vi.mocked(isFlashRankAvailable).mockResolvedValue(true);
    vi.mocked(flashRankRerank).mockResolvedValue(null);

    const results = [makeResult('A', 0.9), makeResult('B', 0.5)];
    const reranked = await rerankResults('query', results);

    expect(reranked).toEqual(results);
  });

  it('filters results below relevance threshold', async () => {
    vi.mocked(getConfig).mockReturnValue({ reranker: 'flashrank', relevanceThreshold: 0.5 } as any);
    vi.mocked(isFlashRankAvailable).mockResolvedValue(true);
    vi.mocked(flashRankRerank).mockResolvedValue([
      { index: 0, score: 0.95 },
      { index: 1, score: 0.3 },
    ]);

    const results = [makeResult('Good', 0.9), makeResult('Bad', 0.5)];
    const reranked = await rerankResults('query', results);

    expect(reranked).toHaveLength(1);
    expect(reranked[0].title).toBe('Good');
  });

  it('threshold 0.0 does no filtering (all results pass)', async () => {
    vi.mocked(getConfig).mockReturnValue({ reranker: 'flashrank', relevanceThreshold: 0 } as any);
    vi.mocked(isFlashRankAvailable).mockResolvedValue(true);
    vi.mocked(flashRankRerank).mockResolvedValue([
      { index: 0, score: 0.01 },
      { index: 1, score: 0.001 },
    ]);

    const results = [makeResult('Low', 0.1), makeResult('Lower', 0.05)];
    const reranked = await rerankResults('query', results);

    expect(reranked).toHaveLength(2);
  });

  it('threshold 1.0 filters everything except perfect scores', async () => {
    vi.mocked(getConfig).mockReturnValue({ reranker: 'flashrank', relevanceThreshold: 1.0 } as any);
    vi.mocked(isFlashRankAvailable).mockResolvedValue(true);
    vi.mocked(flashRankRerank).mockResolvedValue([
      { index: 0, score: 1.0 },
      { index: 1, score: 0.99 },
      { index: 2, score: 0.5 },
    ]);

    const results = [makeResult('Perfect', 0.9), makeResult('Almost', 0.8), makeResult('Mid', 0.5)];
    const reranked = await rerankResults('query', results);

    expect(reranked).toHaveLength(1);
    expect(reranked[0].title).toBe('Perfect');
  });

  it('threshold with no results above it returns empty', async () => {
    vi.mocked(getConfig).mockReturnValue({ reranker: 'flashrank', relevanceThreshold: 0.9 } as any);
    vi.mocked(isFlashRankAvailable).mockResolvedValue(true);
    vi.mocked(flashRankRerank).mockResolvedValue([
      { index: 0, score: 0.3 },
      { index: 1, score: 0.2 },
    ]);

    const results = [makeResult('A', 0.5), makeResult('B', 0.4)];
    const reranked = await rerankResults('query', results);

    expect(reranked).toHaveLength(0);
  });

  it('passes through when reranker=none', async () => {
    vi.mocked(getConfig).mockReturnValue({ reranker: 'none', relevanceThreshold: 0 } as any);

    const results = [makeResult('A', 0.9), makeResult('B', 0.5)];
    const reranked = await rerankResults('query', results);

    expect(reranked).toEqual(results);
    expect(isFlashRankAvailable).not.toHaveBeenCalled();
    expect(flashRankRerank).not.toHaveBeenCalled();
  });

  it('logs warning and passes through when reranker=custom (future-proofing)', async () => {
    vi.mocked(getConfig).mockReturnValue({ reranker: 'custom', relevanceThreshold: 0 } as any);

    const results = [makeResult('A', 0.9)];
    const reranked = await rerankResults('query', results);

    expect(reranked).toEqual(results);
  });

  it('handles empty result set with FlashRank enabled', async () => {
    vi.mocked(getConfig).mockReturnValue({ reranker: 'flashrank', relevanceThreshold: 0 } as any);

    const reranked = await rerankResults('query', []);

    expect(reranked).toEqual([]);
    expect(isFlashRankAvailable).not.toHaveBeenCalled();
  });

  it('preserves all MergedSearchResult fields after reranking', async () => {
    vi.mocked(getConfig).mockReturnValue({ reranker: 'flashrank', relevanceThreshold: 0 } as any);
    vi.mocked(isFlashRankAvailable).mockResolvedValue(true);
    vi.mocked(flashRankRerank).mockResolvedValue([
      { index: 0, score: 0.88 },
    ]);

    const results: MergedSearchResult[] = [{
      title: 'Full Result',
      url: 'https://example.com/full',
      snippet: 'A detailed snippet',
      relevance_score: 0.5,
      engines: ['searxng', 'duckduckgo'],
    }];

    const reranked = await rerankResults('query', results);

    expect(reranked[0].title).toBe('Full Result');
    expect(reranked[0].url).toBe('https://example.com/full');
    expect(reranked[0].snippet).toBe('A detailed snippet');
    expect(reranked[0].engines).toEqual(['searxng', 'duckduckgo']);
    expect(reranked[0].relevance_score).toBe(0.88);
  });

  it('applies threshold even in passthrough mode (no reranker)', async () => {
    vi.mocked(getConfig).mockReturnValue({ reranker: 'none', relevanceThreshold: 0.6 } as any);

    const results = [makeResult('High', 0.9), makeResult('Low', 0.3)];
    const reranked = await rerankResults('query', results);

    expect(reranked).toHaveLength(1);
    expect(reranked[0].title).toBe('High');
  });
});

describe('rerankResults cross-slice ordering (Slice 9 + Slice 7)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reranking happens BEFORE domain filtering in the pipeline', async () => {
    vi.mocked(getConfig).mockReturnValue({ reranker: 'flashrank', relevanceThreshold: 0 } as any);
    vi.mocked(isFlashRankAvailable).mockResolvedValue(true);
    vi.mocked(flashRankRerank).mockResolvedValue([
      { index: 2, score: 0.99 },
      { index: 0, score: 0.80 },
      { index: 1, score: 0.60 },
    ]);

    const results = [
      makeResult('Doc A', 0.9),
      makeResult('Doc B', 0.7),
      makeResult('Doc C', 0.5),
    ];

    const reranked = await rerankResults('typescript generics', results);

    expect(reranked[0].title).toBe('Doc C');
    expect(reranked[0].relevance_score).toBe(0.99);
    expect(reranked).toHaveLength(3);
  });
});
