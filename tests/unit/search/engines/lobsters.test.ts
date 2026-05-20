import { describe, it, expect, vi, afterEach } from 'vitest';
import { LobstersEngine } from '../../../../src/search/engines/lobsters.js';

function captureFetch(body: unknown, ok = true, status = 200): void {
  vi.spyOn(global, 'fetch').mockImplementation(async () => {
    return {
      ok,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response;
  });
}

describe('LobstersEngine', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('has name set to lobsters', () => {
    expect(new LobstersEngine().name).toBe('lobsters');
  });

  it('maps an array response to RawSearchResult', async () => {
    const body = [
      {
        short_id: 'abc',
        title: 'Foo',
        url: 'https://example.com/foo',
        score: 42,
        description: 'A short summary',
        comment_count: 7,
        created_at: '2025-05-01T12:34:56.000-07:00',
        short_id_url: 'https://lobste.rs/s/abc',
      },
    ];
    captureFetch(body);
    const results = await new LobstersEngine().search('q');
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Foo');
    expect(results[0].url).toBe('https://example.com/foo');
    expect(results[0].engine).toBe('lobsters');
    expect(results[0].snippet).toBe('A short summary');
    expect(results[0].published_date).toBe(new Date('2025-05-01T12:34:56.000-07:00').toISOString());
  });

  it('maps an object-with-results response', async () => {
    const body = {
      results: [
        {
          short_id: 'xyz',
          title: 'Bar',
          url: 'https://example.com/bar',
          score: 1,
          description: '',
          comment_count: 0,
          created_at: '2025-01-01T00:00:00Z',
          short_id_url: 'https://lobste.rs/s/xyz',
        },
      ],
    };
    captureFetch(body);
    const results = await new LobstersEngine().search('q');
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Bar');
  });

  it('falls back to short_id_url when url is null', async () => {
    const body = [
      {
        short_id: 'self',
        title: 'Self-post',
        url: null,
        score: 5,
        description: 'self',
        comment_count: 2,
        created_at: '2025-01-01T00:00:00Z',
        short_id_url: 'https://lobste.rs/s/self',
      },
    ];
    captureFetch(body);
    const results = await new LobstersEngine().search('q');
    expect(results[0].url).toBe('https://lobste.rs/s/self');
  });

  it('uses score + comments snippet when description is empty', async () => {
    const body = [
      {
        short_id: 'a',
        title: 't',
        url: 'https://x.test/',
        score: 99,
        description: '',
        comment_count: 12,
        created_at: '2025-01-01T00:00:00Z',
        short_id_url: 'https://lobste.rs/s/a',
      },
    ];
    captureFetch(body);
    const results = await new LobstersEngine().search('q');
    expect(results[0].snippet).toBe('99 score · 12 comments');
  });

  it('filters out hits outside fromDate client-side', async () => {
    const body = [
      {
        short_id: 'old',
        title: 'old',
        url: 'https://x.test/old',
        score: 1,
        description: 'old',
        comment_count: 0,
        created_at: '2020-01-01T00:00:00Z',
        short_id_url: 'https://lobste.rs/s/old',
      },
      {
        short_id: 'new',
        title: 'new',
        url: 'https://x.test/new',
        score: 1,
        description: 'new',
        comment_count: 0,
        created_at: '2025-06-01T00:00:00Z',
        short_id_url: 'https://lobste.rs/s/new',
      },
    ];
    captureFetch(body);
    const results = await new LobstersEngine().search('q', { fromDate: '2024-01-01T00:00:00Z' });
    expect(results.map((r) => r.title)).toEqual(['new']);
  });

  it('filters out hits past toDate client-side', async () => {
    const body = [
      {
        short_id: 'old',
        title: 'old',
        url: 'https://x.test/old',
        score: 1,
        description: 'old',
        comment_count: 0,
        created_at: '2020-01-01T00:00:00Z',
        short_id_url: 'https://lobste.rs/s/old',
      },
      {
        short_id: 'new',
        title: 'new',
        url: 'https://x.test/new',
        score: 1,
        description: 'new',
        comment_count: 0,
        created_at: '2025-06-01T00:00:00Z',
        short_id_url: 'https://lobste.rs/s/new',
      },
    ];
    captureFetch(body);
    const results = await new LobstersEngine().search('q', { toDate: '2021-01-01T00:00:00Z' });
    expect(results.map((r) => r.title)).toEqual(['old']);
  });

  it('throws when HTTP response is not ok', async () => {
    captureFetch([], false, 502);
    await expect(new LobstersEngine().search('q')).rejects.toThrow(/Lobsters returned 502/);
  });

  it('returns empty array on empty results', async () => {
    captureFetch([]);
    expect(await new LobstersEngine().search('q')).toEqual([]);
  });

  it('respects maxResults', async () => {
    const body = Array.from({ length: 20 }, (_, i) => ({
      short_id: `s${i}`,
      title: `t${i}`,
      url: `https://x.test/${i}`,
      score: 1,
      description: '',
      comment_count: 0,
      created_at: '2025-01-01T00:00:00Z',
      short_id_url: `https://lobste.rs/s/s${i}`,
    }));
    captureFetch(body);
    const results = await new LobstersEngine().search('q', { maxResults: 5 });
    expect(results).toHaveLength(5);
  });
});
