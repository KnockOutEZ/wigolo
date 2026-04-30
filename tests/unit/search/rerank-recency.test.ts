import { describe, it, expect, vi, beforeEach } from 'vitest';
import { rerankResults } from '../../../src/search/rerank.js';
import type { MergedSearchResult } from '../../../src/search/dedup.js';

vi.mock('../../../src/search/reranker/onnx.js', () => ({
  onnxRerank: vi.fn(),
}));
vi.mock('../../../src/config.js', () => ({ getConfig: vi.fn() }));
vi.mock('../../../src/logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { onnxRerank } from '../../../src/search/reranker/onnx.js';
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

describe('rerankResults recency boost (intent-gated)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getConfig).mockReturnValue({ reranker: 'none', relevanceThreshold: 0 } as any);
  });

  it('boosts <7d by 1.5× when query has recency intent', async () => {
    const out = await rerankResults('latest pgEdge', [makeResult('Fresh', 0.5, 3)]);
    expect(out[0].relevance_score).toBeCloseTo(0.5 * 1.5, 5);
  });
  it('boosts <30d by 1.3× when query has recency intent', async () => {
    const out = await rerankResults('latest pgEdge', [makeResult('Recent', 0.5, 20)]);
    expect(out[0].relevance_score).toBeCloseTo(0.5 * 1.3, 5);
  });
  it('boosts <90d by 1.1× when query has recency intent', async () => {
    const out = await rerankResults('latest pgEdge', [makeResult('Older', 0.5, 60)]);
    expect(out[0].relevance_score).toBeCloseTo(0.5 * 1.1, 5);
  });
  it('does NOT boost when query has no recency intent', async () => {
    const out = await rerankResults('pgEdge architecture', [makeResult('Fresh', 0.5, 3)]);
    expect(out[0].relevance_score).toBe(0.5);
  });
  it('does NOT boost when published_date missing', async () => {
    const out = await rerankResults('latest pgEdge', [makeResult('NoDate', 0.5)]);
    expect(out[0].relevance_score).toBe(0.5);
  });
  it('does NOT boost when published_date invalid', async () => {
    const r: MergedSearchResult = {
      title: 'Bad', url: 'https://bad.com', snippet: '', relevance_score: 0.5,
      engines: ['a'], published_date: 'not-a-date',
    };
    const out = await rerankResults('latest pgEdge', [r]);
    expect(out[0].relevance_score).toBe(0.5);
  });
  it('boost applies AFTER cross-encoder scoring', async () => {
    vi.mocked(getConfig).mockReturnValue({ reranker: 'onnx', relevanceThreshold: 0 } as any);
    vi.mocked(onnxRerank).mockResolvedValue([{ index: 0, score: 0.8 }]);
    const out = await rerankResults('latest pgEdge', [makeResult('Fresh', 0.1, 3)]);
    expect(out[0].relevance_score).toBeCloseTo(0.8 * 1.5, 5);
  });
  it('boost applies BEFORE threshold filter', async () => {
    vi.mocked(getConfig).mockReturnValue({ reranker: 'none', relevanceThreshold: 0.7 } as any);
    const out = await rerankResults('latest pgEdge', [makeResult('Fresh', 0.5, 3)]);
    expect(out).toHaveLength(1);
    expect(out[0].relevance_score).toBeCloseTo(0.75, 5);
  });
});
