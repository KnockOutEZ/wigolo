import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getRerankProvider,
  _resetRerankProviderForTest,
  isTransientFetchError,
  withFetchRetry,
  withReadyTimeout,
  ReadyTimeoutError,
} from '../../../src/providers/rerank-provider.js';
import { TransformersRerankProvider } from '../../../src/search/reranker/transformers-rerank-provider.js';
import { RemoteRerankProvider } from '../../../src/search/reranker/remote-rerank-provider.js';
import { resetConfig } from '../../../src/config.js';

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
  beforeEach(() => { vi.mocked(TransformersRerankProvider).mockClear(); process.env.WIGOLO_RERANKER = 'onnx'; resetConfig(); _resetRerankProviderForTest(); });
  afterEach(() => { process.env.WIGOLO_RERANKER = 'none'; delete process.env.WIGOLO_RERANK_API_BASE; delete process.env.WIGOLO_RERANKER_READY_TIMEOUT_MS; resetConfig(); _resetRerankProviderForTest(); });

  it('returns TransformersRerankProvider', async () => {
    expect(await getRerankProvider()).toBeInstanceOf(TransformersRerankProvider);
  });

  it('memoizes the resolved provider', async () => {
    const a = await getRerankProvider();
    const b = await getRerankProvider();
    expect(a).toBe(b);
  });

  it('selects and memoizes remote without loading ONNX', async () => {
    process.env.WIGOLO_RERANKER = 'remote';
    process.env.WIGOLO_RERANK_API_BASE = 'http://127.0.0.1:8082/v1';
    resetConfig();
    const a = await getRerankProvider();
    expect(a).toBeInstanceOf(RemoteRerankProvider);
    expect(await getRerankProvider()).toBe(a);
    expect(TransformersRerankProvider).not.toHaveBeenCalled();
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

  it('fails the factory when the warmup outlives WIGOLO_RERANKER_READY_TIMEOUT_MS', async () => {
    // WHY: `rerankerReadyTimeoutMs` was declared in config.ts and had NO
    // consumer — a model download that HANGS (a blackholed network, not a
    // refused one) never rejects, so the warmup waited forever and every
    // search hung with it. The setting must bound that wait.
    vi.useFakeTimers();
    process.env.WIGOLO_RERANKER_READY_TIMEOUT_MS = '5000';
    resetConfig();
    vi.mocked(TransformersRerankProvider).mockImplementationOnce(function (
      this: Record<string, unknown>,
    ) {
      this.modelId = 'Xenova/ms-marco-MiniLM-L-6-v2';
      this.rerank = vi.fn().mockResolvedValue([]);
      // Never settles: the hang the timeout exists for.
      this.warmup = vi.fn(() => new Promise<void>(() => {}));
      this.dispose = vi.fn(async () => {});
    } as unknown as () => void);

    const outcome = getRerankProvider().then(
      (r) => ({ ok: true as const, r }),
      (e) => ({ ok: false as const, e }),
    );
    await vi.advanceTimersByTimeAsync(5001);
    const o = await outcome;
    expect(o.ok).toBe(false);
    if (!o.ok) {
      expect(o.e).toBeInstanceOf(ReadyTimeoutError);
      expect((o.e as Error).message).toMatch(/WIGOLO_RERANKER_READY_TIMEOUT_MS/);
    }
    vi.useRealTimers();
  });

  it('releases the provider when the readiness budget expires', async () => {
    // The warmup may still be in flight when the budget expires; the provider
    // must be released so a late resolve cannot leave the model resident with
    // nobody to unload it.
    vi.useFakeTimers();
    process.env.WIGOLO_RERANKER_READY_TIMEOUT_MS = '5000';
    resetConfig();
    const dispose = vi.fn(async () => {});
    vi.mocked(TransformersRerankProvider).mockImplementationOnce(function (
      this: Record<string, unknown>,
    ) {
      this.modelId = 'Xenova/ms-marco-MiniLM-L-6-v2';
      this.rerank = vi.fn().mockResolvedValue([]);
      this.warmup = vi.fn(() => new Promise<void>(() => {}));
      this.dispose = dispose;
    } as unknown as () => void);

    const outcome = getRerankProvider().catch(() => undefined);
    await vi.advanceTimersByTimeAsync(5001);
    await outcome;
    expect(dispose).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('a warmup that finishes inside the budget resolves normally', async () => {
    vi.useFakeTimers();
    process.env.WIGOLO_RERANKER_READY_TIMEOUT_MS = '5000';
    resetConfig();
    const p = getRerankProvider();
    await vi.advanceTimersByTimeAsync(10);
    expect(await p).toBeInstanceOf(TransformersRerankProvider);
    vi.useRealTimers();
  });
});

describe('withReadyTimeout (rerankerReadyTimeoutMs)', () => {
  it('fails with ReadyTimeoutError when the op outlives the budget', async () => {
    vi.useFakeTimers();
    const op = vi.fn(() => new Promise<string>(() => {}));
    const outcome = withReadyTimeout(op, 1000).then(
      (r) => ({ ok: true as const, r }),
      (e) => ({ ok: false as const, e }),
    );
    await vi.advanceTimersByTimeAsync(1001);
    const o = await outcome;
    expect(o.ok).toBe(false);
    if (!o.ok) expect(o.e).toBeInstanceOf(ReadyTimeoutError);
    vi.useRealTimers();
  });

  it('returns the op result when it finishes inside the budget', async () => {
    await expect(withReadyTimeout(async () => 'ok', 1000)).resolves.toBe('ok');
  });

  it('a non-positive timeout disables the bound', async () => {
    await expect(withReadyTimeout(async () => 'ok', 0)).resolves.toBe('ok');
    await expect(withReadyTimeout(async () => 'ok', -1)).resolves.toBe('ok');
  });

  it('a rejection from the op propagates unchanged', async () => {
    await expect(withReadyTimeout(async () => { throw new Error('boom'); }, 1000)).rejects.toThrow('boom');
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
