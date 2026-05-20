import { describe, it, expect, vi, afterEach } from 'vitest';
import { ArxivEngine } from '../../../../src/search/engines/arxiv.js';

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function captureFetch(text: string, ok = true, status = 200): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  vi.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    calls.push({ url, init });
    return {
      ok,
      status,
      text: async () => text,
    } as Response;
  });
  return { calls };
}

const ATOM_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2301.00001v1</id>
    <title>
      Attention Is All You Need:
      A Survey
    </title>
    <summary>This paper surveys the attention mechanism in deep learning. ${'x'.repeat(400)}</summary>
    <published>2023-01-15T00:00:00Z</published>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2301.00002v1</id>
    <title>Second Paper</title>
    <summary>Another summary.</summary>
    <published>2024-06-01T00:00:00Z</published>
  </entry>
</feed>`;

describe('ArxivEngine', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('has name set to arxiv', () => {
    expect(new ArxivEngine().name).toBe('arxiv');
  });

  it('parses Atom XML and maps entries to RawSearchResult', async () => {
    captureFetch(ATOM_FIXTURE);
    const results = await new ArxivEngine().search('attention');

    expect(results).toHaveLength(2);
    expect(results[0].title).toBe('Attention Is All You Need: A Survey');
    expect(results[0].url).toBe('http://arxiv.org/abs/2301.00001v1');
    expect(results[0].engine).toBe('arxiv');
    expect(results[0].relevance_score).toBe(1);
    expect(results[0].snippet.length).toBeLessThanOrEqual(200);
    expect(results[0].published_date).toBe('2023-01-15T00:00:00.000Z');
    expect(results[1].title).toBe('Second Paper');
  });

  it('filters client-side using fromDate', async () => {
    captureFetch(ATOM_FIXTURE);
    const results = await new ArxivEngine().search('q', { fromDate: '2024-01-01T00:00:00Z' });
    expect(results.map((r) => r.title)).toEqual(['Second Paper']);
  });

  it('filters client-side using toDate', async () => {
    captureFetch(ATOM_FIXTURE);
    const results = await new ArxivEngine().search('q', { toDate: '2023-12-31T00:00:00Z' });
    expect(results).toHaveLength(1);
    expect(results[0].title).toContain('Attention');
  });

  it('returns empty array when there are no entries', async () => {
    captureFetch('<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>');
    expect(await new ArxivEngine().search('q')).toEqual([]);
  });

  it('throws when HTTP response is not ok', async () => {
    captureFetch('', false, 503);
    await expect(new ArxivEngine().search('q')).rejects.toThrow(/arXiv returned 503/);
  });

  it('encodes max_results from maxResults', async () => {
    const { calls } = captureFetch('<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>');
    await new ArxivEngine().search('q', { maxResults: 4 });
    expect(calls[0].url).toContain('max_results=4');
  });

  it('passes AbortSignal to fetch', async () => {
    const { calls } = captureFetch('<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>');
    await new ArxivEngine().search('q');
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
  });
});
