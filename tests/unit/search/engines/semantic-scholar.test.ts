import { describe, it, expect, vi, afterEach } from 'vitest';
import { SemanticScholarEngine } from '../../../../src/search/engines/semantic-scholar.js';

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function captureFetch(body: unknown, ok = true, status = 200): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  vi.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    calls.push({ url, init });
    return {
      ok,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response;
  });
  return { calls };
}

describe('SemanticScholarEngine', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('has name set to semantic-scholar', () => {
    expect(new SemanticScholarEngine().name).toBe('semantic-scholar');
  });

  it('maps a successful response and prefers openAccessPdf URL when present', async () => {
    const body = {
      data: [
        {
          paperId: 'abc',
          title: 'Attention Is All You Need',
          abstract: 'We propose a new architecture.',
          year: 2017,
          url: 'https://www.semanticscholar.org/paper/abc',
          openAccessPdf: { url: 'https://arxiv.org/pdf/1706.03762.pdf' },
        },
        {
          paperId: 'def',
          title: 'No PDF Paper',
          abstract: 'Some abstract.',
          year: 2020,
          url: 'https://www.semanticscholar.org/paper/def',
        },
      ],
    };
    captureFetch(body);
    const results = await new SemanticScholarEngine().search('attention');

    expect(results).toHaveLength(2);
    expect(results[0].title).toBe('Attention Is All You Need');
    expect(results[0].url).toBe('https://arxiv.org/pdf/1706.03762.pdf');
    expect(results[0].snippet).toBe('We propose a new architecture.');
    expect(results[0].engine).toBe('semantic-scholar');
    expect(results[0].relevance_score).toBe(1);
    expect(results[0].published_date).toBe('2017-01-01T00:00:00.000Z');
    expect(results[1].url).toBe('https://www.semanticscholar.org/paper/def');
  });

  it('formats year-based date filter as year=START-END', async () => {
    const { calls } = captureFetch({ data: [] });
    await new SemanticScholarEngine().search('q', {
      fromDate: '2020-03-05T00:00:00Z',
      toDate: '2024-08-01T00:00:00Z',
    });
    expect(calls[0].url).toContain('year=2020-2024');
  });

  it('formats year filter with only fromDate', async () => {
    const { calls } = captureFetch({ data: [] });
    await new SemanticScholarEngine().search('q', { fromDate: '2021-01-01T00:00:00Z' });
    expect(calls[0].url).toContain('year=2021-');
  });

  it('formats year filter with only toDate', async () => {
    const { calls } = captureFetch({ data: [] });
    await new SemanticScholarEngine().search('q', { toDate: '2022-12-31T00:00:00Z' });
    expect(calls[0].url).toContain('year=-2022');
  });

  it('returns empty array on empty data', async () => {
    captureFetch({ data: [] });
    expect(await new SemanticScholarEngine().search('q')).toEqual([]);
  });

  it('throws when HTTP response is not ok', async () => {
    captureFetch({}, false, 503);
    await expect(new SemanticScholarEngine().search('q')).rejects.toThrow(/Semantic Scholar returned 503/);
  });

  it('truncates long abstracts to ~200 chars', async () => {
    const body = {
      data: [
        {
          paperId: 'long',
          title: 'Long',
          abstract: 'x'.repeat(500),
          year: 2024,
          url: 'https://www.semanticscholar.org/paper/long',
        },
      ],
    };
    captureFetch(body);
    const results = await new SemanticScholarEngine().search('q');
    expect(results[0].snippet.length).toBeLessThanOrEqual(200);
  });

  it('omits published_date when year missing', async () => {
    const body = {
      data: [
        {
          paperId: 'noyr',
          title: 'no year',
          abstract: '',
          url: 'https://www.semanticscholar.org/paper/noyr',
        },
      ],
    };
    captureFetch(body);
    const results = await new SemanticScholarEngine().search('q');
    expect(results[0].published_date).toBeUndefined();
  });

  it('encodes limit from maxResults', async () => {
    const { calls } = captureFetch({ data: [] });
    await new SemanticScholarEngine().search('q', { maxResults: 6 });
    expect(calls[0].url).toContain('limit=6');
  });

  it('passes AbortSignal to fetch', async () => {
    const { calls } = captureFetch({ data: [] });
    await new SemanticScholarEngine().search('q');
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
  });
});
