import { describe, it, expect, vi, afterEach } from 'vitest';
import { NpmRegistryEngine } from '../../../../src/search/engines/npm-registry.js';

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

describe('NpmRegistryEngine', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('has name set to npm-registry', () => {
    expect(new NpmRegistryEngine().name).toBe('npm-registry');
  });

  it('maps a successful response to RawSearchResult fields', async () => {
    const body = {
      objects: [
        {
          package: {
            name: 'react',
            version: '19.2.7',
            description: 'React is a JavaScript library for building user interfaces.',
            date: '2026-06-01T18:00:48.323Z',
            links: { npm: 'https://www.npmjs.com/package/react' },
          },
          score: { final: 2232.1382 },
        },
      ],
      total: 1,
    };
    captureFetch(body);
    const engine = new NpmRegistryEngine();
    const results = await engine.search('react');

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('react@19.2.7');
    expect(results[0].url).toBe('https://www.npmjs.com/package/react');
    expect(results[0].engine).toBe('npm-registry');
    expect(results[0].snippet).toBe(
      'React is a JavaScript library for building user interfaces.',
    );
    expect(results[0].relevance_score).toBe(1);
    expect(results[0].published_date).toBe('2026-06-01T18:00:48.323Z');
  });

  it('falls back to bare package name when version is missing', async () => {
    const body = {
      objects: [
        {
          package: {
            name: 'left-pad',
            description: 'String left pad',
            links: { npm: 'https://www.npmjs.com/package/left-pad' },
          },
        },
      ],
    };
    captureFetch(body);
    const results = await new NpmRegistryEngine().search('left-pad');
    expect(results[0].title).toBe('left-pad');
  });

  it('skips objects missing a package name or npm link', async () => {
    const body = {
      objects: [
        { package: { description: 'no name', links: { npm: 'https://www.npmjs.com/package/x' } } },
        { package: { name: 'no-link', description: 'no link' } },
      ],
    };
    captureFetch(body);
    const results = await new NpmRegistryEngine().search('q');
    expect(results).toEqual([]);
  });

  it('truncates long descriptions to the snippet limit', async () => {
    const longDescription = 'a'.repeat(500);
    const body = {
      objects: [
        {
          package: {
            name: 'pkg',
            version: '1.0.0',
            description: longDescription,
            links: { npm: 'https://www.npmjs.com/package/pkg' },
          },
        },
      ],
    };
    captureFetch(body);
    const results = await new NpmRegistryEngine().search('q');
    expect(results[0].snippet.length).toBeLessThanOrEqual(200);
    expect(results[0].snippet).toContain('a');
  });

  it('throws when HTTP response is not ok', async () => {
    captureFetch({}, false, 503);
    await expect(new NpmRegistryEngine().search('q')).rejects.toThrow(/npm registry returned 503/);
  });

  it('returns empty array on empty objects', async () => {
    captureFetch({ objects: [] });
    const results = await new NpmRegistryEngine().search('q');
    expect(results).toEqual([]);
  });

  it('passes size matching maxResults', async () => {
    const { calls } = captureFetch({ objects: [] });
    await new NpmRegistryEngine().search('q', { maxResults: 25 });
    expect(calls[0].url).toContain('size=25');
  });

  it('encodes the query text', async () => {
    const { calls } = captureFetch({ objects: [] });
    await new NpmRegistryEngine().search('react query');
    expect(calls[0].url).toContain('text=react+query');
  });

  it('sends a descriptive User-Agent header', async () => {
    const { calls } = captureFetch({ objects: [] });
    await new NpmRegistryEngine().search('q');
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers['User-Agent']).toContain('wigolo');
  });

  it('propagates fetch errors (timeout/network)', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('aborted'));
    await expect(new NpmRegistryEngine().search('q')).rejects.toThrow(/aborted/);
  });
});
