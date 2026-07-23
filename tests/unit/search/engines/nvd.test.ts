import { describe, it, expect, vi, afterEach } from 'vitest';
import { NvdEngine } from '../../../../src/search/engines/nvd.js';

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

const NVD_FIXTURE = {
  resultsPerPage: 2,
  startIndex: 0,
  totalResults: 2,
  format: "NVD_CVE",
  version: "2.0",
  timestamp: "2024-01-01T00:00:00.000",
  vulnerabilities: [
    {
      cve: {
        id: "CVE-2024-0001",
        published: "2024-01-15T00:00:00.000",
        lastModified: "2024-01-20T00:00:00.000",
        descriptions: [
          { lang: "en", value: "This is a serious vulnerability in the system." },
          { lang: "es", value: "Esta es una vulnerabilidad grave." }
        ]
      }
    },
    {
      cve: {
        id: "CVE-2023-9999",
        published: "2023-11-01T00:00:00.000",
        descriptions: [
          { lang: "en", value: "Another issue." }
        ]
      }
    }
  ]
};

describe('NvdEngine', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('has name set to nvd', () => {
    expect(new NvdEngine().name).toBe('nvd');
  });

  it('parses JSON response and maps to RawSearchResult', async () => {
    captureFetch(NVD_FIXTURE);
    const results = await new NvdEngine().search('test query');

    expect(results).toHaveLength(2);
    expect(results[0].title).toBe('CVE-2024-0001');
    expect(results[0].url).toBe('https://nvd.nist.gov/vuln/detail/CVE-2024-0001');
    expect(results[0].engine).toBe('nvd');
    expect(results[0].relevance_score).toBe(1);
    expect(results[0].snippet).toBe('This is a serious vulnerability in the system.');
    expect(results[0].published_date).toBe('2024-01-15T00:00:00.000Z');
    
    expect(results[1].title).toBe('CVE-2023-9999');
    expect(results[1].relevance_score).toBe(0.5);
  });

  it('filters client-side using fromDate', async () => {
    captureFetch(NVD_FIXTURE);
    const results = await new NvdEngine().search('q', { fromDate: '2024-01-01T00:00:00Z' });
    expect(results.map((r) => r.title)).toEqual(['CVE-2024-0001']);
  });

  it('filters client-side using toDate', async () => {
    captureFetch(NVD_FIXTURE);
    const results = await new NvdEngine().search('q', { toDate: '2023-12-31T00:00:00Z' });
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('CVE-2023-9999');
  });

  it('returns empty array when there are no entries', async () => {
    captureFetch({ vulnerabilities: [] });
    expect(await new NvdEngine().search('q')).toEqual([]);
  });

  it('throws when HTTP response is not ok', async () => {
    captureFetch({}, false, 503);
    await expect(new NvdEngine().search('q')).rejects.toThrow(/NVD returned 503/);
  });

  it('encodes max_results from maxResults', async () => {
    const { calls } = captureFetch({ vulnerabilities: [] });
    await new NvdEngine().search('q', { maxResults: 4 });
    expect(calls[0].url).toContain('resultsPerPage=4');
  });

  it('uses cveId param for bare CVE ID queries', async () => {
    const { calls } = captureFetch({ vulnerabilities: [] });
    await new NvdEngine().search('CVE-2024-0001');
    expect(calls[0].url).toContain('cveId=CVE-2024-0001');
    expect(calls[0].url).not.toContain('keywordSearch');
  });

  it('falls back to keywordSearch for non-CVE queries', async () => {
    const { calls } = captureFetch({ vulnerabilities: [] });
    await new NvdEngine().search('linux kernel vulnerability');
    expect(calls[0].url).toContain('keywordSearch=');
    expect(calls[0].url).not.toContain('cveId=');
  });

  it('passes AbortSignal to fetch', async () => {
    const { calls } = captureFetch({ vulnerabilities: [] });
    await new NvdEngine().search('q');
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
  });
});
