import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
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

vi.mock('../../../src/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { updateCacheEmbedding, getAllEmbeddings } from '../../../src/cache/store.js';

// embed is a mock typed to the REAL embed() signature, so MockProvider stays assignable to
// EmbedProvider (a bare `ReturnType<typeof vi.fn>` is not — it produced TS2430 + per-instantiation
// TS2345 across this file).
interface MockProvider extends Omit<EmbedProvider, 'embed'> {
  embed: Mock<EmbedProvider['embed']>;
}

function makeMockProvider(overrides: Partial<MockProvider> = {}): MockProvider {
  const defaultVector = new Float32Array(384).fill(0.1);
  return {
    modelId: 'BGE-small-en-v1.5',
    dim: 384,
    embed: vi.fn<EmbedProvider['embed']>().mockResolvedValue([defaultVector]),
    ...overrides,
  };
}

describe('EmbeddingService', () => {
  let EmbeddingService: typeof import('../../../src/embedding/embed.js').EmbeddingService;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockStoreState.records.clear();
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

  it('init() does NOT block on the provider embed probe (a cold model load must not stall MCP initialize)', async () => {
    // The probe used to be awaited inside init(); on a cold data dir that load/download blocked
    // `initialize` indefinitely. init() must now return without waiting on the probe — the
    // provider lazy-loads on first real embed, and the probe just flips providerVerified async.
    let resolveProbe: (v: Float32Array[]) => void = () => {};
    const provider = makeMockProvider({
      embed: vi.fn().mockReturnValue(new Promise<Float32Array[]>((r) => { resolveProbe = r; })),
    });
    const service = new EmbeddingService(provider);

    const start = Date.now();
    await service.init(); // resolves WITHOUT awaiting the gated probe
    expect(Date.now() - start).toBeLessThan(100);
    expect(service.isAvailable()).toBe(true); // available immediately
    expect(service.isSubprocessReady()).toBe(false); // probe still in flight → not yet verified

    resolveProbe([new Float32Array(384).fill(0.1)]); // probe completes…
    await new Promise((r) => setTimeout(r, 10));
    expect(service.isSubprocessReady()).toBe(true); // …flips verified asynchronously
  }, 2000);

  it('a FAILED probe degrades but does not disable: service stays available, embedAndStore still works and self-heals providerVerified', async () => {
    // The background probe rejects (e.g. a transient cold-load error). init() must still complete
    // (handled — no unhandled rejection), the service stays available, and a later real embed both
    // works (indexing not gated on the probe) AND self-heals providerVerified so find_similar
    // doesn't stay dark for the process lifetime if only the probe lost the race.
    const provider = makeMockProvider({
      embed: vi
        .fn()
        .mockRejectedValueOnce(new Error('probe load failed'))
        .mockResolvedValue([new Float32Array(384).fill(0.1)]),
    });
    const service = new EmbeddingService(provider);
    await service.init();
    await new Promise((r) => setTimeout(r, 10)); // let the failing probe settle

    expect(service.isAvailable()).toBe(true); // a failed probe does NOT disable the service
    expect(service.isSubprocessReady()).toBe(false); // …but it's not yet verified

    await service.embedAndStore('https://x.com', 'content'); // a real embed succeeds
    expect(service.getIndex().has('https://x.com')).toBe(true); // indexing works despite the failed probe
    expect(service.isSubprocessReady()).toBe(true); // self-healed — a successful embed proves the provider works
  });

  it('isSubprocessReady flips true once the async provider probe lands (not synchronously at init)', async () => {
    const service = new EmbeddingService(makeMockProvider());
    expect(service.isSubprocessReady()).toBe(false);
    await service.init();
    await new Promise((r) => setTimeout(r, 0)); // the probe verifies asynchronously
    expect(service.isSubprocessReady()).toBe(true);
  });
});
