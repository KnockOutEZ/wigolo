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

const makeResult = (title: string, score: number): MergedSearchResult => ({
  title,
  url: `https://${title.toLowerCase().replace(/\s+/g, '-')}.com`,
  snippet: `Snippet about ${title}`,
  relevance_score: score,
  engines: ['test'],
});

describe('rerankResults with ONNX', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses ONNX when configured and reorders', async () => {
    vi.mocked(getConfig).mockReturnValue({ reranker: 'onnx', relevanceThreshold: 0 } as any);
    vi.mocked(onnxRerank).mockResolvedValue([
      { index: 2, score: 0.98 },
      { index: 0, score: 0.75 },
      { index: 1, score: 0.42 },
    ]);
    const out = await rerankResults('q', [makeResult('A', 0.9), makeResult('B', 0.5), makeResult('C', 0.3)]);
    expect(out.map((r) => r.title)).toEqual(['C', 'A', 'B']);
    expect(out[0].relevance_score).toBe(0.98);
  });

  it('falls back to passthrough on ONNX error', async () => {
    vi.mocked(getConfig).mockReturnValue({ reranker: 'onnx', relevanceThreshold: 0 } as any);
    vi.mocked(onnxRerank).mockRejectedValue(new Error('boom'));
    const out = await rerankResults('q', [makeResult('A', 0.9), makeResult('B', 0.5)]);
    expect(out.map((r) => r.title)).toEqual(['A', 'B']);
  });

  it('threshold filters after ONNX scoring', async () => {
    vi.mocked(getConfig).mockReturnValue({ reranker: 'onnx', relevanceThreshold: 0.5 } as any);
    vi.mocked(onnxRerank).mockResolvedValue([
      { index: 0, score: 0.9 },
      { index: 1, score: 0.3 },
    ]);
    const out = await rerankResults('q', [makeResult('A', 0.9), makeResult('B', 0.5)]);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('A');
  });

  it('passthrough when reranker=none', async () => {
    vi.mocked(getConfig).mockReturnValue({ reranker: 'none', relevanceThreshold: 0 } as any);
    const out = await rerankResults('q', [makeResult('A', 0.9), makeResult('B', 0.5)]);
    expect(out.map((r) => r.title)).toEqual(['A', 'B']);
    expect(onnxRerank).not.toHaveBeenCalled();
  });

  it('passthrough when reranker=custom (future-proofing)', async () => {
    vi.mocked(getConfig).mockReturnValue({ reranker: 'custom', relevanceThreshold: 0 } as any);
    const out = await rerankResults('q', [makeResult('A', 0.9)]);
    expect(out.map((r) => r.title)).toEqual(['A']);
    expect(onnxRerank).not.toHaveBeenCalled();
  });

  it('handles empty results without calling ONNX', async () => {
    vi.mocked(getConfig).mockReturnValue({ reranker: 'onnx', relevanceThreshold: 0 } as any);
    expect(await rerankResults('q', [])).toEqual([]);
    expect(onnxRerank).not.toHaveBeenCalled();
  });

  it('preserves all fields after rerank', async () => {
    vi.mocked(getConfig).mockReturnValue({ reranker: 'onnx', relevanceThreshold: 0 } as any);
    vi.mocked(onnxRerank).mockResolvedValue([{ index: 0, score: 0.88 }]);
    const r: MergedSearchResult = {
      title: 'X',
      url: 'https://x.com',
      snippet: 'snip',
      relevance_score: 0.5,
      engines: ['searxng'],
    };
    const out = await rerankResults('q', [r]);
    expect(out[0].engines).toEqual(['searxng']);
    expect(out[0].url).toBe('https://x.com');
    expect(out[0].snippet).toBe('snip');
    expect(out[0].relevance_score).toBe(0.88);
  });

  it('passes configured rerankerModel to ONNX', async () => {
    vi.mocked(getConfig).mockReturnValue({
      reranker: 'onnx',
      relevanceThreshold: 0,
      rerankerModel: 'minilm-l12',
    } as any);
    vi.mocked(onnxRerank).mockResolvedValue([{ index: 0, score: 0.8 }]);
    await rerankResults('q', [makeResult('A', 0.5)]);
    expect(onnxRerank).toHaveBeenCalledWith(
      'q',
      expect.any(Array),
      expect.objectContaining({ modelId: 'minilm-l12' }),
    );
  });

  it('threshold 0.0 does no filtering', async () => {
    vi.mocked(getConfig).mockReturnValue({ reranker: 'onnx', relevanceThreshold: 0 } as any);
    vi.mocked(onnxRerank).mockResolvedValue([
      { index: 0, score: 0.01 },
      { index: 1, score: 0.001 },
    ]);
    const out = await rerankResults('q', [makeResult('Low', 0.1), makeResult('Lower', 0.05)]);
    expect(out).toHaveLength(2);
  });

  it('applies threshold even in passthrough mode (no reranker)', async () => {
    vi.mocked(getConfig).mockReturnValue({ reranker: 'none', relevanceThreshold: 0.6 } as any);
    const out = await rerankResults('q', [makeResult('High', 0.9), makeResult('Low', 0.3)]);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('High');
  });
});

describe('rerankResults cross-slice ordering (with ONNX)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reranking happens BEFORE recency boost in the pipeline', async () => {
    vi.mocked(getConfig).mockReturnValue({ reranker: 'onnx', relevanceThreshold: 0 } as any);
    vi.mocked(onnxRerank).mockResolvedValue([
      { index: 2, score: 0.99 },
      { index: 0, score: 0.80 },
      { index: 1, score: 0.60 },
    ]);
    const results = [
      { title: 'Doc A', url: 'https://a.com', snippet: 's', relevance_score: 0.9, engines: ['t'] } as MergedSearchResult,
      { title: 'Doc B', url: 'https://b.com', snippet: 's', relevance_score: 0.7, engines: ['t'] } as MergedSearchResult,
      { title: 'Doc C', url: 'https://c.com', snippet: 's', relevance_score: 0.5, engines: ['t'] } as MergedSearchResult,
    ];
    const out = await rerankResults('typescript generics', results);
    expect(out[0].title).toBe('Doc C');
    expect(out[0].relevance_score).toBe(0.99);
    expect(out).toHaveLength(3);
  });
});
