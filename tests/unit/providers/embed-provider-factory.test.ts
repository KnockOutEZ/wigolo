import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getEmbedProvider,
  _resetEmbedProviderForTest,
} from '../../../src/providers/embed-provider.js';
import { FastembedEmbedProvider } from '../../../src/embedding/fastembed-provider.js';

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
  beforeEach(() => { _resetEmbedProviderForTest(); });
  afterEach(() => { _resetEmbedProviderForTest(); });

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
