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
            name: 'express',
            version: '5.2.1',
            description: 'Fast, unopinionated, minimalist web framework',
            date: '2025-12-01T20:49:43.268Z',
            publisher: { username: 'jonchurch' },
            links: { npm: 'https://www.npmjs.com/package/express' },
          },
        },
      ],
    };
    captureFetch(body);
    const results = await new NpmRegistryEngine().search('express');

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('express');
    expect(results[0].url).toBe('https://www.npmjs.com/package/express');
    expect(results[0].engine).toBe('npm-registry');
    expect(results[0].snippet).toBe(
      'Fast, unopinionated, minimalist web framework (v5.2.1, by jonchurch)',
    );
    expect(results[0].relevance_score).toBe(1);
    expect(results[0].published_date).toBe('2025-12-01T20:49:43.268Z');
  });

  it('falls back to npmjs package URL when links.npm is missing', async () => {
    const body = {
      objects: [{ package: { name: 'left-pad', version: '1.3.0', description: 'pad' } }],
    };
    captureFetch(body);
    const results = await new NpmRegistryEngine().search('left-pad');
    expect(results[0].url).toBe('https://www.npmjs.com/package/left-pad');
  });

  it('builds snippet without version/publisher metadata when absent', async () => {
    const body = {
      objects: [{ package: { name: 'foo', description: 'a thing' } }],
    };
    captureFetch(body);
    const results = await new NpmRegistryEngine().search('foo');
    expect(results[0].snippet).toBe('a thing');
  });

  it('skips packages without a name', async () => {
    const body = {
      objects: [
        { package: { name: null, description: 'no name' } },
        { package: { name: 'valid', description: 'ok', version: '1.0.0' } },
      ],
    };
    captureFetch(body);
    const results = await new NpmRegistryEngine().search('q');
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('valid');
  });

  it('omits published_date when date is missing', async () => {
    const body = { objects: [{ package: { name: 'x', description: 'y' } }] };
    captureFetch(body);
    const results = await new NpmRegistryEngine().search('q');
    expect(results[0].published_date).toBeUndefined();
  });

  it('passes size matching maxResults', async () => {
    const { calls } = captureFetch({ objects: [] });
    await new NpmRegistryEngine().search('q', { maxResults: 25 });
    expect(calls[0].url).toContain('size=25');
  });

  it('encodes the query text parameter', async () => {
    const { calls } = captureFetch({ objects: [] });
    await new NpmRegistryEngine().search('fastify schema');
    expect(calls[0].url).toContain('text=fastify+schema');
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

  it('returns empty array when objects field is absent', async () => {
    captureFetch({});
    const results = await new NpmRegistryEngine().search('q');
    expect(results).toEqual([]);
  });

  it('propagates fetch errors (timeout/network)', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('aborted'));
    await expect(new NpmRegistryEngine().search('q')).rejects.toThrow(/aborted/);
  });
});
