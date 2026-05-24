import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../../src/search/v1/orchestrator.js', () => ({
  runV1Search: vi.fn(async () => ({
    results: [],
    enginesUsed: [],
    degraded: false,
  })),
}));

vi.mock('../../../../src/search/answer-synthesis.js', () => ({
  runSynthesis: vi.fn(async () => ({
    ok: true as const,
    data: {
      answer: 'mocked answer',
      citations: [{ index: 1, url: 'https://x.example', title: 'x', snippet: '' }],
      fallback_level: 1 as const,
    },
  })),
}));

import { V1SearchProvider } from '../../../../src/search/v1/v1-provider.js';
import { runV1Search } from '../../../../src/search/v1/orchestrator.js';
import { runSynthesis } from '../../../../src/search/answer-synthesis.js';

const runV1SearchMock = vi.mocked(runV1Search);
const runSynthesisMock = vi.mocked(runSynthesis);

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

    it('does not invoke runSynthesis when format is unset', async () => {
      runV1SearchMock.mockClear();
      runSynthesisMock.mockClear();
      runV1SearchMock.mockResolvedValue({
        results: [{ title: 't', url: 'https://x', snippet: 's', relevance_score: 1, engine: 'b' }],
        enginesUsed: ['b'],
        degraded: false,
      });

      const provider = new V1SearchProvider();
      const result = await provider.search({ query: 'cats', max_results: 5 }, ctx);

      expect(result.ok).toBe(true);
      expect(runSynthesisMock).not.toHaveBeenCalled();
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

  describe('citation_format wiring', () => {
    it('does not emit citations when citation_format is unset', async () => {
      runV1SearchMock.mockClear();
      runV1SearchMock.mockResolvedValue({
        results: [
          { title: 'A', url: 'https://a.example', snippet: 'first', relevance_score: 1, engine: 'b' },
        ],
        enginesUsed: ['b'],
        degraded: false,
      });

      const provider = new V1SearchProvider();
      const result = await provider.search({ query: 'q', max_results: 5 }, ctx);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.citations).toBeUndefined();
        expect(result.data.citations_xml).toBeUndefined();
      }
    });

    it('emits citations array for citation_format="numbered"', async () => {
      runV1SearchMock.mockClear();
      runV1SearchMock.mockResolvedValue({
        results: [
          { title: 'A', url: 'https://a.example', snippet: 'sa', relevance_score: 1, engine: 'b' },
          { title: 'B', url: 'https://b.example', snippet: 'sb', relevance_score: 0.5, engine: 'b' },
        ],
        enginesUsed: ['b'],
        degraded: false,
      });

      const provider = new V1SearchProvider();
      const result = await provider.search(
        { query: 'q', citation_format: 'numbered', max_results: 5 },
        ctx,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.citations).toEqual([
          { index: 1, url: 'https://a.example', title: 'A', snippet: 'sa' },
          { index: 2, url: 'https://b.example', title: 'B', snippet: 'sb' },
        ]);
        expect(result.data.citations_xml).toBeUndefined();
      }
    });

    it('emits citations + citations_xml for citation_format="anthropic_tags"', async () => {
      runV1SearchMock.mockClear();
      runV1SearchMock.mockResolvedValue({
        results: [
          { title: 'A', url: 'https://a.example', snippet: 'sa', relevance_score: 1, engine: 'b' },
        ],
        enginesUsed: ['b'],
        degraded: false,
      });

      const provider = new V1SearchProvider();
      const result = await provider.search(
        { query: 'q', citation_format: 'anthropic_tags', max_results: 5 },
        ctx,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.citations).toHaveLength(1);
        expect(result.data.citations_xml).toContain('<source');
        expect(result.data.citations_xml).toContain('https://a.example');
      }
    });

    it('emits citations array unchanged for citation_format="json"', async () => {
      runV1SearchMock.mockClear();
      runV1SearchMock.mockResolvedValue({
        results: [
          { title: 'A', url: 'https://a.example', snippet: 'sa', relevance_score: 1, engine: 'b' },
        ],
        enginesUsed: ['b'],
        degraded: false,
      });

      const provider = new V1SearchProvider();
      const result = await provider.search(
        { query: 'q', citation_format: 'json', max_results: 5 },
        ctx,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(Array.isArray(result.data.citations)).toBe(true);
        expect(result.data.citations_xml).toBeUndefined();
      }
    });

    it('renders citations_xml from synth citations when format=answer + citation_format=anthropic_tags', async () => {
      runV1SearchMock.mockClear();
      runSynthesisMock.mockClear();
      runV1SearchMock.mockResolvedValue({
        results: [
          { title: 'A', url: 'https://a.example', snippet: 'sa', relevance_score: 1, engine: 'b' },
        ],
        enginesUsed: ['b'],
        degraded: false,
      });
      runSynthesisMock.mockResolvedValue({
        ok: true,
        data: {
          answer: 'A says X [1].',
          citations: [{ index: 1, url: 'https://a.example', title: 'A', snippet: 'sa' }],
          fallback_level: 1,
        },
      });

      const provider = new V1SearchProvider();
      const result = await provider.search(
        { query: 'q', format: 'answer', citation_format: 'anthropic_tags', max_results: 5 },
        ctx,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.citations).toHaveLength(1);
        expect(result.data.citations_xml).toContain('<source');
      }
    });
  });

  describe('format=answer wiring', () => {
    it('calls runSynthesis when format is "answer" and populates answer + citations', async () => {
      runV1SearchMock.mockClear();
      runSynthesisMock.mockClear();
      runV1SearchMock.mockResolvedValue({
        results: [
          { title: 'A', url: 'https://a.example', snippet: 'first', relevance_score: 1, engine: 'b' },
          { title: 'B', url: 'https://b.example', snippet: 'second', relevance_score: 0.5, engine: 'b' },
        ],
        enginesUsed: ['b'],
        degraded: false,
      });
      runSynthesisMock.mockResolvedValue({
        ok: true,
        data: {
          answer: 'A answer with [1] and [2].',
          citations: [
            { index: 1, url: 'https://a.example', title: 'A', snippet: 'first' },
            { index: 2, url: 'https://b.example', title: 'B', snippet: 'second' },
          ],
          fallback_level: 1,
        },
      });

      const provider = new V1SearchProvider();
      const result = await provider.search(
        { query: 'why sky blue', format: 'answer', max_results: 5 },
        ctx,
      );

      expect(runSynthesisMock).toHaveBeenCalledOnce();
      const synthCall = runSynthesisMock.mock.calls[0][0];
      expect(synthCall.query).toBe('why sky blue');
      expect(synthCall.results).toHaveLength(2);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.answer).toBe('A answer with [1] and [2].');
        expect(result.data.citations).toHaveLength(2);
        expect(result.data.streaming).toBeUndefined();
      }
    });

    it('sets streaming=true for format="stream_answer"', async () => {
      runV1SearchMock.mockClear();
      runSynthesisMock.mockClear();
      runV1SearchMock.mockResolvedValue({
        results: [
          { title: 't', url: 'https://x', snippet: 's', relevance_score: 1, engine: 'b' },
        ],
        enginesUsed: ['b'],
        degraded: false,
      });
      runSynthesisMock.mockResolvedValue({
        ok: true,
        data: { answer: 'streamed', citations: [], fallback_level: 1 },
      });

      const provider = new V1SearchProvider();
      const result = await provider.search(
        { query: 'q', format: 'stream_answer', max_results: 5 },
        ctx,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.streaming).toBe(true);
        expect(result.data.answer).toBe('streamed');
      }
    });

    it('passes through samplingServer from SearchContext to runSynthesis', async () => {
      runV1SearchMock.mockClear();
      runSynthesisMock.mockClear();
      runV1SearchMock.mockResolvedValue({
        results: [{ title: 't', url: 'https://x', snippet: 's', relevance_score: 1, engine: 'b' }],
        enginesUsed: ['b'],
        degraded: false,
      });
      runSynthesisMock.mockResolvedValue({
        ok: true,
        data: { answer: 'ok', citations: [], fallback_level: 1 },
      });

      const samplingServer = { capabilities: {} } as never;
      const provider = new V1SearchProvider();
      await provider.search(
        { query: 'q', format: 'answer', max_results: 5 },
        { router: undefined, samplingServer } as never,
      );

      expect(runSynthesisMock.mock.calls[0][0].samplingServer).toBe(samplingServer);
    });

    it('surfaces synthesis warning into SearchOutput when synthesis fell back', async () => {
      runV1SearchMock.mockClear();
      runSynthesisMock.mockClear();
      runV1SearchMock.mockResolvedValue({
        results: [{ title: 't', url: 'https://x', snippet: 's', relevance_score: 1, engine: 'b' }],
        enginesUsed: ['b'],
        degraded: false,
      });
      runSynthesisMock.mockResolvedValue({
        ok: true,
        data: { answer: 'fallback', citations: [], warning: 'fallback used', fallback_level: 2 },
      });

      const provider = new V1SearchProvider();
      const result = await provider.search(
        { query: 'q', format: 'answer', max_results: 5 },
        ctx,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.warning).toBe('fallback used');
      }
    });

    it('keeps search ok when synthesis returns error — surfaces warning only', async () => {
      runV1SearchMock.mockClear();
      runSynthesisMock.mockClear();
      runV1SearchMock.mockResolvedValue({
        results: [{ title: 't', url: 'https://x', snippet: 's', relevance_score: 1, engine: 'b' }],
        enginesUsed: ['b'],
        degraded: false,
      });
      runSynthesisMock.mockResolvedValue({
        ok: false,
        error: 'no_content',
        error_reason: 'no content',
        stage: 'synthesize',
      });

      const provider = new V1SearchProvider();
      const result = await provider.search(
        { query: 'q', format: 'answer', max_results: 5 },
        ctx,
      );

      // Search itself succeeds even if synth failed.
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.answer).toBeUndefined();
        expect(result.data.warning).toMatch(/synthesis/i);
      }
    });
  });
});
