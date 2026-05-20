import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initDatabase, closeDatabase } from '../../src/cache/db.js';
import {
  cacheContent,
  updateCacheEmbedding,
  getEmbeddingForUrl,
  getAllEmbeddings,
} from '../../src/cache/store.js';
import { resetConfig } from '../../src/config.js';
import type { RawFetchResult, ExtractionResult } from '../../src/types.js';

vi.mock('../../src/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('embedding cache invalidation across model change', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    resetConfig();
    initDatabase(':memory:');
  });

  afterEach(() => {
    closeDatabase();
    process.env = originalEnv;
    resetConfig();
  });

  function seedPage(url: string, markdown: string): void {
    const raw: RawFetchResult = {
      url,
      finalUrl: url,
      html: `<html><body>${markdown}</body></html>`,
      contentType: 'text/html',
      statusCode: 200,
      method: 'http',
      headers: {},
    };
    const extraction: ExtractionResult = {
      title: url,
      markdown,
      metadata: {},
      links: [],
      images: [],
      extractor: 'defuddle',
    };
    cacheContent(raw, extraction);
  }

  it('returns cache miss when stored modelId differs from current', () => {
    seedPage('https://example.com/a', 'page a');
    // Seed an embedding labelled with the legacy sentence-transformers model.
    const legacyVec = Buffer.from(new Float32Array(384).fill(0.1).buffer);
    updateCacheEmbedding('https://example.com/a', legacyVec, 'sentence-transformers/all-MiniLM-L6-v2', 384);

    // Query with the new fastembed model — expect cache miss.
    const miss = getEmbeddingForUrl('https://example.com/a', 'BGE-small-en-v1.5');
    expect(miss).toBeNull();

    // Query without modelId filter — entry should still be readable for legacy paths.
    const unfiltered = getEmbeddingForUrl('https://example.com/a');
    expect(unfiltered).not.toBeNull();
    expect(unfiltered?.model).toBe('sentence-transformers/all-MiniLM-L6-v2');
  });

  it('returns hit when stored modelId matches current', () => {
    seedPage('https://example.com/b', 'page b');
    const vec = Buffer.from(new Float32Array(384).fill(0.2).buffer);
    updateCacheEmbedding('https://example.com/b', vec, 'BGE-small-en-v1.5', 384);

    const hit = getEmbeddingForUrl('https://example.com/b', 'BGE-small-en-v1.5');
    expect(hit).not.toBeNull();
    expect(hit?.model).toBe('BGE-small-en-v1.5');
    expect(hit?.dims).toBe(384);
  });

  it('getAllEmbeddings filters by modelId when provided', () => {
    seedPage('https://example.com/legacy', 'legacy page');
    seedPage('https://example.com/new', 'new page');
    updateCacheEmbedding(
      'https://example.com/legacy',
      Buffer.from(new Float32Array(384).fill(0.1).buffer),
      'sentence-transformers/all-MiniLM-L6-v2',
      384,
    );
    updateCacheEmbedding(
      'https://example.com/new',
      Buffer.from(new Float32Array(384).fill(0.2).buffer),
      'BGE-small-en-v1.5',
      384,
    );

    const fastembedOnly = getAllEmbeddings('BGE-small-en-v1.5');
    expect(fastembedOnly).toHaveLength(1);
    expect(fastembedOnly[0].model).toBe('BGE-small-en-v1.5');

    const all = getAllEmbeddings();
    expect(all).toHaveLength(2);
  });
});
