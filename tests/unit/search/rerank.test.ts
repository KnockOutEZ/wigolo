import { describe, it, expect, vi, beforeEach } from 'vitest';
import { rerankResults } from '../../../src/search/rerank.js';
import type { MergedSearchResult } from '../../../src/search/dedup.js';
import type { RerankProvider, RerankResult } from '../../../src/providers/rerank-provider.js';

const rerankMock = vi.fn();
vi.mock('../../../src/providers/rerank-provider.js', () => ({
  getRerankProvider: vi.fn(async (): Promise<RerankProvider> => ({
    modelId: 'mock',
    rerank: rerankMock,
  })),
}));
vi.mock('../../../src/config.js', () => ({ getConfig: vi.fn() }));
vi.mock('../../../src/logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { getConfig } from '../../../src/config.js';
import type { Config } from '../../../src/config.js';

const makeResult = (title: string, score: number): MergedSearchResult => ({
  title,
  url: `https://${title.toLowerCase().replace(/\s+/g, '-')}.com`,
  snippet: `Snippet about ${title}`,
  relevance_score: score,
  engines: ['test'],
});

const cfg = (over: Partial<Config>): Config =>
  ({ reranker: 'onnx', relevanceThreshold: 0, ...over }) as Config;

// Helper to score by string id (numeric index of the candidate)
const scored = (entries: Array<[number, number]>): RerankResult[] =>
  entries.map(([i, score]) => ({ id: String(i), score }));

describe('rerankResults with provider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rerankMock.mockReset();
  });

  it('uses provider when configured and reorders', async () => {
    vi.mocked(getConfig).mockReturnValue(cfg({}));
    rerankMock.mockResolvedValue(scored([[2, 0.98], [0, 0.75], [1, 0.42]]));
    const out = await rerankResults('q', [makeResult('A', 0.9), makeResult('B', 0.5), makeResult('C', 0.3)]);
    expect(out.map((r) => r.title)).toEqual(['C', 'A', 'B']);
    expect(out[0].relevance_score).toBe(0.98);
  });

  it('falls back to passthrough on provider error', async () => {
    vi.mocked(getConfig).mockReturnValue(cfg({}));
    rerankMock.mockRejectedValue(new Error('boom'));
    const out = await rerankResults('q', [makeResult('A', 0.9), makeResult('B', 0.5)]);
    expect(out.map((r) => r.title)).toEqual(['A', 'B']);
  });

  it('threshold filters after scoring', async () => {
    vi.mocked(getConfig).mockReturnValue(cfg({ relevanceThreshold: 0.5 }));
    rerankMock.mockResolvedValue(scored([[0, 0.9], [1, 0.3]]));
    const out = await rerankResults('q', [makeResult('A', 0.9), makeResult('B', 0.5)]);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('A');
  });

  it('passthrough when reranker=none', async () => {
    vi.mocked(getConfig).mockReturnValue(cfg({ reranker: 'none' }));
    const out = await rerankResults('q', [makeResult('A', 0.9), makeResult('B', 0.5)]);
    expect(out.map((r) => r.title)).toEqual(['A', 'B']);
    expect(rerankMock).not.toHaveBeenCalled();
  });

  it('passthrough when reranker=custom (future-proofing)', async () => {
    vi.mocked(getConfig).mockReturnValue(cfg({ reranker: 'custom' as Config['reranker'] }));
    const out = await rerankResults('q', [makeResult('A', 0.9)]);
    expect(out.map((r) => r.title)).toEqual(['A']);
    expect(rerankMock).not.toHaveBeenCalled();
  });

  it('handles empty results without calling provider', async () => {
    vi.mocked(getConfig).mockReturnValue(cfg({}));
    expect(await rerankResults('q', [])).toEqual([]);
    expect(rerankMock).not.toHaveBeenCalled();
  });

  it('preserves all fields after rerank', async () => {
    vi.mocked(getConfig).mockReturnValue(cfg({}));
    rerankMock.mockResolvedValue(scored([[0, 0.88]]));
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

  it('passes the query and {id,text} candidates to the provider, with domain context', async () => {
    vi.mocked(getConfig).mockReturnValue(cfg({ rerankerModel: 'minilm-l12' }));
    rerankMock.mockResolvedValue(scored([[0, 0.8]]));
    await rerankResults('q', [makeResult('A', 0.5)]);
    // Domain is appended so a short snippet cannot game the reranker.
    expect(rerankMock).toHaveBeenCalledWith(
      'q',
      [{ id: '0', text: 'A\nSnippet about A\na.com' }],
    );
  });

  it('threshold 0.0 does no filtering', async () => {
    vi.mocked(getConfig).mockReturnValue(cfg({}));
    rerankMock.mockResolvedValue(scored([[0, 0.01], [1, 0.001]]));
    const out = await rerankResults('q', [makeResult('Low', 0.1), makeResult('Lower', 0.05)]);
    expect(out).toHaveLength(2);
  });

  it('applies threshold even in passthrough mode (no reranker)', async () => {
    vi.mocked(getConfig).mockReturnValue(cfg({ reranker: 'none', relevanceThreshold: 0.6 }));
    const out = await rerankResults('q', [makeResult('High', 0.9), makeResult('Low', 0.3)]);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('High');
  });
});

describe('rerankResults cross-slice ordering (with provider)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rerankMock.mockReset();
  });

  it('reranking happens BEFORE recency boost in the pipeline', async () => {
    vi.mocked(getConfig).mockReturnValue(cfg({}));
    rerankMock.mockResolvedValue(scored([[2, 0.99], [0, 0.80], [1, 0.60]]));
    const results: MergedSearchResult[] = [
      { title: 'Doc A', url: 'https://a.com', snippet: 's', relevance_score: 0.9, engines: ['t'] },
      { title: 'Doc B', url: 'https://b.com', snippet: 's', relevance_score: 0.7, engines: ['t'] },
      { title: 'Doc C', url: 'https://c.com', snippet: 's', relevance_score: 0.5, engines: ['t'] },
    ];
    const out = await rerankResults('typescript generics', results);
    expect(out[0].title).toBe('Doc C');
    expect(out[0].relevance_score).toBe(0.99);
    expect(out).toHaveLength(3);
  });
});
