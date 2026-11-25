import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getEmbedProvider,
  _resetEmbedProviderForTest,
} from '../../../src/providers/embed-provider.js';
import { FastembedEmbedProvider } from '../../../src/embedding/fastembed-provider.js';
import { resetConfig } from '../../../src/config.js';

vi.mock('../../../src/embedding/fastembed-provider.js', () => {
  const FastembedEmbedProvider = vi.fn(function (this: Record<string, unknown>) {
    this.modelId = 'BGE-small-en-v1.5';
    this.dim = 384;
    this.warmup = vi.fn().mockResolvedValue(undefined);
    this.embed = vi.fn().mockResolvedValue([]);
  });
  return { FastembedEmbedProvider };
});

describe('getEmbedProvider', () => {
  beforeEach(() => {
    delete process.env.WIGOLO_EMBEDDING_API_BASE;
    _resetEmbedProviderForTest();
  });
  afterEach(() => {
    _resetEmbedProviderForTest();
    delete process.env.WIGOLO_EMBEDDING_API_BASE;
    resetConfig();
    vi.unstubAllGlobals();
  });

  it('returns FastembedEmbedProvider', async () => {
    expect(await getEmbedProvider()).toBeInstanceOf(FastembedEmbedProvider);
  });

  it('memoizes the resolved provider', async () => {
    const a = await getEmbedProvider();
    const b = await getEmbedProvider();
    expect(a).toBe(b);
  });

  it('returned provider has a numeric dim after warmup', async () => {
    const p = await getEmbedProvider();
    expect(typeof p.dim).toBe('number');
    expect(p.dim).toBe(384);
  });

  it('uses the remote provider when an embedding API base is set', async () => {
    process.env.WIGOLO_EMBEDDING_API_BASE = 'http://127.0.0.1:8080/v1';
    resetConfig();
    const embedding = Array.from({ length: 384 }, () => 0.5);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ index: 0, embedding }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const p = await getEmbedProvider();
    expect(p.modelId).toBe('BAAI/bge-small-en-v1.5 @ http://127.0.0.1:8080/v1');
    expect(p.dim).toBe(384);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('recovers cache after warmup failure', async () => {
    // First call: warmup throws so the factory rejects.
    vi.mocked(FastembedEmbedProvider).mockImplementationOnce(function (this: Record<string, unknown>) {
      this.modelId = 'BGE-small-en-v1.5';
      this.dim = 384;
      this.warmup = vi.fn().mockRejectedValue(new Error('warmup failed'));
      this.embed = vi.fn().mockResolvedValue([]);
    });
    await expect(getEmbedProvider()).rejects.toThrow('warmup failed');

    // Second call: cache must have been cleared; file-level default mock takes
    // over and the factory succeeds.
    expect(await getEmbedProvider()).toBeInstanceOf(FastembedEmbedProvider);
  });
});
