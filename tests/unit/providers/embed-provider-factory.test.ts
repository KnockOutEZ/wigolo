import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getEmbedProvider,
  _resetEmbedProviderForTest,
} from '../../../src/providers/embed-provider.js';
import { LegacyEmbedProvider } from '../../../src/embedding/legacy-provider.js';
import { EmbeddingSubprocess } from '../../../src/embedding/subprocess.js';

vi.mock('../../../src/embedding/subprocess.js', () => {
  const EmbeddingSubprocess = vi.fn(function (this: Record<string, unknown>) {
    this.getDims = vi.fn().mockReturnValue(384);
    this.getModel = vi.fn().mockReturnValue('test-model');
    this.embed = vi.fn().mockResolvedValue({ id: 'warmup', vector: new Array(384).fill(0) });
    this.isAvailable = vi.fn().mockReturnValue(true);
    this.shutdown = vi.fn();
  });
  return { EmbeddingSubprocess };
});

describe('getEmbedProvider', () => {
  beforeEach(() => { _resetEmbedProviderForTest(); });
  afterEach(() => { _resetEmbedProviderForTest(); });

  it('returns LegacyEmbedProvider', async () => {
    expect(await getEmbedProvider()).toBeInstanceOf(LegacyEmbedProvider);
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
    // First call: subprocess warmup throws so the factory rejects.
    vi.mocked(EmbeddingSubprocess).mockImplementationOnce(function (this: Record<string, unknown>) {
      this.getDims = vi.fn().mockReturnValue(null);
      this.getModel = vi.fn().mockReturnValue(null);
      this.embed = vi.fn().mockRejectedValue(new Error('warmup failed'));
      this.isAvailable = vi.fn().mockReturnValue(false);
      this.shutdown = vi.fn();
    });
    await expect(getEmbedProvider()).rejects.toThrow('warmup failed');

    // Second call: cache must have been cleared; file-level default mock takes
    // over and the factory succeeds.
    expect(await getEmbedProvider()).toBeInstanceOf(LegacyEmbedProvider);
  });
});
