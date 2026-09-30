import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../../src/config.js';
import { RemoteRerankProvider } from '../../../src/search/reranker/remote-rerank-provider.js';

const candidates = [
  { id: 'first', text: 'document one' },
  { id: 'second', text: 'document two' },
];
const config = (over: Partial<Config> = {}) => ({
  rerankApiBase: 'http://127.0.0.1:8082/v1///',
  rerankApiKey: null,
  rerankerModel: 'test-model',
  rerankerRequestTimeoutMs: 1234,
  ...over,
}) as Config;
const reply = (results: unknown) => new Response(JSON.stringify({ results }), { status: 200 });

afterEach(() => vi.unstubAllGlobals());

describe('RemoteRerankProvider', () => {
  it('sends the ordered documents and maps sorted indexes back to IDs', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const fetchMock = vi.fn().mockResolvedValue(reply([
      { index: 0, score: 0.2 },
      { index: 1, relevance_score: 0.9 },
    ]));
    vi.stubGlobal('fetch', fetchMock);
    const result = await new RemoteRerankProvider(config()).rerank('query', candidates);
    expect(result).toEqual([{ id: 'second', score: 0.9 }, { id: 'first', score: 0.2 }]);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8082/v1/rerank');
    expect(options.method).toBe('POST');
    expect(options.redirect).toBe('error');
    expect(options.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(options.body)).toEqual({
      model: 'test-model', query: 'query', documents: ['document one', 'document two'], top_n: 2,
    });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(timeout).toHaveBeenCalledWith(1234);
    timeout.mockRestore();
  });

  it('sends top_n and optional Bearer auth', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply([{ index: 1, relevance_score: 0.8 }]));
    vi.stubGlobal('fetch', fetchMock);
    expect(await new RemoteRerankProvider(config({ rerankApiBase: 'https://rerank.example/v1', rerankApiKey: 'secret' })).rerank('q', candidates, 1))
      .toEqual([{ id: 'second', score: 0.8 }]);
    const options = fetchMock.mock.calls[0][1];
    expect(options.headers.Authorization).toBe('Bearer secret');
    expect(JSON.parse(options.body).top_n).toBe(1);
  });

  it('returns immediately for empty candidates', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await new RemoteRerankProvider(config()).rerank('q', [])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires a valid configured base URL', () => {
    expect(() => new RemoteRerankProvider(config({ rerankApiBase: null }))).toThrow('WIGOLO_RERANK_API_BASE');
    expect(() => new RemoteRerankProvider(config({ rerankApiBase: 'file:///tmp/x' }))).toThrow('http(s)');
  });

  it('requires HTTPS for credentials while allowing keyless HTTP', () => {
    const remote = { rerankApiBase: 'http://192.168.1.20:8082/v1' };
    expect(() => new RemoteRerankProvider(config({ ...remote, rerankApiKey: 'secret' }))).toThrow('requires HTTPS');
    expect(() => new RemoteRerankProvider(config({ rerankApiKey: 'secret' }))).toThrow('requires HTTPS');
    expect(() => new RemoteRerankProvider(config(remote))).not.toThrow();
    expect(() => new RemoteRerankProvider(config({ rerankApiBase: 'https://rerank.example/v1', rerankApiKey: 'secret' }))).not.toThrow();
  });

  it('reports HTTP status without reading or exposing the response body', async () => {
    const text = vi.fn(() => { throw new Error('body should not be read'); });
    const cancel = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 502, text, body: { cancel } }));
    const error = await new RemoteRerankProvider(config({ rerankApiBase: 'https://rerank.example/v1', rerankApiKey: 'secret' })).rerank('q', candidates)
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('HTTP 502');
    expect((error as Error).message).not.toContain('secret');
    expect((error as Error).message).toBe('Remote rerank HTTP 502');
    expect(text).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('rejects invalid JSON and malformed or ambiguous results', async () => {
    const provider = new RemoteRerankProvider(config());
    const cases: Array<[Response, string]> = [
      [new Response('{invalid'), 'invalid JSON'],
      [new Response('{}'), 'results array'],
      [reply([{ index: 0, score: 0.9 }]), 'number of results'],
      [reply([{ index: 0, score: 0.9 }, { index: 0, score: 0.8 }]), 'duplicate index'],
      [reply([{ index: 2, score: 0.9 }, { index: 1, score: 0.8 }]), 'out-of-range index'],
      [reply([{ index: 0.5, score: 0.9 }, { index: 1, score: 0.8 }]), 'out-of-range index'],
      [reply([{ index: 0, score: '0.9' }, { index: 1, score: 0.8 }]), 'missing score'],
    ];
    for (const [response, message] of cases) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
      await expect(provider.rerank('q', candidates)).rejects.toThrow(message);
    }
  });

  it('rejects non-finite scores even if a service returns them', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [{ index: 0, score: NaN }, { index: 1, score: 0.8 }] }),
    }));
    await expect(new RemoteRerankProvider(config()).rerank('q', candidates)).rejects.toThrow('non-finite');
  });
});
