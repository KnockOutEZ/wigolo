import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EmbedProvider } from '../../../src/providers/embed-provider.js';
import type { VectorStore } from '../../../src/providers/vector-store.js';

// The factory is the single owner of the embed model in production. The
// service must resolve through it on every use, so a release by the idle
// timer is picked up by the next call.
const h = vi.hoisted(() => ({
  getEmbedProvider: vi.fn(),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../src/providers/embed-provider.js', () => ({
  getEmbedProvider: h.getEmbedProvider,
}));

vi.mock('../../../src/cache/store.js', () => ({
  updateCacheEmbedding: vi.fn().mockReturnValue(true),
  getAllEmbeddings: vi.fn().mockReturnValue([]),
  normalizeUrl: vi.fn((url: string) => url),
}));

const store: VectorStore = {
  upsert: vi.fn(async () => undefined),
  delete: vi.fn(async () => undefined),
  size: vi.fn(async () => 0),
  search: vi.fn(async () => []),
};

vi.mock('../../../src/providers/vector-store.js', () => ({
  getVectorStore: vi.fn(async () => store),
}));

vi.mock('../../../src/logger.js', () => ({
  createLogger: () => h.log,
}));

import { EmbeddingService } from '../../../src/embedding/embed.js';
import { getAllEmbeddings } from '../../../src/cache/store.js';

interface MockProvider extends EmbedProvider {
  embed: ReturnType<typeof vi.fn>;
}

function makeProvider(modelId = 'BGE-small-en-v1.5'): MockProvider {
  return {
    modelId,
    dim: 384,
    embed: vi.fn(async () => [new Float32Array(384).fill(0.1)]),
  };
}

describe('EmbeddingService provider resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.getEmbedProvider.mockReset();
    vi.mocked(getAllEmbeddings).mockReturnValue([]);
  });

  it('resolves the provider through the factory instead of building its own', async () => {
    const provider = makeProvider();
    h.getEmbedProvider.mockResolvedValue(provider);

    const service = new EmbeddingService();
    await service.init();
    await service.embedAndStore('https://example.com/a', 'Body A');

    expect(h.getEmbedProvider).toHaveBeenCalled();
    expect(provider.embed).toHaveBeenCalledWith(['Body A']);
  });

  it('picks up a rebuilt provider after the factory released the old one', async () => {
    const first = makeProvider('model-one');
    const second = makeProvider('model-two');
    let current = first;
    h.getEmbedProvider.mockImplementation(async () => current);

    const service = new EmbeddingService();
    await service.init();

    await service.embedAndStore('https://example.com/a', 'Body A');
    expect(first.embed).toHaveBeenCalledWith(['Body A']);

    // The idle timer released `first`; the factory now builds `second`.
    current = second;
    await service.embedAndStore('https://example.com/b', 'Body B');

    expect(second.embed).toHaveBeenCalledWith(['Body B']);
    expect(first.embed).not.toHaveBeenCalledWith(['Body B']);
  });

  it('keeps an injected provider and never calls the factory', async () => {
    const injected = makeProvider();

    const service = new EmbeddingService(injected);
    await service.init();
    await service.embedAndStore('https://example.com/a', 'Body A');

    expect(h.getEmbedProvider).not.toHaveBeenCalled();
    expect(injected.embed).toHaveBeenCalledWith(['Body A']);
  });

  it('migrates legacy rows with the bundled model id and no provider load', async () => {
    h.getEmbedProvider.mockResolvedValue(makeProvider());

    const service = new EmbeddingService();
    await service.init();

    expect(getAllEmbeddings).toHaveBeenCalledWith('BGE-small-en-v1.5');
    expect(h.getEmbedProvider).not.toHaveBeenCalled();
  });
});