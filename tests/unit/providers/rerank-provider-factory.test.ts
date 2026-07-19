import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getRerankProvider,
  _resetRerankProviderForTest,
  isTransientFetchError,
  withFetchRetry,
} from '../../../src/providers/rerank-provider.js';
import { TransformersRerankProvider } from '../../../src/search/reranker/transformers-rerank-provider.js';

// Mock TransformersRerankProvider so the factory test doesn't pull a real
// model from huggingface.co. We only assert the factory wires the right
// class and memoizes its result.
vi.mock('../../../src/search/reranker/transformers-rerank-provider.js', () => {
  const TransformersRerankProvider = vi.fn(function (
    this: Record<string, unknown>,
  ) {
    this.modelId = 'Xenova/ms-marco-MiniLM-L-6-v2';
    this.warmup = vi.fn().mockResolvedValue(undefined);
    this.rerank = vi.fn().mockResolvedValue([]);
  });
  return { TransformersRerankProvider };
});

describe('getRerankProvider', () => {
  beforeEach(() => { _resetRerankProviderForTest(); });
  afterEach(() => { _resetRerankProviderForTest(); });

  it('returns TransformersRerankProvider', async () => {
    expect(await getRerankProvider()).toBeInstanceOf(TransformersRerankProvider);
  });

  it('memoizes the resolved provider', async () => {
    const a = await getRerankProvider();
    const b = await getRerankProvider();
    expect(a).toBe(b);
  });

  it('retries the model warmup when it fails transiently (field: reranker "fetch failed"), then resolves', async () => {
    // WHY (field bug, Windows): the cross-encoder model fetch failed on a network
    // blip and the whole warmup gave up. A transient fetch failure must retry.
    let n = 0;
    vi.mocked(TransformersRerankProvider).mockImplementationOnce(function (
      this: Record<string, unknown>,
    ) {
      this.modelId = 'Xenova/ms-marco-MiniLM-L-6-v2';
      this.rerank = vi.fn().mockResolvedValue([]);
      this.warmup = vi.fn(async () => {
        n += 1;
        if (n === 1) throw new Error('fetch failed');
      });
    } as unknown as () => void);

    const p = await getRerankProvider();

    expect(p).toBeInstanceOf(TransformersRerankProvider);
    expect(n).toBe(2);
  });
});

describe('isTransientFetchError (3d)', () => {
  it('flags network/fetch blips that a retry can recover', () => {
    expect(isTransientFetchError(new Error('fetch failed'))).toBe(true);
    expect(isTransientFetchError(new Error('ECONNRESET'))).toBe(true);
    expect(isTransientFetchError(new Error('getaddrinfo ENOTFOUND huggingface.co'))).toBe(true);
    expect(isTransientFetchError(new Error('socket hang up'))).toBe(true);
  });

  it('does NOT flag deterministic errors (a retry would not help)', () => {
    expect(isTransientFetchError(new Error('unsupported model architecture'))).toBe(false);
    expect(isTransientFetchError(new Error('unexpected rerank shape'))).toBe(false);
  });
});

describe('withFetchRetry (3d)', () => {
  const noSleep = async () => {};

  it('retries a transient failure and returns the eventual success', async () => {
    let n = 0;
    const op = vi.fn(async () => {
      n += 1;
      if (n < 3) throw new Error('fetch failed');
      return 'ok';
    });
    const r = await withFetchRetry(op, { attempts: 3, sleep: noSleep });
    expect(r).toBe('ok');
    expect(op).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry a non-transient failure', async () => {
    const op = vi.fn(async () => {
      throw new Error('unsupported model architecture');
    });
    await expect(withFetchRetry(op, { attempts: 3, sleep: noSleep })).rejects.toThrow(/unsupported/);
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('gives up after the attempt budget and throws the last error', async () => {
    const op = vi.fn(async () => {
      throw new Error('fetch failed');
    });
    await expect(withFetchRetry(op, { attempts: 2, sleep: noSleep })).rejects.toThrow(/fetch failed/);
    expect(op).toHaveBeenCalledTimes(2);
  });
});
