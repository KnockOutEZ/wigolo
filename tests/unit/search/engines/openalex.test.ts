import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpenAlexEngine } from '../../../../src/search/engines/openalex.js';

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function captureFetch(body: unknown, ok = true, status = 200): {
  calls: FetchCall[];
} {
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

function oaBody(works: Array<Record<string, unknown>>): Record<string, unknown> {
  return { results: works };
}

describe('OpenAlexEngine', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('has name set to openalex', () => {
    expect(new OpenAlexEngine().name).toBe('openalex');
  });

  it('maps a successful response into RawSearchResult fields', async () => {
    const body = oaBody([
      {
        id: 'https://openalex.org/W1',
        title: 'Attention Is All You Need',
        publication_date: '2017-06-12',
        publication_year: 2017,
        primary_location: { landing_page_url: 'https://doi.org/10.5555/x' },
        // "we propose the transformer" as an inverted index
        abstract_inverted_index: { we: [0], propose: [1], the: [2], transformer: [3] },
      },
    ]);
    captureFetch(body);
    const results = await new OpenAlexEngine().search('transformer');

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Attention Is All You Need');
    // landing_page_url is preferred over the openalex work id.
    expect(results[0].url).toBe('https://doi.org/10.5555/x');
    expect(results[0].snippet).toBe('we propose the transformer');
    expect(results[0].engine).toBe('openalex');
    expect(results[0].relevance_score).toBe(1);
    // publication_date is used verbatim when present.
    expect(results[0].published_date).toBe('2017-06-12');
  });

  // The inverted index maps each word to every position it occupies. The words
  // arrive in arbitrary key order and a word can repeat at several positions —
  // reconstruction must place them by position, not by key order.
  it('reconstructs an abstract from an out-of-order, repeated-word inverted index', async () => {
    const body = oaBody([
      {
        id: 'https://openalex.org/W2',
        title: 'Repeats',
        // "the cat sat on the mat" — "the" appears at 0 and 4, keys shuffled
        abstract_inverted_index: { mat: [5], the: [0, 4], on: [3], cat: [1], sat: [2] },
      },
    ]);
    captureFetch(body);
    const results = await new OpenAlexEngine().search('q');
    expect(results[0].snippet).toBe('the cat sat on the mat');
  });

  it('truncates the reconstructed abstract to the snippet limit', async () => {
    const index: Record<string, number[]> = {};
    // 60 distinct 5-char words → ~360 chars, above the 200-char cap.
    for (let i = 0; i < 60; i++) index[`word${String(i).padStart(2, '0')}`] = [i];
    const body = oaBody([{ id: 'https://openalex.org/W3', title: 'Long', abstract_inverted_index: index }]);
    captureFetch(body);
    const results = await new OpenAlexEngine().search('q');
    expect(results[0].snippet.length).toBe(200);
  });

  it('yields an empty snippet when the abstract index is absent', async () => {
    const body = oaBody([{ id: 'https://openalex.org/W4', title: 'No abstract' }]);
    captureFetch(body);
    const results = await new OpenAlexEngine().search('q');
    expect(results[0].snippet).toBe('');
  });

  // A record with no publisher landing page still resolves via the OpenAlex
  // work URL rather than being dropped.
  it('falls back to the work id url when landing_page_url is absent', async () => {
    const body = oaBody([
      { id: 'https://openalex.org/W5', title: 'Fallback', primary_location: {} },
    ]);
    captureFetch(body);
    const results = await new OpenAlexEngine().search('q');
    expect(results[0].url).toBe('https://openalex.org/W5');
  });

  it('derives published_date from the year when publication_date is absent', async () => {
    const body = oaBody([
      { id: 'https://openalex.org/W6', title: 'Year only', publication_year: 2020 },
    ]);
    captureFetch(body);
    const results = await new OpenAlexEngine().search('q');
    expect(results[0].published_date).toBe('2020-01-01T00:00:00.000Z');
  });

  it('skips a work with no title', async () => {
    const body = oaBody([
      { id: 'https://openalex.org/W7' },
      { id: 'https://openalex.org/W8', title: 'real' },
    ]);
    captureFetch(body);
    const results = await new OpenAlexEngine().search('q');
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('real');
  });

  it('skips a work with neither landing page nor id', async () => {
    const body = oaBody([
      { title: 'linkless' },
      { id: 'https://openalex.org/W9', title: 'keeper' },
    ]);
    captureFetch(body);
    const results = await new OpenAlexEngine().search('q');
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('keeper');
  });

  it('returns empty array when results are empty', async () => {
    captureFetch(oaBody([]));
    expect(await new OpenAlexEngine().search('q')).toEqual([]);
  });

  it('returns empty array when the results key is missing', async () => {
    captureFetch({});
    expect(await new OpenAlexEngine().search('q')).toEqual([]);
  });

  it('throws on non-ok responses', async () => {
    captureFetch({}, false, 429);
    await expect(new OpenAlexEngine().search('q')).rejects.toThrow(/OpenAlex returned 429/);
  });

  it('throws on malformed JSON', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async () => {
      return {
        ok: true,
        status: 200,
        json: async () => {
          throw new Error('invalid json');
        },
      } as unknown as Response;
    });
    await expect(new OpenAlexEngine().search('q')).rejects.toThrow(/invalid json/);
  });

  it('passes AbortSignal.timeout to fetch', async () => {
    const { calls } = captureFetch(oaBody([]));
    await new OpenAlexEngine().search('q', { timeoutMs: 5000 });
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('encodes search, per_page and mailto into the request', async () => {
    const { calls } = captureFetch(oaBody([]));
    await new OpenAlexEngine().search('graph neural', { maxResults: 15 });
    expect(calls[0].url).toContain('search=graph+neural');
    expect(calls[0].url).toContain('per_page=15');
    expect(calls[0].url).toContain('mailto=');
  });
});
