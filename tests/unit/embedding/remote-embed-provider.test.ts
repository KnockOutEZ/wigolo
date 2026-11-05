import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../../src/config.js';
import { RemoteEmbedProvider, REMOTE_EMBED_DIM } from '../../../src/embedding/remote-embed-provider.js';

const config = (over: Partial<Config> = {}) => ({
  embeddingApiBase: 'http://127.0.0.1:8080/v1///',
  embeddingApiKey: null,
  embeddingModel: 'test-embed',
  embeddingRequestTimeoutMs: 1234,
  ...over,
}) as Config;

const vector = (seed: number) => Array.from({ length: REMOTE_EMBED_DIM }, (_, i) => seed + i / 1000);
const reply = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });

afterEach(() => vi.unstubAllGlobals());

describe('RemoteEmbedProvider', () => {
  it('posts the model and inputs, and returns vectors in index order', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const fetchMock = vi.fn().mockResolvedValue(reply([
      { index: 1, embedding: vector(2) },
      { index: 0, embedding: vector(1) },
    ]));
    vi.stubGlobal('fetch', fetchMock);
    const result = await new RemoteEmbedProvider(config()).embed(['first', 'second']);
    expect(result).toHaveLength(2);
    expect(result[0][0]).toBeCloseTo(1);
    expect(result[1][0]).toBeCloseTo(2);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8080/v1/embeddings');
    expect(options.method).toBe('POST');
    expect(options.redirect).toBe('error');
    expect(options.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(options.body)).toEqual({ model: 'test-embed', input: ['first', 'second'] });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(timeout).toHaveBeenCalledWith(1234);
    timeout.mockRestore();
  });

  it('sends an optional Bearer token and keeps array order when index is omitted', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply([{ embedding: vector(1) }, { embedding: vector(2) }]));
    vi.stubGlobal('fetch', fetchMock);
    const result = await new RemoteEmbedProvider(
      config({ embeddingApiBase: 'https://embed.example/v1', embeddingApiKey: 'secret' }),
    ).embed(['a', 'b']);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer secret');
    expect(result[0][0]).toBeCloseTo(1);
    expect(result[1][0]).toBeCloseTo(2);
  });

  it('returns immediately for empty input', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await new RemoteEmbedProvider(config()).embed([])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends one probe request during warmup', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply([{ index: 0, embedding: vector(1) }]));
    vi.stubGlobal('fetch', fetchMock);
    await new RemoteEmbedProvider(config()).warmup();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).input).toEqual(['wigolo warmup']);
  });

  it('requires a valid configured base URL', () => {
    expect(() => new RemoteEmbedProvider(config({ embeddingApiBase: null }))).toThrow('WIGOLO_EMBEDDING_API_BASE');
    expect(() => new RemoteEmbedProvider(config({ embeddingApiBase: 'file:///tmp/x' }))).toThrow('http(s)');
    expect(() => new RemoteEmbedProvider(config({ embeddingApiBase: 'http://user:pass@host/v1' }))).toThrow('without credentials');
    expect(() => new RemoteEmbedProvider(config({ embeddingApiBase: 'https://embed.example/v1?' }))).toThrow('query, or fragment');
    expect(() => new RemoteEmbedProvider(config({ embeddingApiBase: 'https://embed.example/v1#' }))).toThrow('query, or fragment');
  });

  it('scopes the provenance id to the endpoint while the request keeps the bare model name', async () => {
    const one = new RemoteEmbedProvider(config());
    const two = new RemoteEmbedProvider(config({ embeddingApiBase: 'http://127.0.0.1:9090/v1' }));
    expect(one.modelId).toBe('test-embed @ http://127.0.0.1:8080/v1');
    expect(two.modelId).toBe('test-embed @ http://127.0.0.1:9090/v1');
    expect(one.modelId).not.toBe(two.modelId);
    const fetchMock = vi.fn().mockResolvedValue(reply([{ index: 0, embedding: vector(1) }]));
    vi.stubGlobal('fetch', fetchMock);
    await one.embed(['a']);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe('test-embed');
  });

  it('rejects a response body above the size cap', async () => {
    const chunk = new Uint8Array(256 * 1024);
    const stream = new ReadableStream({
      start(controller) {
        for (let i = 0; i < 5; i += 1) controller.enqueue(chunk);
        controller.close();
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream, { status: 200 })));
    await expect(new RemoteEmbedProvider(config()).embed(['a'])).rejects.toThrow('response exceeded');
  });

  it('requires HTTPS for credentials off loopback while allowing keyless HTTP', () => {
    const remote = { embeddingApiBase: 'http://192.168.1.20:8080/v1' };
    expect(() => new RemoteEmbedProvider(config({ ...remote, embeddingApiKey: 'secret' }))).toThrow('requires HTTPS');
    expect(() => new RemoteEmbedProvider(config(remote))).not.toThrow();
    expect(() => new RemoteEmbedProvider(config({ embeddingApiBase: 'https://embed.example/v1', embeddingApiKey: 'secret' }))).not.toThrow();
  });

  it('allows credentials over plain HTTP to a loopback endpoint', () => {
    for (const base of ['http://127.0.0.1:8080/v1', 'http://localhost:8080/v1', 'http://localhost.:8080/v1', 'http://[::1]:8080/v1']) {
      expect(() => new RemoteEmbedProvider(config({ embeddingApiBase: base, embeddingApiKey: 'secret' }))).not.toThrow();
    }
  });

  it('reports HTTP status without reading or exposing the response body', async () => {
    const text = vi.fn(() => { throw new Error('body should not be read'); });
    const cancel = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, text, body: { cancel } }));
    const error = await new RemoteEmbedProvider(
      config({ embeddingApiBase: 'https://embed.example/v1', embeddingApiKey: 'secret' }),
    ).embed(['a']).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Remote embedding HTTP 503');
    expect((error as Error).message).not.toContain('secret');
    expect(text).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('rejects invalid JSON and malformed payloads', async () => {
    const provider = new RemoteEmbedProvider(config());
    const overflow = vector(1);
    overflow[0] = 1e100;
    const cases: Array<[Response, string, string[]?]> = [
      [new Response('{invalid'), 'invalid JSON'],
      [new Response('{}'), 'data array'],
      [reply([]), 'vectors for'],
      [reply([{ index: 0, embedding: vector(1) }, { index: 0, embedding: vector(2) }]), 'duplicate index', ['a', 'b']],
      [reply([{ index: 5, embedding: vector(1) }]), 'out-of-range index'],
      [reply([{ index: 0, embedding: vector(1).slice(0, 100) }]), '384 dimensions'],
      [reply([{ index: 0, embedding: vector(1).map(() => null) }]), 'non-finite'],
      [reply([{ index: 0, embedding: overflow }]), 'float32 range'],
      [reply([null]), 'item must be an object'],
    ];
    for (const [response, message, input] of cases) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
      await expect(provider.embed(input ?? ['a'])).rejects.toThrow(message);
    }
  });

  it('names the expected dimension in the mismatch error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply([{ index: 0, embedding: Array.from({ length: 768 }, (_, i) => i) }])));
    await expect(new RemoteEmbedProvider(config()).embed(['a'])).rejects.toThrow('(got 768)');
  });
});
