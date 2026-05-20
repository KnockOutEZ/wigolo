import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getRerankProvider,
  _resetRerankProviderForTest,
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
});
