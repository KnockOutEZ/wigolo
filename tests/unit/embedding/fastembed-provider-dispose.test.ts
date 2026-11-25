import { describe, it, expect, vi, beforeEach } from 'vitest';

// `fastembed` is mocked: these tests cover the model lifetime, not the ONNX
// download. Each `FlagEmbedding.init` call represents one resident model.
const h = vi.hoisted(() => ({
  initCalls: 0,
  gate: null as null | { resolve: () => void; promise: Promise<void> },
  // Held open by a test so an `embed()` stays in flight; `dispose()` must
  // settle that call before it releases the session.
  embedGate: null as null | { resolve: () => void; promise: Promise<void> },
  // Held open by a test so a deferred session release stays pending; a second
  // `embed()` can then start inside that window.
  releaseGate: null as null | { resolve: () => void; promise: Promise<void> },
  sessionRelease: vi.fn(async () => {
    if (h.releaseGate) await h.releaseGate.promise;
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

// Flush every pending microtask: a macrotask boundary runs after the whole
// microtask queue, so settlement checks cannot race the implementation.
function flush(): Promise<void> {
  return new Promise<void>((r) => { setTimeout(r, 0); });
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
    h.releaseGate = null;
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

  it('waits for an in-flight embed on a resident model, then releases it', async () => {
    const provider = new FastembedEmbedProvider();
    // Make the model resident first, so the drain has a session to guard.
    await provider.embed(['first']);

    h.embedGate = heldGate();
    const inFlight = provider.embed(['second']);
    // Start the release without awaiting it: it must wait for the call above.
    const disposing = provider.dispose();
    let disposedSettled = false;
    void disposing.then(() => { disposedSettled = true; });

    await Promise.resolve();
    expect(disposedSettled).toBe(false);
    expect(h.sessionRelease).not.toHaveBeenCalled();

    h.embedGate.resolve();
    await Promise.all([inFlight, disposing]);

    // The resident model is released once, and only after the embed settles.
    expect(h.order).toEqual(['embed resolved', 'embed resolved', 'release']);
    expect(h.sessionRelease).toHaveBeenCalledTimes(1);
  });

  it('keeps the drain waiter armed when an embed starts during a deferred release', async () => {
    h.gate = heldGate();
    const provider = new FastembedEmbedProvider();
    // Start a load, then release while it is still loading: its resolve lands
    // after the release, so its session is deferred, not published.
    const first = provider.embed(['first']);
    const disposing = provider.dispose();
    let disposedSettled = false;
    void disposing.then(() => { disposedSettled = true; });

    // Hold the deferred release open so a new embed can start inside it.
    h.releaseGate = heldGate();
    h.gate.resolve();
    for (let i = 0; i < 50 && h.sessionRelease.mock.calls.length === 0; i++) {
      await Promise.resolve();
    }
    // Fail here, not on a hung suite, if the deferred release never starts.
    expect(h.sessionRelease).toHaveBeenCalledTimes(1);

    // The stale session is now released for real. A second embed starts while
    // that release is still pending.
    h.embedGate = heldGate();
    const second = provider.embed(['second']);

    await Promise.resolve();
    expect(disposedSettled).toBe(false);

    // The deferred release finished, but the second embed is still in flight.
    // The waiter must stay armed, so the release stays pending.
    h.releaseGate.resolve();
    await flush();
    expect(disposedSettled).toBe(false);
    expect(h.sessionRelease).toHaveBeenCalledTimes(1);

    // The second embed settles, and only then does the release finish.
    h.embedGate.resolve();
    await Promise.all([first, second, disposing]);

    expect(disposedSettled).toBe(true);
    expect(h.sessionRelease).toHaveBeenCalledTimes(1);
  });
});
