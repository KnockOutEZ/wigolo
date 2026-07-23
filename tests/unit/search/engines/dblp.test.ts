import { describe, it, expect, vi, afterEach } from 'vitest';
import { DblpEngine } from '../../../../src/search/engines/dblp.js';

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

/** Wrap hit `info` objects in the nested result.hits.hit envelope DBLP returns. */
function dblpBody(infos: Array<Record<string, unknown>>): Record<string, unknown> {
  return { result: { hits: { hit: infos.map((info) => ({ info })) } } };
}

describe('DblpEngine', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('has name set to dblp', () => {
    expect(new DblpEngine().name).toBe('dblp');
  });

  it('maps a successful response into RawSearchResult fields', async () => {
    const body = dblpBody([
      {
        authors: { author: [{ text: 'Ashish Vaswani' }, { text: 'Noam Shazeer' }] },
        title: 'Attention Is All You Need',
        venue: 'NeurIPS',
        year: '2017',
        ee: 'https://doi.org/10.5555/3295222.3295349',
        url: 'https://dblp.org/rec/conf/nips/VaswaniSPUJGKP17',
      },
      {
        authors: { author: [{ text: 'Jacob Devlin' }] },
        title: 'BERT: Pre-training of Deep Bidirectional Transformers',
        venue: 'NAACL-HLT',
        year: '2019',
        ee: 'https://doi.org/10.18653/v1/n19-1423',
      },
    ]);
    captureFetch(body);
    const results = await new DblpEngine().search('transformer');

    expect(results).toHaveLength(2);
    expect(results[0].title).toBe('Attention Is All You Need');
    // ee is preferred over the dblp record url.
    expect(results[0].url).toBe('https://doi.org/10.5555/3295222.3295349');
    // Snippet is assembled from the text-bearing fields DBLP returns — authors,
    // then venue + year — since it carries no abstract.
    expect(results[0].snippet).toBe('Ashish Vaswani, Noam Shazeer — NeurIPS 2017');
    expect(results[0].engine).toBe('dblp');
    expect(results[0].relevance_score).toBe(1);
    expect(results[0].published_date).toBe('2017-01-01T00:00:00.000Z');
  });

  // ee is the paper's publisher/DOI link; url is the DBLP record page. When ee
  // is absent the record page is the only usable link.
  it('falls back to the dblp record url when ee is absent', async () => {
    const body = dblpBody([
      { title: 'A paper', venue: 'ICML', year: '2020', url: 'https://dblp.org/rec/x' },
    ]);
    captureFetch(body);
    const results = await new DblpEngine().search('q');
    expect(results[0].url).toBe('https://dblp.org/rec/x');
  });

  it('skips a hit with neither ee nor url', async () => {
    const body = dblpBody([
      { title: 'linkless', venue: 'ICML', year: '2020' },
      { title: 'keeper', venue: 'ICML', year: '2020', url: 'https://dblp.org/rec/y' },
    ]);
    captureFetch(body);
    const results = await new DblpEngine().search('q');
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('keeper');
  });

  it('skips a hit with no title', async () => {
    const body = dblpBody([
      { venue: 'ICML', year: '2020', url: 'https://dblp.org/rec/z' },
      { title: 'real', url: 'https://dblp.org/rec/w' },
    ]);
    captureFetch(body);
    const results = await new DblpEngine().search('q');
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('real');
  });

  it('builds a venue-only snippet when authors and year are missing', async () => {
    const body = dblpBody([{ title: 't', venue: 'ICML', url: 'https://dblp.org/rec/a' }]);
    captureFetch(body);
    const results = await new DblpEngine().search('q');
    expect(results[0].snippet).toBe('ICML');
  });

  // DBLP returns a single-author paper's author as a bare object, not an array.
  // The parser must handle both without crashing.
  it('handles the single-author object shape', async () => {
    const body = dblpBody([
      {
        authors: { author: { text: 'Donald E. Knuth' } },
        title: 'Literate Programming',
        venue: 'Comput. J.',
        year: '1984',
        url: 'https://dblp.org/rec/x',
      },
    ]);
    captureFetch(body);
    const results = await new DblpEngine().search('q');
    expect(results[0].snippet).toBe('Donald E. Knuth — Comput. J. 1984');
  });

  it('caps the byline at three authors with an et al. marker', async () => {
    const body = dblpBody([
      {
        authors: {
          author: [
            { text: 'A One' },
            { text: 'B Two' },
            { text: 'C Three' },
            { text: 'D Four' },
          ],
        },
        title: 'Many hands',
        venue: 'ICML',
        year: '2020',
        url: 'https://dblp.org/rec/y',
      },
    ]);
    captureFetch(body);
    const results = await new DblpEngine().search('q');
    expect(results[0].snippet).toBe('A One, B Two, C Three et al. — ICML 2020');
  });

  it('omits published_date when year is not a 4-digit value', async () => {
    const body = dblpBody([
      { title: 't', venue: 'ICML', year: 'n/a', url: 'https://dblp.org/rec/a' },
    ]);
    captureFetch(body);
    const results = await new DblpEngine().search('q');
    expect(results[0].published_date).toBeUndefined();
  });

  it('returns empty array when there are no hits', async () => {
    captureFetch(dblpBody([]));
    expect(await new DblpEngine().search('q')).toEqual([]);
  });

  it('returns empty array when the result envelope is missing', async () => {
    captureFetch({});
    expect(await new DblpEngine().search('q')).toEqual([]);
  });

  it('throws on non-ok responses', async () => {
    captureFetch({}, false, 500);
    await expect(new DblpEngine().search('q')).rejects.toThrow(/DBLP returned 500/);
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
    await expect(new DblpEngine().search('q')).rejects.toThrow(/invalid json/);
  });

  it('passes AbortSignal.timeout to fetch', async () => {
    const { calls } = captureFetch(dblpBody([]));
    await new DblpEngine().search('q', { timeoutMs: 5000 });
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('encodes q, format and h from the query and maxResults', async () => {
    const { calls } = captureFetch(dblpBody([]));
    await new DblpEngine().search('graph neural', { maxResults: 15 });
    expect(calls[0].url).toContain('q=graph+neural');
    expect(calls[0].url).toContain('format=json');
    expect(calls[0].url).toContain('h=15');
  });
});
