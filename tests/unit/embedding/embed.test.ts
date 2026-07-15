import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EmbedProvider } from '../../../src/providers/embed-provider.js';
import type { VectorStore } from '../../../src/providers/vector-store.js';

vi.mock('../../../src/cache/store.js', () => ({
  updateCacheEmbedding: vi.fn().mockReturnValue(true),
  getAllEmbeddings: vi.fn().mockReturnValue([]),
  normalizeUrl: vi.fn((url: string) => url),
}));

const mockStoreState: {
  store: VectorStore;
  records: Map<string, { vector: Float32Array; metadata: { url: string; contentHash: string; modelId: string } }>;
} = {
  records: new Map(),
  store: {
    upsert: vi.fn(),
    delete: vi.fn(),
    size: vi.fn(),
    search: vi.fn(),
  },
};

mockStoreState.store.upsert = vi.fn(async (records) => {
  for (const r of records) {
    mockStoreState.records.set(r.id, { vector: r.vector, metadata: r.metadata });
  }
});
mockStoreState.store.delete = vi.fn(async (ids) => {
  for (const id of ids) mockStoreState.records.delete(id);
});
mockStoreState.store.size = vi.fn(async () => mockStoreState.records.size);
mockStoreState.store.search = vi.fn(async (_q, limit) => {
  return [...mockStoreState.records.entries()].slice(0, limit).map(([id, v]) => ({
    id,
    score: 0.9,
    metadata: v.metadata,
  }));
});

vi.mock('../../../src/providers/vector-store.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/providers/vector-store.js')>(
    '../../../src/providers/vector-store.js',
  );
  return {
    ...actual,
    getVectorStore: vi.fn(async () => mockStoreState.store),
  };
});

vi.mock('../../../src/config.js', () => ({
  getConfig: vi.fn().mockReturnValue({
    dataDir: '/tmp/wigolo-test',
    embeddingModel: 'BAAI/bge-small-en-v1.5',
  }),
}));

const logSpy = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};
vi.mock('../../../src/logger.js', () => ({
  createLogger: () => logSpy,
}));

import { updateCacheEmbedding, getAllEmbeddings } from '../../../src/cache/store.js';

interface MockProvider extends EmbedProvider {
  embed: ReturnType<typeof vi.fn>;
}

function makeMockProvider(overrides: Partial<MockProvider> = {}): MockProvider {
  const defaultVector = new Float32Array(384).fill(0.1);
  return {
    modelId: 'BGE-small-en-v1.5',
    dim: 384,
    embed: vi.fn().mockResolvedValue([defaultVector]),
    ...overrides,
  };
}

describe('EmbeddingService', () => {
  let EmbeddingService: typeof import('../../../src/embedding/embed.js').EmbeddingService;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockStoreState.records.clear();
    logSpy.debug.mockClear();
    logSpy.info.mockClear();
    logSpy.warn.mockClear();
    logSpy.error.mockClear();
    vi.mocked(getAllEmbeddings).mockReturnValue([]);
    vi.mocked(updateCacheEmbedding).mockReturnValue(true);
    const mod = await import('../../../src/embedding/embed.js');
    EmbeddingService = mod.EmbeddingService;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('embedAndStore computes embedding and updates cache', async () => {
    const provider = makeMockProvider();
    const service = new EmbeddingService(provider);
    await service.init();

    await service.embedAndStore('https://example.com', 'Hello world content');

    expect(provider.embed).toHaveBeenCalledWith(['Hello world content']);
    expect(updateCacheEmbedding).toHaveBeenCalledWith(
      'https://example.com',
      expect.any(Buffer),
      'BGE-small-en-v1.5',
      384,
    );
  });

  it('embedAndStore adds vector to in-memory index', async () => {
    const service = new EmbeddingService(makeMockProvider());
    await service.init();

    await service.embedAndStore('https://example.com', 'Content');

    const index = service.getIndex();
    expect(index.has('https://example.com')).toBe(true);
    expect(index.size()).toBe(1);
  });

  it('embedAndStore handles provider error gracefully', async () => {
    const provider = makeMockProvider({
      embed: vi.fn().mockRejectedValue(new Error('provider crashed')),
    });
    const service = new EmbeddingService(provider);
    await service.init();

    await expect(service.embedAndStore('https://error.com', 'Content')).resolves.not.toThrow();
  });

  it('embedAndStore skips when service marked unavailable', async () => {
    const provider = makeMockProvider();
    const service = new EmbeddingService(provider);
    service.setAvailable(false);

    await service.embedAndStore('https://skip.com', 'Content');

    expect(provider.embed).not.toHaveBeenCalled();
    expect(updateCacheEmbedding).not.toHaveBeenCalled();
  });

  it('embedAndStore handles empty text', async () => {
    const provider = makeMockProvider();
    const service = new EmbeddingService(provider);
    await service.init();

    await service.embedAndStore('https://empty.com', '');

    expect(provider.embed).toHaveBeenCalled();
  });

  it('findSimilar delegates to VectorStore', async () => {
    const provider = makeMockProvider();
    const service = new EmbeddingService(provider);
    await service.init();

    await service.embedAndStore('https://example.com', 'Content about TypeScript');

    const results = await service.findSimilar('TypeScript', 5);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].url).toBe('https://example.com');
  });

  it('findSimilar returns empty when index is empty', async () => {
    const service = new EmbeddingService(makeMockProvider());
    await service.init();

    const results = await service.findSimilar('query', 5);
    expect(results).toEqual([]);
  });

  it('findSimilar returns empty when service unavailable', async () => {
    const service = new EmbeddingService(makeMockProvider());
    service.setAvailable(false);

    const results = await service.findSimilar('query', 5);
    expect(results).toEqual([]);
  });

  it('init loads existing embeddings from database filtered by current modelId', async () => {
    vi.mocked(getAllEmbeddings).mockReturnValue([
      {
        normalizedUrl: 'https://cached.com',
        embedding: Buffer.from(new Float32Array(384).buffer),
        model: 'BGE-small-en-v1.5',
        dims: 384,
      },
    ]);

    const service = new EmbeddingService(makeMockProvider());
    await service.init();

    expect(getAllEmbeddings).toHaveBeenCalledWith('BGE-small-en-v1.5');
    const index = service.getIndex();
    expect(index.has('https://cached.com')).toBe(true);
    expect(index.size()).toBe(1);
  });

  it('shutdown clears index and marks unavailable', async () => {
    const service = new EmbeddingService(makeMockProvider());
    await service.init();

    await service.embedAndStore('https://example.com', 'Content');
    service.shutdown();

    expect(service.getIndex().size()).toBe(0);
    expect(service.isAvailable()).toBe(false);
  });

  it('embedAsync does not block caller', async () => {
    let resolveEmbed: (v: Float32Array[]) => void = () => {};
    const provider = makeMockProvider({
      embed: vi.fn().mockReturnValue(new Promise<Float32Array[]>(resolve => {
        resolveEmbed = resolve;
      })),
    });
    const service = new EmbeddingService(provider);
    // skip init() to avoid awaiting the probe-embed that uses our gated promise
    service.setAvailable(true);

    const start = Date.now();
    service.embedAsync('https://slow.com', 'Slow content');
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(50);

    resolveEmbed([new Float32Array(384).fill(0.1)]);
    await new Promise(r => setTimeout(r, 10));
  });

  it('handles concurrent embedAndStore calls', async () => {
    const provider = makeMockProvider({
      embed: vi.fn().mockImplementation(async () => [new Float32Array(384).fill(0.1)]),
    });
    const service = new EmbeddingService(provider);
    await service.init();

    const promises = [
      service.embedAndStore('https://a.com', 'Content A'),
      service.embedAndStore('https://b.com', 'Content B'),
      service.embedAndStore('https://c.com', 'Content C'),
    ];

    await Promise.all(promises);

    expect(service.getIndex().size()).toBe(3);
    expect(updateCacheEmbedding).toHaveBeenCalledTimes(3);
  });

  it('init does NOT probe the provider (lazy) so isSubprocessReady stays false until first use', async () => {
    const provider = makeMockProvider();
    const service = new EmbeddingService(provider);

    await service.init();

    // Lazy: boot init must not touch the ONNX provider. The ~150-200MB idle
    // win depends on this — the probe embed() only fires on first real use.
    expect(provider.embed).not.toHaveBeenCalled();
    expect(service.isSubprocessReady()).toBe(false);

    await service.ensureProviderReady();
    expect(provider.embed).toHaveBeenCalledWith(['embedding service probe']);
    expect(service.isSubprocessReady()).toBe(true);
  });

  describe('ensureProviderReady (lazy provider probe)', () => {
    it('probes the provider exactly once across concurrent callers', async () => {
      let resolveEmbed: (v: Float32Array[]) => void = () => {};
      const probeVector = new Float32Array(384).fill(0.1);
      const provider = makeMockProvider({
        embed: vi.fn().mockImplementation(
          () => new Promise<Float32Array[]>(resolve => { resolveEmbed = resolve; }),
        ),
      });
      const service = new EmbeddingService(provider);
      await service.init();

      const a = service.ensureProviderReady();
      const b = service.ensureProviderReady();
      resolveEmbed([probeVector]);
      const [ra, rb] = await Promise.all([a, b]);

      expect(ra).toBe(true);
      expect(rb).toBe(true);
      // Exactly one probe embed() despite two concurrent callers.
      expect(provider.embed).toHaveBeenCalledTimes(1);
    });

    it('emits exactly ONE model-load stderr line across concurrent first uses', async () => {
      let resolveEmbed: (v: Float32Array[]) => void = () => {};
      const provider = makeMockProvider({
        embed: vi.fn().mockImplementation(
          () => new Promise<Float32Array[]>(resolve => { resolveEmbed = resolve; }),
        ),
      });
      const service = new EmbeddingService(provider);
      await service.init();

      const a = service.ensureProviderReady();
      const b = service.ensureProviderReady();
      resolveEmbed([new Float32Array(384).fill(0.1)]);
      await Promise.all([a, b]);

      const loadLines = logSpy.info.mock.calls.filter(
        c => typeof c[0] === 'string' && /loading embedding model/i.test(c[0]),
      );
      expect(loadLines).toHaveLength(1);
    });

    it('does not re-probe once verified (memoized success)', async () => {
      const provider = makeMockProvider();
      const service = new EmbeddingService(provider);
      await service.init();

      await service.ensureProviderReady();
      await service.ensureProviderReady();
      await service.ensureProviderReady();

      expect(provider.embed).toHaveBeenCalledTimes(1);
    });

    it('memoizes a failed load for 60s then retries after the window', async () => {
      vi.useFakeTimers();
      try {
        const provider = makeMockProvider({
          embed: vi.fn().mockRejectedValue(new Error('onnx load failed')),
        });
        const service = new EmbeddingService(provider);
        await service.init();

        const first = await service.ensureProviderReady();
        expect(first).toBe(false);
        expect(provider.embed).toHaveBeenCalledTimes(1);

        // Immediate retry within the memo window does NOT re-probe.
        const second = await service.ensureProviderReady();
        expect(second).toBe(false);
        expect(provider.embed).toHaveBeenCalledTimes(1);

        // After the 60s memo window, the next use retries.
        vi.advanceTimersByTime(60_001);
        const third = await service.ensureProviderReady();
        expect(third).toBe(false);
        expect(provider.embed).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('latches off after 3 failed attempts with an actionable message', async () => {
      vi.useFakeTimers();
      try {
        const provider = makeMockProvider({
          embed: vi.fn().mockRejectedValue(new Error('onnx load failed')),
        });
        const service = new EmbeddingService(provider);
        await service.init();

        await service.ensureProviderReady();
        vi.advanceTimersByTime(60_001);
        await service.ensureProviderReady();
        vi.advanceTimersByTime(60_001);
        await service.ensureProviderReady();
        expect(provider.embed).toHaveBeenCalledTimes(3);

        // Latched: further attempts never re-probe, even past the window.
        vi.advanceTimersByTime(60_001);
        const latched = await service.ensureProviderReady();
        expect(latched).toBe(false);
        expect(provider.embed).toHaveBeenCalledTimes(3);

        // isAvailable flips off once latched.
        expect(service.isAvailable()).toBe(false);

        // Actionable error names the warmup fix.
        const errCalls = logSpy.error.mock.calls
          .map(c => JSON.stringify(c))
          .filter(s => /wigolo warmup --embeddings/.test(s));
        expect(errCalls.length).toBeGreaterThan(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('isAvailable stays true while the provider is healthy (not latched)', async () => {
      const service = new EmbeddingService(makeMockProvider());
      await service.init();
      expect(service.isAvailable()).toBe(true);
      await service.ensureProviderReady();
      expect(service.isAvailable()).toBe(true);
    });

    it('regression: fresh service embedAsync writes a vector WITHOUT any prior find_similar/probe call', async () => {
      const provider = makeMockProvider();
      const service = new EmbeddingService(provider);
      await service.init();

      // No ensureProviderReady()/findSimilar() call precedes this — the hoist
      // inside embedAsync must prime the provider on its own.
      service.embedAsync('https://fresh.example.com', 'Fresh content to embed');

      // Drain the fire-and-forget embed.
      await vi.waitFor(() => {
        expect(mockStoreState.records.has('https://fresh.example.com')).toBe(true);
      });
      expect(updateCacheEmbedding).toHaveBeenCalledWith(
        'https://fresh.example.com',
        expect.any(Buffer),
        'BGE-small-en-v1.5',
        384,
      );
    });
  });
});
