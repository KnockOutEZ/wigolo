import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OutcrawlEngine } from '../../../../src/search/engines/outcrawl.js';
import { resetConfig } from '../../../../src/config.js';

describe('OutcrawlEngine', () => {
  const engine = new OutcrawlEngine();
  const originalKey = process.env.OUTCRAWL_API_KEY;

  beforeEach(() => {
    delete process.env.OUTCRAWL_API_KEY;
    resetConfig();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalKey === undefined) {
      delete process.env.OUTCRAWL_API_KEY;
    } else {
      process.env.OUTCRAWL_API_KEY = originalKey;
    }
    resetConfig();
  });

  it('has name set to outcrawl', () => {
    expect(engine.name).toBe('outcrawl');
  });

  it('parses hits into RawSearchResult shape', () => {
    const body = {
      hits: [
        { title: 'Next.js', url: 'https://nextjs.org/', snippet: 'React framework', rank: 1 },
        { title: 'React docs', url: 'https://react.dev/', snippet: 'Library', rank: 2 },
      ],
    };
    const results = engine.parseResults(body, 10);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      title: 'Next.js',
      url: 'https://nextjs.org/',
      snippet: 'React framework',
      engine: 'outcrawl',
    });
    expect(results[0].relevance_score).toBeGreaterThan(results[1].relevance_score);
  });

  it('returns empty array when body has no hits', () => {
    expect(engine.parseResults({}, 10)).toEqual([]);
    expect(engine.parseResults({ hits: [] }, 10)).toEqual([]);
  });

  it('respects maxResults', () => {
    const body = {
      hits: [
        { title: 'A', url: 'https://a' },
        { title: 'B', url: 'https://b' },
        { title: 'C', url: 'https://c' },
      ],
    };
    expect(engine.parseResults(body, 2)).toHaveLength(2);
  });

  it('skips entries missing title or url', () => {
    const body = {
      hits: [
        { title: 'A', url: 'https://a' },
        { title: '', url: 'https://b' },
        { url: 'https://c' },
        { title: 'D' },
      ],
    };
    expect(engine.parseResults(body, 10).map((r) => r.title)).toEqual(['A']);
  });

  it('throws without dispatching when OUTCRAWL_API_KEY is not set', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(engine.search('next.js')).rejects.toThrow(/OUTCRAWL_API_KEY not set/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts the query with a bearer token and parses the response', async () => {
    process.env.OUTCRAWL_API_KEY = 'test-key';
    resetConfig();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        hits: [{ title: 'Next.js', url: 'https://nextjs.org/', snippet: 'React framework', rank: 1 }],
        usage: { credits: '1' },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const results = await engine.search('next.js', { maxResults: 5 });

    expect(results.map((r) => r.url)).toEqual(['https://nextjs.org/']);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.outcrawl.ai/v1/search');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key');
    expect(JSON.parse(init.body as string)).toEqual({ query: 'next.js', limit: 5 });
  });

  it('caps the requested limit at 20', async () => {
    process.env.OUTCRAWL_API_KEY = 'test-key';
    resetConfig();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ hits: [] }) });
    vi.stubGlobal('fetch', fetchMock);

    await engine.search('next.js', { maxResults: 50 });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).limit).toBe(20);
  });

  it('throws with the HTTP status on a non-2xx response', async () => {
    process.env.OUTCRAWL_API_KEY = 'test-key';
    resetConfig();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }));

    await expect(engine.search('next.js')).rejects.toThrow('Outcrawl returned 401');
  });
});
