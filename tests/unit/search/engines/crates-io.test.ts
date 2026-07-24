import { describe, it, expect, vi, afterEach } from 'vitest';
import { CratesIoEngine } from '../../../../src/search/engines/crates-io.js';

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

describe('CratesIoEngine', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('has name set to crates-io', () => {
    expect(new CratesIoEngine().name).toBe('crates-io');
  });

  it('maps a successful response to RawSearchResult fields', async () => {
    const body = {
      crates: [
        {
          name: 'serde',
          description: 'A generic serialization/deserialization framework',
          downloads: 500000000,
          max_version: '1.0.203',
        },
      ],
    };
    captureFetch(body);
    const engine = new CratesIoEngine();
    const results = await engine.search('serde');

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('serde');
    expect(results[0].url).toBe('https://crates.io/crates/serde');
    expect(results[0].engine).toBe('crates-io');
    expect(results[0].snippet).toBe(
      'A generic serialization/deserialization framework (v1.0.203, 500000000 downloads)',
    );
    expect(results[0].relevance_score).toBe(1);
  });

  it('falls back to empty description when description is missing', async () => {
    const body = {
      crates: [{ name: 'foo', description: null, downloads: 10, max_version: '0.1.0' }],
    };
    captureFetch(body);
    const results = await new CratesIoEngine().search('foo');
    expect(results[0].snippet).toBe(' (v0.1.0, 10 downloads)');
  });

  it('skips crates without a name', async () => {
    const body = {
      crates: [
        { name: null, description: 'no name', downloads: 1, max_version: '1.0.0' },
        { name: 'valid', description: 'ok', downloads: 1, max_version: '1.0.0' },
      ],
    };
    captureFetch(body);
    const results = await new CratesIoEngine().search('q');
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('valid');
  });

  it('sets a descriptive User-Agent header', async () => {
    const { calls } = captureFetch({ crates: [] });
    await new CratesIoEngine().search('q');
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers['User-Agent']).toContain('wigolo');
    expect(headers['User-Agent']).toContain('https://github.com/KnockOutEZ/wigolo');
  });

  it('passes per_page matching maxResults', async () => {
    const { calls } = captureFetch({ crates: [] });
    await new CratesIoEngine().search('q', { maxResults: 25 });
    expect(calls[0].url).toContain('per_page=25');
  });

  it('throws when HTTP response is not ok', async () => {
    captureFetch({}, false, 503);
    await expect(new CratesIoEngine().search('q')).rejects.toThrow(/crates\.io returned 503/);
  });

  it('returns empty array on empty crates', async () => {
    captureFetch({ crates: [] });
    const results = await new CratesIoEngine().search('q');
    expect(results).toEqual([]);
  });

  it('returns empty array when crates field is absent', async () => {
    captureFetch({});
    const results = await new CratesIoEngine().search('q');
    expect(results).toEqual([]);
  });

  it('propagates fetch errors (timeout/network)', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('aborted'));
    await expect(new CratesIoEngine().search('q')).rejects.toThrow(/aborted/);
  });
});
