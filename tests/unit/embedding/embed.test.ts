import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../src/embedding/subprocess.js', () => {
  return { EmbeddingSubprocess: vi.fn() };
});

vi.mock('../../../src/cache/store.js', () => ({
  updateCacheEmbedding: vi.fn().mockReturnValue(true),
  getAllEmbeddings: vi.fn().mockReturnValue([]),
  normalizeUrl: vi.fn((url: string) => url),
}));

vi.mock('../../../src/config.js', () => ({
  getConfig: vi.fn().mockReturnValue({
    embeddingModel: 'BAAI/bge-small-en-v1.5',
    embeddingIdleTimeoutMs: 120000,
    embeddingMaxTextLength: 8000,
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

import { EmbeddingSubprocess } from '../../../src/embedding/subprocess.js';
import { updateCacheEmbedding, getAllEmbeddings } from '../../../src/cache/store.js';

describe('EmbeddingService', () => {
  let EmbeddingService: any;
  let mockSubprocess: any;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Reset module mock return values (clearAllMocks only clears calls, not implementations)
    vi.mocked(getAllEmbeddings).mockReturnValue([]);
    vi.mocked(updateCacheEmbedding).mockReturnValue(true);

    mockSubprocess = {
      embed: vi.fn().mockResolvedValue({
        id: 'test',
        vector: new Array(384).fill(0.1),
      }),
      shutdown: vi.fn(),
      isAvailable: vi.fn().mockReturnValue(true),
      getDims: vi.fn().mockReturnValue(384),
      getModel: vi.fn().mockReturnValue('bge-small-en-v1.5'),
    };

    vi.mocked(EmbeddingSubprocess).mockImplementation(function () {
      return mockSubprocess;
    } as any);

    const mod = await import('../../../src/embedding/embed.js');
    EmbeddingService = mod.EmbeddingService;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('embedAndStore computes embedding and updates cache', async () => {
    const service = new EmbeddingService();
    await service.init();

    await service.embedAndStore('https://example.com', 'Hello world content');

    expect(mockSubprocess.embed).toHaveBeenCalledWith(
      expect.any(String),
      'Hello world content',
    );
    expect(updateCacheEmbedding).toHaveBeenCalledWith(
      'https://example.com',
      expect.any(Buffer),
      'bge-small-en-v1.5',
      384,
    );
  });

  it('embedAndStore adds vector to in-memory index', async () => {
    const service = new EmbeddingService();
    await service.init();

    await service.embedAndStore('https://example.com', 'Content');

    const index = service.getIndex();
    expect(index.has('https://example.com')).toBe(true);
    expect(index.size()).toBe(1);
  });

  it('embedAndStore handles subprocess error gracefully', async () => {
    mockSubprocess.embed.mockRejectedValue(new Error('subprocess crashed'));

    const service = new EmbeddingService();
    await service.init();

    await expect(service.embedAndStore('https://error.com', 'Content')).resolves.not.toThrow();
  });

  it('embedAndStore skips when subprocess not available', async () => {
    mockSubprocess.isAvailable.mockReturnValue(false);

    const service = new EmbeddingService();
    service.setAvailable(false);

    await service.embedAndStore('https://skip.com', 'Content');

    expect(mockSubprocess.embed).not.toHaveBeenCalled();
    expect(updateCacheEmbedding).not.toHaveBeenCalled();
  });

  it('embedAndStore handles empty text', async () => {
    const service = new EmbeddingService();
    await service.init();

    await service.embedAndStore('https://empty.com', '');

    expect(mockSubprocess.embed).toHaveBeenCalled();
  });

  it('findSimilar delegates to VectorIndex', async () => {
    const service = new EmbeddingService();
    await service.init();

    await service.embedAndStore('https://example.com', 'Content about TypeScript');

    mockSubprocess.embed.mockResolvedValue({
      id: 'query',
      vector: new Array(384).fill(0.1),
    });

    const results = await service.findSimilar('TypeScript', 5);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].url).toBe('https://example.com');
  });

  it('findSimilar returns empty when index is empty', async () => {
    const service = new EmbeddingService();
    await service.init();

    const results = await service.findSimilar('query', 5);
    expect(results).toEqual([]);
  });

  it('findSimilar returns empty when subprocess not available', async () => {
    mockSubprocess.isAvailable.mockReturnValue(false);

    const service = new EmbeddingService();
    service.setAvailable(false);

    const results = await service.findSimilar('query', 5);
    expect(results).toEqual([]);
  });

  it('init loads existing embeddings from database', async () => {
    vi.mocked(getAllEmbeddings).mockReturnValue([
      {
        normalizedUrl: 'https://cached.com',
        embedding: Buffer.from(new Float32Array(384).buffer),
        model: 'bge-small-en-v1.5',
        dims: 384,
      },
    ]);

    const service = new EmbeddingService();
    await service.init();

    const index = service.getIndex();
    expect(index.has('https://cached.com')).toBe(true);
    expect(index.size()).toBe(1);
  });

  it('shutdown cleans up subprocess and index', async () => {
    const service = new EmbeddingService();
    await service.init();

    await service.embedAndStore('https://example.com', 'Content');
    service.shutdown();

    expect(mockSubprocess.shutdown).toHaveBeenCalled();
    expect(service.getIndex().size()).toBe(0);
  });

  it('embedAsync does not block caller', async () => {
    const service = new EmbeddingService();
    await service.init();

    let resolveEmbed: () => void;
    mockSubprocess.embed.mockReturnValue(new Promise<void>((resolve) => {
      resolveEmbed = () => {
        resolve({ id: 'slow', vector: new Array(384).fill(0.1) } as any);
      };
    }));

    const start = Date.now();
    service.embedAsync('https://slow.com', 'Slow content');
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(50);

    resolveEmbed!();
    await new Promise(r => setTimeout(r, 10));
  });

  it('handles concurrent embedAndStore calls', async () => {
    let callCount = 0;
    mockSubprocess.embed.mockImplementation(async () => {
      callCount++;
      return { id: `call-${callCount}`, vector: new Array(384).fill(0.1 * callCount) };
    });

    const service = new EmbeddingService();
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

  it('generates unique request IDs', async () => {
    const ids = new Set<string>();
    mockSubprocess.embed.mockImplementation(async (id: string) => {
      ids.add(id);
      return { id, vector: [0.1] };
    });

    const service = new EmbeddingService();
    await service.init();

    await service.embedAndStore('https://a.com', 'A');
    await service.embedAndStore('https://b.com', 'B');

    expect(ids.size).toBe(2);
  });

  it('converts number[] vector to Float32Array for index', async () => {
    const service = new EmbeddingService();
    await service.init();

    await service.embedAndStore('https://example.com', 'Content');

    const index = service.getIndex();
    const results = index.findSimilar(new Float32Array(384).fill(0.1), 1);
    expect(results.length).toBe(1);
  });
});
