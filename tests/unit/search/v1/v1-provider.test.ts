import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../../src/search/v1/orchestrator.js', () => ({
  runV1Search: vi.fn(async () => ({
    results: [],
    enginesUsed: [],
    degraded: false,
  })),
}));

import { V1SearchProvider } from '../../../../src/search/v1/v1-provider.js';
import { runV1Search } from '../../../../src/search/v1/orchestrator.js';

const runV1SearchMock = vi.mocked(runV1Search);

const ctx = { router: undefined } as never;

describe('V1SearchProvider', () => {
  it('rejects category=images with explicit unsupported_category error', async () => {
    const provider = new V1SearchProvider();
    const result = await provider.search(
      { query: 'cats', category: 'images', max_results: 5 },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.error).toBe('unsupported_category');
      expect(result.error_reason).toMatch(/images vertical not supported in v1/);
      expect(result.stage).toBe('search');
    }
    expect(runV1SearchMock).not.toHaveBeenCalled();
  });

  it('passes other categories straight through to the orchestrator', async () => {
    runV1SearchMock.mockClear();
    runV1SearchMock.mockResolvedValueOnce({ results: [], enginesUsed: ['stub'], degraded: false });

    const provider = new V1SearchProvider();
    const result = await provider.search(
      { query: 'react server components', category: 'docs', max_results: 5 },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(runV1SearchMock).toHaveBeenCalledOnce();
    expect(runV1SearchMock.mock.calls[0][0].category).toBe('docs');
  });

  it('rejects an empty query before the images check', async () => {
    const provider = new V1SearchProvider();
    const result = await provider.search(
      { query: '   ', category: 'images', max_results: 5 },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      // Empty input takes precedence — we never reach the category check.
      expect(result.error).toBe('invalid_input');
    }
  });

  describe('array query dispatch', () => {
    it('dispatches each array element as a separate runV1Search call', async () => {
      runV1SearchMock.mockClear();
      runV1SearchMock.mockResolvedValue({
        results: [],
        enginesUsed: ['bing'],
        degraded: false,
      });

      const provider = new V1SearchProvider();
      const result = await provider.search(
        { query: ['hnsw tuning', 'ef_construction m', 'pgvector index'], max_results: 5 },
        ctx,
      );

      expect(result.ok).toBe(true);
      expect(runV1SearchMock).toHaveBeenCalledTimes(3);
      const dispatched = runV1SearchMock.mock.calls.map((c) => c[0].query).sort();
      expect(dispatched).toEqual(['ef_construction m', 'hnsw tuning', 'pgvector index']);
    });

    it('RRF-fuses results so URLs appearing in multiple lists rank above singletons', async () => {
      runV1SearchMock.mockClear();
      runV1SearchMock.mockImplementationOnce(async () => ({
        results: [
          { title: 'Shared', url: 'https://shared.example/a', snippet: 's', relevance_score: 0.9, engine: 'bing' },
          { title: 'Only-A', url: 'https://only-a.example', snippet: '', relevance_score: 0.8, engine: 'bing' },
        ],
        enginesUsed: ['bing'],
        degraded: false,
      }));
      runV1SearchMock.mockImplementationOnce(async () => ({
        results: [
          { title: 'Only-B', url: 'https://only-b.example', snippet: '', relevance_score: 0.95, engine: 'duckduckgo' },
          { title: 'Shared', url: 'https://shared.example/a', snippet: 's', relevance_score: 0.7, engine: 'duckduckgo' },
        ],
        enginesUsed: ['duckduckgo'],
        degraded: false,
      }));

      const provider = new V1SearchProvider();
      const result = await provider.search(
        { query: ['query one', 'query two'], max_results: 5 },
        ctx,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const urls = result.data.results.map((r) => r.url);
        // Shared appears in both lists → wins RRF over singletons.
        expect(urls[0]).toBe('https://shared.example/a');
        expect(urls).toContain('https://only-a.example');
        expect(urls).toContain('https://only-b.example');
        // Union of engines from both dispatches.
        expect(new Set(result.data.engines_used)).toEqual(new Set(['bing', 'duckduckgo']));
      }
    });

    it('dedupes and trims array entries before dispatch', async () => {
      runV1SearchMock.mockClear();
      runV1SearchMock.mockResolvedValue({
        results: [],
        enginesUsed: [],
        degraded: false,
      });

      const provider = new V1SearchProvider();
      const result = await provider.search(
        { query: ['  same  ', 'same', 'other', ''], max_results: 5 },
        ctx,
      );

      expect(result.ok).toBe(true);
      expect(runV1SearchMock).toHaveBeenCalledTimes(2);
      const dispatched = runV1SearchMock.mock.calls.map((c) => c[0].query).sort();
      expect(dispatched).toEqual(['other', 'same']);
    });

    it('rejects an array of only empty strings as invalid_input', async () => {
      runV1SearchMock.mockClear();
      const provider = new V1SearchProvider();
      const result = await provider.search(
        { query: ['  ', ''], max_results: 5 },
        ctx,
      );
      expect(result.ok).toBe(false);
      if (result.ok === false) {
        expect(result.error).toBe('invalid_input');
      }
      expect(runV1SearchMock).not.toHaveBeenCalled();
    });

    it('reports degraded only when all dispatches are degraded', async () => {
      runV1SearchMock.mockClear();
      runV1SearchMock.mockImplementationOnce(async () => ({
        results: [],
        enginesUsed: [],
        degraded: true,
      }));
      runV1SearchMock.mockImplementationOnce(async () => ({
        results: [
          { title: 'OK', url: 'https://ok.example', snippet: '', relevance_score: 0.5, engine: 'bing' },
        ],
        enginesUsed: ['bing'],
        degraded: false,
      }));

      const provider = new V1SearchProvider();
      const result = await provider.search(
        { query: ['q1', 'q2'], max_results: 5 },
        ctx,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.warning).toBeUndefined();
      }
    });
  });
});
