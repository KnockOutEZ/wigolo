import { describe, it, expect, beforeAll, vi } from 'vitest';
import { TransformersRerankProvider } from '../../../src/search/reranker/transformers-rerank-provider.js';

// Mock @huggingface/transformers so tests don't hit huggingface.co.
// The real provider uses AutoTokenizer + AutoModelForSequenceClassification
// to feed query/document pairs to a cross-encoder and read logits directly.
vi.mock('@huggingface/transformers', () => {
  // Minimal tensor stub: 1-D logits with .data array.
  const makeLogits = (values: number[]) => ({
    data: new Float32Array(values),
    dims: [values.length, 1],
  });

  const tokenizerCall = vi.fn(
    (text: string | string[], opts?: { text_pair?: string | string[] }) => {
      const queries = Array.isArray(text) ? text : [text];
      const docs = Array.isArray(opts?.text_pair)
        ? (opts?.text_pair as string[])
        : opts?.text_pair !== undefined
          ? [opts.text_pair as string]
          : queries.map(() => '');
      // Pretend each row has a token count = doc.length (so we can map
      // deterministically in the model stub).
      return {
        __pairs: queries.map((q, i) => ({ q, d: docs[i] ?? '' })),
        input_ids: { dims: [queries.length, 16] },
        attention_mask: { dims: [queries.length, 16] },
      };
    },
  );

  const AutoTokenizer = {
    from_pretrained: vi.fn(async () => tokenizerCall),
  };

  // The model when called with inputs returns { logits } where logits.data
  // is a Float32Array of size [batch, 1]. We score by document length so
  // tests can predict order deterministically.
  const modelCall = vi.fn(async (inputs: { __pairs: { q: string; d: string }[] }) => {
    const scores = inputs.__pairs.map((p) => p.d.length / 1000);
    return { logits: makeLogits(scores) };
  });

  const AutoModelForSequenceClassification = {
    from_pretrained: vi.fn(async () => modelCall),
  };

  return {
    AutoTokenizer,
    AutoModelForSequenceClassification,
    // env is touched by some code paths; expose a minimal stub.
    env: {
      cacheDir: '',
      allowRemoteModels: true,
      allowLocalModels: true,
    },
  };
});

describe('TransformersRerankProvider (static)', () => {
  it('exposes modelId without warmup', () => {
    const p = new TransformersRerankProvider();
    expect(p.modelId).toMatch(/ms-marco|mxbai|MiniLM/i);
  });
});

describe('TransformersRerankProvider (mocked runtime)', () => {
  let provider: TransformersRerankProvider;
  beforeAll(async () => {
    provider = new TransformersRerankProvider();
    await provider.warmup();
  });

  it('returns results in score-descending order', async () => {
    const results = await provider.rerank('test query', [
      { id: 'a', text: 'short' },
      { id: 'b', text: 'medium length text' },
      { id: 'c', text: 'a much longer text that has more characters here' },
    ]);
    expect(results.map((r) => r.id)).toEqual(['c', 'b', 'a']);
  });

  it('respects topK', async () => {
    const results = await provider.rerank(
      'test',
      [
        { id: 'a', text: 'one' },
        { id: 'b', text: 'two' },
        { id: 'c', text: 'three' },
      ],
      2,
    );
    expect(results).toHaveLength(2);
  });

  it('handles empty candidate list', async () => {
    const results = await provider.rerank('test', []);
    expect(results).toEqual([]);
  });

  it('returns numeric scores per candidate', async () => {
    const results = await provider.rerank('q', [
      { id: 'a', text: 'aaaa' },
      { id: 'b', text: 'bbbbbbbb' },
    ]);
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(typeof r.score).toBe('number');
      expect(Number.isFinite(r.score)).toBe(true);
    }
  });
});

// Gated runtime test (real model download).  Only runs when explicitly
// requested because it pulls ~22MB from huggingface.co.
describe.skipIf(!process.env.RUN_TRANSFORMERS)('TransformersRerankProvider (real model)', () => {
  it('reranks against a real model with sensible ordering', async () => {
    const p = new TransformersRerankProvider();
    await p.warmup();
    const results = await p.rerank('what is TypeScript', [
      { id: 'unrelated', text: 'the weather is nice today' },
      { id: 'related', text: 'TypeScript adds static typing to JavaScript' },
    ]);
    expect(results[0].id).toBe('related');
  }, 60_000);
});
