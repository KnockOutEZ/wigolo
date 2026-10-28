import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The config module is mocked, so the timeout values are the test's to choose.
const h = vi.hoisted(() => ({
  config: { reranker: 'onnx', rerankerIdleTimeoutMs: 1000, embeddingIdleTimeoutMs: 2000 },
  rerank: vi.fn(async () => [{ id: '0', score: 1 }]),
  rerankDispose: vi.fn(async () => undefined),
  rerankDisposed: [] as unknown[],
  embed: vi.fn(async (texts: string[]) => texts.map(() => new Float32Array(384))),
  embedDispose: vi.fn(async () => undefined),
  embedDisposed: [] as unknown[],
}));

vi.mock('../../../src/config.js', () => ({
  getConfig: () => h.config,
}));

vi.mock('../../../src/search/reranker/transformers-rerank-provider.js', () => ({
  TransformersRerankProvider: class {
    readonly modelId = 'test-reranker';
    async warmup(): Promise<void> {}
    rerank(query: string, candidates: unknown[], topK?: number): Promise<unknown> {
      return h.rerank.call(null, query, candidates, topK) as Promise<unknown>;
    }
    dispose(): Promise<void> {
      h.rerankDisposed.push(this);
      return h.rerankDispose();
    }
  },
}));

vi.mock('../../../src/embedding/fastembed-provider.js', () => ({
  FastembedEmbedProvider: class {
    readonly modelId = 'test-embed';
    readonly dim = 384;
    async warmup(): Promise<void> {}
    embed(texts: string[]): Promise<Float32Array[]> {
      return h.embed(texts);
    }
    dispose(): Promise<void> {
      h.embedDisposed.push(this);
      return h.embedDispose();
    }
  },
}));

import {
  getRerankProvider,
  disposeRerankProvider,
  _resetRerankProviderForTest,
} from '../../../src/providers/rerank-provider.js';
import {
  getEmbedProvider,
  disposeEmbedProvider,
  _resetEmbedProviderForTest,
} from '../../../src/providers/embed-provider.js';

const candidate = [{ id: '0', text: 'hello' }];

describe('rerank provider idle unload', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    h.config.rerankerIdleTimeoutMs = 1000;
    h.rerank.mockClear();
    h.rerankDispose.mockClear();
    h.rerankDisposed.length = 0;
  });

  afterEach(() => {
    _resetRerankProviderForTest();
    vi.useRealTimers();
  });

  it('disposes the model after the idle timeout and rebuilds on the next call', async () => {
    const first = await getRerankProvider();
    await first.rerank('q', candidate);
    expect(h.rerankDispose).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    expect(h.rerankDispose).toHaveBeenCalledTimes(1);

    const second = await getRerankProvider();
    expect(second).not.toBe(first);
    await second.rerank('q', candidate);
    expect(h.rerank).toHaveBeenCalledTimes(2);
  });

  it('keeps the model loaded while calls keep arriving inside the window', async () => {
    const provider = await getRerankProvider();
    await provider.rerank('q', candidate);
    await vi.advanceTimersByTimeAsync(900);

    await provider.rerank('q', candidate);
    await vi.advanceTimersByTimeAsync(900);
    expect(h.rerankDispose).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);
    expect(h.rerankDispose).toHaveBeenCalledTimes(1);
  });

  it('does not dispose while a call is still running', async () => {
    const provider = await getRerankProvider();
    h.rerank.mockImplementationOnce(() => new Promise(() => {}) as Promise<[] | { id: string; score: number }[]>);
    void provider.rerank('q', candidate);

    await vi.advanceTimersByTimeAsync(5000);
    expect(h.rerankDispose).not.toHaveBeenCalled();
  });

  it('unloads a model that warmup loaded and no call followed', async () => {
    // The onnx branch warms the model eagerly, so the countdown must start at
    // creation or the weights wait for a rerank() call that may never come.
    await getRerankProvider();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.rerankDispose).toHaveBeenCalledTimes(1);
  });

  it('stays loaded when the timeout is disabled', async () => {    h.config.rerankerIdleTimeoutMs = 0;
    const provider = await getRerankProvider();
    await provider.rerank('q', candidate);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.rerankDispose).not.toHaveBeenCalled();
  });

  it('cancels the countdown on explicit dispose', async () => {
    const provider = await getRerankProvider();
    await provider.rerank('q', candidate);
    await disposeRerankProvider();
    expect(h.rerankDispose).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.rerankDispose).toHaveBeenCalledTimes(1);
  });

  it('does not let a retained handle dispose a newer provider', async () => {
    const first = await getRerankProvider();
    await first.rerank('q', candidate);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.rerankDispose).toHaveBeenCalledTimes(1);
    const firstProvider = h.rerankDisposed[0];

    const second = await getRerankProvider();
    await second.rerank('q', candidate);
    await vi.advanceTimersByTimeAsync(999);

    // A retained handle re-arms its old clock.
    await first.rerank('q', candidate);
    await vi.advanceTimersByTimeAsync(1);

    // The newer provider's own countdown fires. The stale clock must not
    // cancel it and must not release the newer provider.
    expect(h.rerankDispose).toHaveBeenCalledTimes(2);
    const secondProvider = h.rerankDisposed[1];
    expect(secondProvider).not.toBe(firstProvider);

    // The stale clock fires next. It releases only its own provider.
    await vi.advanceTimersByTimeAsync(999);
    expect(h.rerankDispose).toHaveBeenCalledTimes(3);
    expect(h.rerankDisposed[2]).toBe(firstProvider);
    expect(h.rerankDisposed.filter((p) => p === secondProvider)).toHaveLength(1);
  });

  it('clears the cache when its own handle is released', async () => {
    const provider = await getRerankProvider();
    await disposeRerankProvider(provider);
    expect(h.rerankDispose).toHaveBeenCalledTimes(1);

    const fresh = await getRerankProvider();
    expect(fresh).not.toBe(provider);
  });
});

describe('embed provider idle unload', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    h.config.embeddingIdleTimeoutMs = 2000;
    h.embed.mockClear();
    h.embedDispose.mockClear();
    h.embedDisposed.length = 0;
  });

  afterEach(() => {
    _resetEmbedProviderForTest();
    vi.useRealTimers();
  });

  it('drops the model after the idle timeout and rebuilds on the next call', async () => {
    const first = await getEmbedProvider();
    await first.embed(['hello']);
    expect(first.dim).toBe(384);
    expect(first.modelId).toBe('test-embed');

    await vi.advanceTimersByTimeAsync(2000);
    const second = await getEmbedProvider();
    expect(second).not.toBe(first);

    await second.embed(['hello']);
    expect(h.embed).toHaveBeenCalledTimes(2);
  });

  it('keeps the model loaded while calls keep arriving inside the window', async () => {
    const provider = await getEmbedProvider();
    await provider.embed(['one']);
    await vi.advanceTimersByTimeAsync(1900);

    await provider.embed(['two']);
    await vi.advanceTimersByTimeAsync(1900);

    const again = await getEmbedProvider();
    expect(again).toBe(provider);
  });

  it('cancels the countdown on explicit dispose', async () => {
    const provider = await getEmbedProvider();
    await provider.embed(['one']);
    await disposeEmbedProvider();

    const fresh = await getEmbedProvider();
    expect(fresh).not.toBe(provider);
  });

  it('does not let a retained handle dispose a newer provider', async () => {
    const first = await getEmbedProvider();
    await first.embed(['one']);
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.embedDispose).toHaveBeenCalledTimes(1);
    const firstProvider = h.embedDisposed[0];

    const second = await getEmbedProvider();
    await second.embed(['two']);
    await vi.advanceTimersByTimeAsync(1999);

    // A caller still holds the released handle and re-arms its old clock.
    await first.embed(['stale']);
    await vi.advanceTimersByTimeAsync(1);

    // The newer provider's own countdown fires; the stale clock must not add
    // a release for the newer provider and must not cancel this one.
    expect(h.embedDispose).toHaveBeenCalledTimes(2);
    const secondProvider = h.embedDisposed[1];
    expect(secondProvider).not.toBe(firstProvider);

    // The stale clock fires next and releases only its own provider.
    await vi.advanceTimersByTimeAsync(1999);
    expect(h.embedDispose).toHaveBeenCalledTimes(3);
    expect(h.embedDisposed[2]).toBe(firstProvider);
    expect(h.embedDisposed.filter((p) => p === secondProvider)).toHaveLength(1);
  });

  it('clears the cache when its own handle is released', async () => {
    const provider = await getEmbedProvider();
    await disposeEmbedProvider(provider);
    expect(h.embedDispose).toHaveBeenCalledTimes(1);

    const fresh = await getEmbedProvider();
    expect(fresh).not.toBe(provider);
  });
});