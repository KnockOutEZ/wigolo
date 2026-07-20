import { describe, it, expect, vi, afterEach } from 'vitest';
import { OsvEngine } from '../../../../src/search/engines/osv.js';

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function captureFetch(json: any, ok = true, status = 200): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  vi.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    calls.push({ url, init });
    return {
      ok,
      status,
      json: async () => json,
    } as Response;
  });
  return { calls };
}

describe('OsvEngine', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('has name set to osv', () => {
    expect(new OsvEngine().name).toBe('osv');
  });

  describe('query extraction', () => {
    it('returns empty array if no package or id can be extracted', async () => {
      const { calls } = captureFetch({});
      const results = await new OsvEngine().search('vulnerability advisory');
      expect(results).toEqual([]);
      expect(calls).toHaveLength(0); // Did not dispatch
    });

    it('bails out when query has no ecosystem and >2 remaining tokens', async () => {
      const { calls } = captureFetch({});
      const results = await new OsvEngine().search('what is this vulnerability about');
      expect(results).toEqual([]);
      expect(calls).toHaveLength(0);
    });
    
    it('still extracts package when ecosystem is present despite >2 tokens', async () => {
      const { calls } = captureFetch({ vulns: [] });
      const results = await new OsvEngine().search('recent python vulnerability in flask');
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('https://api.osv.dev/v1/query');
      expect(calls[0].init?.body).toContain('"ecosystem":"PyPI"');
      expect(calls[0].init?.body).toContain('"name":"flask"');
    });

    it('extracts CVE and fetches by ID', async () => {
      const { calls } = captureFetch({
        id: 'CVE-2024-1234',
        summary: 'A test vuln',
        published: '2024-01-01T00:00:00Z'
      });
      
      const results = await new OsvEngine().search('tell me about CVE-2024-1234');
      
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('https://api.osv.dev/v1/vulns/CVE-2024-1234');
      expect(calls[0].init?.method).toBe('GET');
      
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('CVE-2024-1234');
    });

    it('extracts package and ecosystem and fetches via query', async () => {
      const { calls } = captureFetch({
        vulns: [
          { id: 'GHSA-1234', summary: 'vuln 1' },
          { id: 'GHSA-5678', summary: 'vuln 2' }
        ]
      });
      
      const results = await new OsvEngine().search('CVE django python');
      
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('https://api.osv.dev/v1/query');
      expect(calls[0].init?.method).toBe('POST');
      expect(calls[0].init?.body).toBe('{"package":{"name":"django","ecosystem":"PyPI"}}');
      
      expect(results).toHaveLength(2);
      expect(results[0].title).toBe('GHSA-1234');
    });
  });

  describe('response parsing', () => {
    it('maps response to RawSearchResult', async () => {
      captureFetch({
        vulns: [
          {
            id: 'GHSA-test-1234',
            summary: 'A bad vulnerability.',
            published: '2024-05-05T10:00:00Z'
          }
        ]
      });
      const results = await new OsvEngine().search('jinja2 pypi');

      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('GHSA-test-1234');
      expect(results[0].url).toBe('https://osv.dev/vulnerability/GHSA-test-1234');
      expect(results[0].engine).toBe('osv');
      expect(results[0].relevance_score).toBe(1);
      expect(results[0].snippet).toBe('A bad vulnerability.');
      expect(results[0].published_date).toBe('2024-05-05T10:00:00.000Z');
    });

    it('falls back to details if summary is missing', async () => {
      captureFetch({
        vulns: [
          {
            id: 'GHSA-test-1234',
            details: 'Detailed description instead of summary.',
          }
        ]
      });
      const results = await new OsvEngine().search('jinja2 pypi');
      expect(results[0].snippet).toBe('Detailed description instead of summary.');
    });
  });

  it('filters client-side using fromDate', async () => {
    captureFetch({
      vulns: [
        { id: '1', published: '2024-01-15T00:00:00Z' },
        { id: '2', published: '2023-11-01T00:00:00Z' },
      ]
    });
    const results = await new OsvEngine().search('test npm', { fromDate: '2024-01-01T00:00:00Z' });
    expect(results.map((r) => r.title)).toEqual(['1']);
  });

  it('throws when HTTP response is not ok', async () => {
    captureFetch({}, false, 500);
    await expect(new OsvEngine().search('jinja2 pypi')).rejects.toThrow(/OSV returned 500/);
  });
  
  it('handles 404 gracefully when querying by ID', async () => {
    const { calls } = captureFetch({}, false, 404);
    const results = await new OsvEngine().search('CVE-2024-9999');
    expect(calls).toHaveLength(1);
    expect(results).toEqual([]);
  });

  it('passes AbortSignal to fetch', async () => {
    const { calls } = captureFetch({ vulns: [] });
    await new OsvEngine().search('jinja2 python');
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
  });
});
