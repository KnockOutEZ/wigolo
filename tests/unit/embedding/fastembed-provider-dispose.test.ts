import { describe, it, expect, vi, beforeEach } from 'vitest';

// `fastembed` is mocked: these tests cover the model lifetime, not the ONNX
// download. Each `FlagEmbedding.init` call represents one resident model.
const h = vi.hoisted(() => ({
  initCalls: 0,
  gate: null as null | { resolve: () => void; promise: Promise<void> },
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function fakeModel(): { embed: (texts: string[]) => AsyncGenerator<number[][]> } {
  return {
    async *embed(texts: string[]) {
      yield texts.map(() => new Array(384).fill(0.5));
    },
  };
}

vi.mock('fastembed', () => ({
  FlagEmbedding: {
    init: vi.fn(async () => {
      h.initCalls += 1;
      if (h.gate) await h.gate.promise;
      return fakeModel();
    }),
  },
  EmbeddingModel: { BGESmallENV15: 'BGESmallENV15' },
}));

vi.mock('../../../src/config.js', () => ({
  getConfig: () => ({ dataDir: '/tmp/wigolo-dispose-test' }),
}));

vi.mock('../../../src/logger.js', () => ({ createLogger: () => h.log }));

import { FastembedEmbedProvider, FASTEMBED_EMBED_MODEL_ID } from '../../../src/embedding/fastembed-provider.js';

describe('FastembedEmbedProvider.dispose', () => {
  beforeEach(() => {
    h.initCalls = 0;
    h.gate = null;
  });

  it('exposes the bundled model id as a constant', () => {
    expect(new FastembedEmbedProvider().modelId).toBe(FASTEMBED_EMBED_MODEL_ID);
  });

  it('releases the model so the next call loads it again', async () => {
    const provider = new FastembedEmbedProvider();
    await provider.embed(['first']);
    expect(h.initCalls).toBe(1);

    await provider.dispose();
    await provider.embed(['second']);

    expect(h.initCalls).toBe(2);
  });

  it('discards a load that resolves after the release', async () => {
    let release!: () => void;
    h.gate = { resolve: () => release(), promise: new Promise<void>(r => { release = r; }) };

    const provider = new FastembedEmbedProvider();
    const inFlight = provider.embed(['first']);
    // Release while the model is still loading.
    await provider.dispose();
    release();
    await inFlight;

    h.gate = null;
    await provider.embed(['second']);

    // The late resolve must not count as the resident model.
    expect(h.initCalls).toBe(2);
  });
});