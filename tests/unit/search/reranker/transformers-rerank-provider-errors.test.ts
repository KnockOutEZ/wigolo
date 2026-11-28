import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@huggingface/transformers', () => ({
  AutoTokenizer: { from_pretrained: vi.fn() },
  AutoModelForSequenceClassification: { from_pretrained: vi.fn() },
  env: { cacheDir: '' },
}));

import {
  AutoTokenizer,
  AutoModelForSequenceClassification,
} from '@huggingface/transformers';
import { TransformersRerankProvider } from '../../../../src/search/reranker/transformers-rerank-provider.js';

const tk = vi.mocked(AutoTokenizer.from_pretrained);
const mdl = vi.mocked(AutoModelForSequenceClassification.from_pretrained);

describe('TransformersRerankProvider error wrapping', () => {
  beforeEach(() => {
    tk.mockReset();
    mdl.mockReset();
  });

  it('wraps tokenizer_class TypeError as actionable "run wigolo warmup"', async () => {
    const cause = new TypeError(
      "Cannot read properties of undefined (reading 'tokenizer_class')",
    );
    tk.mockRejectedValue(cause);
    mdl.mockRejectedValue(cause);

    const provider = new TransformersRerankProvider();
    await expect(provider.warmup()).rejects.toThrow(
      /Reranker model not downloaded — run `wigolo warmup`/,
    );
  });

  it('wraps fetch failed as actionable warmup hint', async () => {
    tk.mockRejectedValue(new TypeError('fetch failed'));
    mdl.mockRejectedValue(new TypeError('fetch failed'));
    const provider = new TransformersRerankProvider();
    await expect(provider.warmup()).rejects.toThrow(/wigolo warmup/);
  });

  it('wraps ENOTFOUND DNS failure as actionable warmup hint', async () => {
    const err = Object.assign(new Error('getaddrinfo ENOTFOUND huggingface.co'), { code: 'ENOTFOUND' });
    tk.mockRejectedValue(err);
    mdl.mockRejectedValue(err);
    const provider = new TransformersRerankProvider();
    await expect(provider.warmup()).rejects.toThrow(/wigolo warmup/);
  });

  it('passes through unrelated errors with a generic prefix', async () => {
    tk.mockRejectedValue(new RangeError('out of memory'));
    mdl.mockRejectedValue(new RangeError('out of memory'));
    const provider = new TransformersRerankProvider();
    await expect(provider.warmup()).rejects.toThrow(
      /Failed to load reranker model: out of memory/,
    );
  });

  it('allows a fresh load attempt after a prior failure', async () => {
    tk.mockRejectedValueOnce(new TypeError('fetch failed'));
    mdl.mockRejectedValueOnce(new TypeError('fetch failed'));
    const provider = new TransformersRerankProvider();
    await expect(provider.warmup()).rejects.toThrow(/wigolo warmup/);

    // Second call should hit the mocks again (loadPromise cleared).
    tk.mockRejectedValueOnce(new RangeError('different failure'));
    mdl.mockRejectedValueOnce(new RangeError('different failure'));
    await expect(provider.warmup()).rejects.toThrow(/different failure/);
  });

  it('a load that resolves after dispose() releases the model instead of publishing it', async () => {
    // WHY: the reranker readiness budget can expire while the model download is
    // still in flight. The provider is then disposed, and the load resolves
    // late. Publishing that model would leave the weights resident with no
    // owner to release them, so the late resolve must release it instead.
    const model = { dispose: vi.fn(async () => undefined) };
    const tokenizer = { some: 'tokenizer' };
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    tk.mockImplementation(() => gate.then(() => tokenizer) as never);
    mdl.mockImplementation(() => gate.then(() => model) as never);

    const provider = new TransformersRerankProvider();
    const warmup = provider.warmup();
    // Dispose while the load is still in flight.
    await provider.dispose();
    release();

    await expect(warmup).rejects.toThrow(/disposed during initialization/);
    // The late-resolved model was released, not kept resident.
    expect(model.dispose).toHaveBeenCalledTimes(1);
  });
});
