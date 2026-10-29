import { describe, it, expect, vi, beforeEach } from 'vitest';

// `fastembed` is mocked: these tests cover the model lifetime, not the ONNX
// download. Each `FlagEmbedding.init` call represents one resident model.
const h = vi.hoisted(() => ({
  initCalls: 0,
  gate: null as null | { resolve: () => void; promise: Promise<void> },
  // Held open by a test so an `embed()` stays in flight; `dispose()` must
  // settle that call before it releases the session.
  embedGate: null as null | { resolve: () => void; promise: Promise<void> },
  sessionRelease: vi.fn(async () => {
    h.order.push('release');
  }),
  // Records the observed order of events. The generator records its own
  // completion, so the order cannot depend on microtask interleaving.
  order: [] as string[],
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function fakeModel(): {
  embed: (texts: string[]) => AsyncGenerator<number[][]>;
  session: { release: () => Promise<void> };
} {
  return {
    // The private ONNX session, as the narrow cast in `releaseSession` reads it.
    session: { release: () => h.sessionRelease() },
    async *embed(texts: string[]) {
      if (h.embedGate) await h.embedGate.promise;
      yield texts.map(() => new Array(384).fill(0.5));
      h.order.push('embed resolved');
    },
  };
}

function heldGate(): { resolve: () => void; promise: Promise<void> } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { resolve, promise };
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
    h.embedGate = null;
    h.order.length = 0;
    h.sessionRelease.mockClear();
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

  it('releases the ONNX session on dispose', async () => {
    const provider = new FastembedEmbedProvider();
    await provider.embed(['first']);

    await provider.dispose();

    expect(h.sessionRelease).toHaveBeenCalledTimes(1);
  });

  it('discards a load that resolves after the release', async () => {
    h.gate = heldGate();

    const provider = new FastembedEmbedProvider();
    const inFlight = provider.embed(['first']);
    // Release while the model is still loading. The release waits for the call
    // that started the load, so the test must not await it before opening the
    // gate. The model built by the late resolve is never published, so its
    // own session must be released by the stale branch.
    const disposing = provider.dispose();
    h.gate.resolve();
    await Promise.all([inFlight, disposing]);

    expect(h.sessionRelease).toHaveBeenCalledTimes(1);

    h.gate = null;
    await provider.embed(['second']);

    // The late resolve must not count as the resident model.
    expect(h.initCalls).toBe(2);
  });

  it('waits for an in-flight embed, then releases the session', async () => {
    h.embedGate = heldGate();

    const provider = new FastembedEmbedProvider();
    const inFlight = provider.embed(['first']);
    // The call is in flight, so the release must wait for it before touching
    // the session. Start it without awaiting.
    const disposing = provider.dispose();
    let disposedSettled = false;
    void disposing.then(() => { disposedSettled = true; });

    await Promise.resolve();
    expect(disposedSettled).toBe(false);
    expect(h.order).toEqual([]);
    expect(h.sessionRelease).not.toHaveBeenCalled();

    h.embedGate.resolve();
    await Promise.all([inFlight, disposing]);

    // The in-flight call resolved first; only then was the session released.
    expect(h.order).toEqual(['embed resolved', 'release']);
    expect(h.sessionRelease).toHaveBeenCalledTimes(1);
  });
});
