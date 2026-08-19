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
            name: 'zod',
            version: '3.23.8',
            description: 'TypeScript-first schema validation with static type inference',
            date: '2024-05-11T00:00:00.000Z',
            links: { npm: 'https://www.npmjs.com/package/zod' },
          },
        },
      ],
    };
    captureFetch(body);
    const engine = new NpmRegistryEngine();
    const results = await engine.search('zod');

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('zod');
    expect(results[0].url).toBe('https://www.npmjs.com/package/zod');
    expect(results[0].engine).toBe('npm-registry');
    expect(results[0].snippet).toBe(
      'TypeScript-first schema validation with static type inference (v3.23.8)',
    );
    expect(results[0].published_date).toBe('2024-05-11T00:00:00.000Z');
    expect(results[0].relevance_score).toBe(1);
  });

  it('falls back to empty description when description is missing', async () => {
    const body = {
      objects: [{ package: { name: 'foo', version: '0.1.0' } }],
    };
    captureFetch(body);
    const results = await new NpmRegistryEngine().search('foo');
    expect(results[0].snippet).toBe(' (v0.1.0)');
    expect(results[0].url).toBe('https://www.npmjs.com/package/foo');
  });

  it('builds a npmjs.com URL for scoped packages when links.npm is absent', async () => {
    const body = {
      objects: [{ package: { name: '@types/node', version: '20.0.0', description: 'TypeScript definitions' } }],
    };
    captureFetch(body);
    const results = await new NpmRegistryEngine().search('node');
    expect(results[0].url).toBe('https://www.npmjs.com/package/@types/node');
  });

  it('skips packages without a name', async () => {
    const body = {
      objects: [
        { package: { name: null, description: 'no name', version: '1.0.0' } },
        { package: { name: 'valid', description: 'ok', version: '1.0.0' } },
      ],
    };
    captureFetch(body);
    const results = await new NpmRegistryEngine().search('q');
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('valid');
    expect(results[0].relevance_score).toBe(1);
  });

  it('does not count nameless packages toward maxResults', async () => {
    const body = {
      objects: [
        { package: { name: null, version: '1.0.0' } },
        { package: { name: 'one', version: '1.0.0' } },
        { package: { name: 'two', version: '1.0.0' } },
      ],
    };
    captureFetch(body);
    const results = await new NpmRegistryEngine().search('q', { maxResults: 1 });
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('one');
  });

  it('ignores links.npm that are not npmjs.com package pages', async () => {
    const body = {
      objects: [
        {
          package: {
            name: 'left-pad',
            version: '1.3.0',
            links: { npm: 'https://evil.example/phish' },
          },
        },
      ],
    };
    captureFetch(body);
    const results = await new NpmRegistryEngine().search('q');
    expect(results[0].url).toBe('https://www.npmjs.com/package/left-pad');
  });

  it('sets a descriptive User-Agent header', async () => {
    const { calls } = captureFetch({ objects: [] });
    await new NpmRegistryEngine().search('q');
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers['User-Agent']).toContain('wigolo');
    expect(headers['User-Agent']).toContain('https://github.com/KnockOutEZ/wigolo');
  });

  it('passes size matching maxResults', async () => {
    const { calls } = captureFetch({ objects: [] });
    await new NpmRegistryEngine().search('q', { maxResults: 25 });
    expect(calls[0].url).toContain('size=25');
    expect(calls[0].url).toContain('text=q');
  });

  it('stops after maxResults even if the registry returns extra objects', async () => {
    const body = {
      objects: [
        { package: { name: 'one', version: '1.0.0' } },
        { package: { name: 'two', version: '1.0.0' } },
        { package: { name: 'three', version: '1.0.0' } },
      ],
    };
    captureFetch(body);
    const results = await new NpmRegistryEngine().search('q', { maxResults: 2 });
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.title)).toEqual(['one', 'two']);
  });

  it('clamps size to the registry maximum of 250', async () => {
    const { calls } = captureFetch({ objects: [] });
    await new NpmRegistryEngine().search('q', { maxResults: 1000 });
    expect(calls[0].url).toContain('size=250');
  });

  it('returns empty without fetching when maxResults is zero', async () => {
    const { calls } = captureFetch({ objects: [{ package: { name: 'one', version: '1.0.0' } }] });
    const results = await new NpmRegistryEngine().search('q', { maxResults: 0 });
    expect(results).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('floors fractional maxResults before requesting and parsing', async () => {
    const body = {
      objects: [
        { package: { name: 'one', version: '1.0.0' } },
        { package: { name: 'two', version: '1.0.0' } },
      ],
    };
    const { calls } = captureFetch(body);
    const results = await new NpmRegistryEngine().search('q', { maxResults: 1.5 });
    expect(calls[0].url).toContain('size=1');
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('one');
  });

  it('falls back to the default limit when maxResults is NaN', async () => {
    const { calls } = captureFetch({ objects: [] });
    await new NpmRegistryEngine().search('q', { maxResults: Number.NaN });
    expect(calls[0].url).toContain('size=10');
  });

  it('skips null registry objects without failing the search', async () => {
    const body = {
      objects: [
        null,
        { package: { name: 'valid', version: '1.0.0' } },
      ],
    };
    captureFetch(body);
    const results = await new NpmRegistryEngine().search('q');
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('valid');
  });

  it('passes timeoutMs to AbortSignal.timeout', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    captureFetch({ objects: [] });
    await new NpmRegistryEngine().search('q', { timeoutMs: 1500 });
    expect(timeoutSpy).toHaveBeenCalledWith(1500);
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

  it('returns empty array when objects is not an array', async () => {
    captureFetch({ objects: { package: { name: 'sneaky' } } });
    const results = await new NpmRegistryEngine().search('q');
    expect(results).toEqual([]);
  });

  it('propagates fetch errors (timeout/network)', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('aborted'));
    await expect(new NpmRegistryEngine().search('q')).rejects.toThrow(/aborted/);
  });
});
