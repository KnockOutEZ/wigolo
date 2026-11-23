import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  options: [] as Array<Record<string, unknown>>,
  maxLength: 512 as number,
  // Padded length of the batch when no `max_length` is given.
  longest: 200,
}));

vi.mock('@huggingface/transformers', () => ({
  AutoTokenizer: {
    from_pretrained: vi.fn(async () =>
      Object.assign(
        (texts: string[], options: Record<string, unknown>) => {
          h.options.push(options);
          const len = typeof options.max_length === 'number' ? options.max_length : h.longest;
          return { input_ids: { dims: [texts.length, len] } };
        },
        { model_max_length: 512 },
      ),
    ),
  },
  AutoModelForSequenceClassification: {
    from_pretrained: vi.fn(async () => async () => ({ logits: { data: [2, 1], dims: [2, 1] } })),
  },
  env: { cacheDir: '' },
}));

vi.mock('../../../../src/config.js', () => ({
  getConfig: () => ({ dataDir: '/tmp/wigolo-rerank-max-length-test', rerankerMaxLength: h.maxLength }),
}));

import { TransformersRerankProvider } from '../../../../src/search/reranker/transformers-rerank-provider.js';

const candidates = [
  { id: 'a', text: 'first document' },
  { id: 'b', text: 'second document' },
];

async function tokenizerCalls(maxLength: number, longest = 200): Promise<Array<Record<string, unknown>>> {
  h.maxLength = maxLength;
  h.longest = longest;
  h.options.length = 0;
  const results = await new TransformersRerankProvider().rerank('query', candidates);
  expect(results.map((r) => r.id)).toEqual(['a', 'b']);
  return [...h.options];
}

describe('TransformersRerankProvider rerankerMaxLength', () => {
  beforeEach(() => {
    h.options.length = 0;
  });

  it('re-tokenizes with the cap when the longest pair exceeds it', async () => {
    const calls = await tokenizerCalls(128, 200);
    expect(calls).toHaveLength(2);
    expect(calls[0]).not.toHaveProperty('max_length');
    expect(calls[1]).toMatchObject({ truncation: true, padding: true, max_length: 128 });
  });

  it('keeps longest-pair padding when every pair fits under the cap', async () => {
    const calls = await tokenizerCalls(128, 60);
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toHaveProperty('max_length');
  });

  it('leaves the default path alone: the default cap equals the model limit', async () => {
    const calls = await tokenizerCalls(512, 512);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ truncation: true, padding: true });
    expect(calls[0]).not.toHaveProperty('max_length');
  });

  it('ignores a cap that is not positive', async () => {
    const calls = await tokenizerCalls(0, 200);
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toHaveProperty('max_length');
  });

  it('rounds a fractional cap down to an integer', async () => {
    const calls = await tokenizerCalls(100.5, 200);
    expect(calls[calls.length - 1]).toMatchObject({ max_length: 100 });
  });
});
