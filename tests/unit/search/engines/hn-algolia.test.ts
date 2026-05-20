import { describe, it, expect, vi, afterEach } from 'vitest';
import { HnAlgoliaEngine } from '../../../../src/search/engines/hn-algolia.js';

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function captureFetch(body: unknown, ok = true, status = 200): {
  calls: FetchCall[];
  restore: () => void;
} {
  const calls: FetchCall[] = [];
  const spy = vi.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    return {
      ok,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response;
  });
  return { calls, restore: () => spy.mockRestore() };
}

describe('HnAlgoliaEngine', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('has name set to hn-algolia', () => {
    expect(new HnAlgoliaEngine().name).toBe('hn-algolia');
  });

  it('maps a successful response to RawSearchResult fields', async () => {
    const body = {
      hits: [
        {
          objectID: '37245102',
          title: 'Why Rust',
          url: 'https://example.com/rust',
          story_text: null,
          points: 100,
          num_comments: 50,
          created_at_i: 1693000000,
        },
      ],
    };
    captureFetch(body);
    const engine = new HnAlgoliaEngine();
    const results = await engine.search('rust');

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Why Rust');
    expect(results[0].url).toBe('https://example.com/rust');
    expect(results[0].engine).toBe('hn-algolia');
    expect(results[0].snippet).toBe('100 points · 50 comments');
    expect(results[0].relevance_score).toBe(1);
    expect(results[0].published_date).toBe(new Date(1693000000 * 1000).toISOString());
  });

  it('falls back to HN item URL when hit.url is null', async () => {
    const body = {
      hits: [
        {
          objectID: '42',
          title: 'Ask HN: foo',
          url: null,
          story_text: null,
          points: 5,
          num_comments: 3,
          created_at_i: 1700000000,
        },
      ],
    };
    captureFetch(body);
    const results = await new HnAlgoliaEngine().search('q');
    expect(results[0].url).toBe('https://news.ycombinator.com/item?id=42');
  });

  it('uses story_text for snippet when present (truncated)', async () => {
    const longText = 'a'.repeat(500);
    const body = {
      hits: [
        {
          objectID: '1',
          title: 't',
          url: 'https://x.test/',
          story_text: longText,
          points: 1,
          num_comments: 1,
          created_at_i: 1700000000,
        },
      ],
    };
    captureFetch(body);
    const results = await new HnAlgoliaEngine().search('q');
    expect(results[0].snippet.length).toBeLessThanOrEqual(200);
    expect(results[0].snippet).toContain('a');
  });

  it('encodes fromDate as numericFilters created_at_i>{epoch}', async () => {
    const { calls } = captureFetch({ hits: [] });
    await new HnAlgoliaEngine().search('q', { fromDate: '2024-01-01T00:00:00Z' });
    const expected = Math.floor(new Date('2024-01-01T00:00:00Z').getTime() / 1000);
    expect(calls[0].url).toContain(`numericFilters=created_at_i%3E${expected}`);
  });

  it('combines fromDate and toDate as comma-separated filters', async () => {
    const { calls } = captureFetch({ hits: [] });
    await new HnAlgoliaEngine().search('q', {
      fromDate: '2024-01-01T00:00:00Z',
      toDate: '2024-12-31T00:00:00Z',
    });
    const from = Math.floor(new Date('2024-01-01T00:00:00Z').getTime() / 1000);
    const to = Math.floor(new Date('2024-12-31T00:00:00Z').getTime() / 1000);
    const param = decodeURIComponent(calls[0].url.split('numericFilters=')[1]);
    expect(param).toBe(`created_at_i>${from},created_at_i<${to}`);
  });

  it('throws when HTTP response is not ok', async () => {
    captureFetch({}, false, 503);
    await expect(new HnAlgoliaEngine().search('q')).rejects.toThrow(/HN Algolia returned 503/);
  });

  it('returns empty array on empty hits', async () => {
    captureFetch({ hits: [] });
    const results = await new HnAlgoliaEngine().search('q');
    expect(results).toEqual([]);
  });

  it('passes hitsPerPage matching maxResults', async () => {
    const { calls } = captureFetch({ hits: [] });
    await new HnAlgoliaEngine().search('q', { maxResults: 25 });
    expect(calls[0].url).toContain('hitsPerPage=25');
  });

  it('always sets tags=story', async () => {
    const { calls } = captureFetch({ hits: [] });
    await new HnAlgoliaEngine().search('q');
    expect(calls[0].url).toContain('tags=story');
  });

  it('propagates fetch errors (timeout/network)', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('aborted'));
    await expect(new HnAlgoliaEngine().search('q')).rejects.toThrow(/aborted/);
  });
});
