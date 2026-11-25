import { describe, it, expect, vi, beforeEach } from 'vitest';

// `fastembed` is mocked: these tests cover what reaches the model, not the
// ONNX download.
const h = vi.hoisted(() => ({
  seen: [] as string[][],
  maxTextLength: 10 as number | undefined,
}));

vi.mock('fastembed', () => ({
  FlagEmbedding: {
    init: vi.fn(async () => ({
      async *embed(texts: string[]) {
        h.seen.push([...texts]);
        yield texts.map(() => new Array(384).fill(0.5));
      },
    })),
  },
  EmbeddingModel: { BGESmallENV15: 'BGESmallENV15' },
}));

vi.mock('../../../src/config.js', () => ({
  getConfig: () => ({ dataDir: '/tmp/wigolo-max-length-test', embeddingMaxTextLength: h.maxTextLength }),
}));

import { FastembedEmbedProvider } from '../../../src/embedding/fastembed-provider.js';

describe('FastembedEmbedProvider embeddingMaxTextLength', () => {
  beforeEach(() => {
    h.seen.length = 0;
    h.maxTextLength = 10;
  });

  it('trims inputs longer than the cap before they reach the model', async () => {
    const vectors = await new FastembedEmbedProvider().embed(['x'.repeat(25), 'short']);
    expect(h.seen).toEqual([['x'.repeat(10), 'short']]);
    expect(vectors).toHaveLength(2);
  });

  it('leaves inputs alone when the cap is not positive', async () => {
    h.maxTextLength = 0;
    await new FastembedEmbedProvider().embed(['x'.repeat(25)]);
    expect(h.seen).toEqual([['x'.repeat(25)]]);
  });
});
