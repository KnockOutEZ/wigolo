import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initDatabase, closeDatabase } from '../../src/cache/db.js';
import { cacheContent, updateCacheEmbedding, getEmbeddingForUrl, getAllEmbeddings } from '../../src/cache/store.js';
import { VectorIndex } from '../../src/embedding/vector-index.js';
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

describe('Embedding integration: SQLite + VectorIndex', () => {
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

  function generateVector(dims: number, seed: number): Float32Array {
    const v = new Float32Array(dims);
    for (let i = 0; i < dims; i++) {
      v[i] = Math.sin(seed * (i + 1) * 0.1);
    }
    let norm = 0;
    for (let i = 0; i < dims; i++) norm += v[i] * v[i];
    norm = Math.sqrt(norm);
    for (let i = 0; i < dims; i++) v[i] /= norm;
    return v;
  }

  it('end-to-end: cache page -> embed -> load into VectorIndex -> findSimilar', () => {
    const dims = 384;
    const urls = [
      'https://react.dev/hooks',
      'https://vuejs.org/composition',
      'https://svelte.dev/stores',
    ];

    for (const url of urls) {
      seedPage(url, `Content about ${url}`);
    }

    for (let i = 0; i < urls.length; i++) {
      const vector = generateVector(dims, i + 1);
      const buffer = Buffer.from(vector.buffer);
      updateCacheEmbedding(urls[i], buffer, 'bge-small-en-v1.5', dims);
    }

    for (const url of urls) {
      const emb = getEmbeddingForUrl(url);
      expect(emb).not.toBeNull();
      expect(emb!.dims).toBe(dims);
    }

    const index = new VectorIndex();
    const allEmb = getAllEmbeddings();
    expect(allEmb).toHaveLength(3);

    const loaded = index.loadFromBuffers(allEmb.map(e => ({
      url: e.normalizedUrl,
      embedding: e.embedding,
      dims: e.dims,
    })));
    expect(loaded).toBe(3);
    expect(index.size()).toBe(3);

    const queryVector = generateVector(dims, 1);
    const results = index.findSimilar(queryVector, 3);

    expect(results.length).toBe(3);
    expect(results[0].score).toBeCloseTo(1.0, 2);
  });

  it('VectorIndex excludeUrls excludes specific URLs', () => {
    const dims = 8;
    const index = new VectorIndex();

    index.add('https://include.com', generateVector(dims, 1));
    index.add('https://exclude.com', generateVector(dims, 1));
    index.add('https://other.com', generateVector(dims, 3));

    const query = generateVector(dims, 1);
    const results = index.findSimilar(query, 10, new Set(['https://exclude.com']));

    expect(results.every(r => r.url !== 'https://exclude.com')).toBe(true);
    expect(results.length).toBe(2);
  });

  it('embedding update overwrites previous vector', () => {
    seedPage('https://mutable.com', 'Original content');

    const dims = 4;
    const v1 = new Float32Array([1, 0, 0, 0]);
    const v2 = new Float32Array([0, 0, 0, 1]);

    updateCacheEmbedding('https://mutable.com', Buffer.from(v1.buffer), 'model-a', dims);

    let emb = getEmbeddingForUrl('https://mutable.com');
    expect(emb!.model).toBe('model-a');

    updateCacheEmbedding('https://mutable.com', Buffer.from(v2.buffer), 'model-b', dims);

    emb = getEmbeddingForUrl('https://mutable.com');
    expect(emb!.model).toBe('model-b');

    const index = new VectorIndex();
    const stored = getAllEmbeddings();
    index.loadFromBuffers(stored.map(e => ({
      url: e.normalizedUrl,
      embedding: e.embedding,
      dims: e.dims,
    })));

    const results = index.findSimilar(new Float32Array([0, 0, 0, 1]), 1);
    expect(results[0].url).toContain('mutable.com');
    expect(results[0].score).toBeCloseTo(1.0, 4);
  });

  it('large number of embeddings loads correctly', () => {
    const dims = 16;
    const count = 100;

    for (let i = 0; i < count; i++) {
      seedPage(`https://page${i}.com`, `Content ${i}`);
      const vector = generateVector(dims, i + 1);
      updateCacheEmbedding(`https://page${i}.com`, Buffer.from(vector.buffer), 'model', dims);
    }

    const all = getAllEmbeddings();
    expect(all.length).toBe(count);

    const index = new VectorIndex();
    index.loadFromBuffers(all.map(e => ({
      url: e.normalizedUrl,
      embedding: e.embedding,
      dims: e.dims,
    })));

    expect(index.size()).toBe(count);

    const query = generateVector(dims, 43);
    const results = index.findSimilar(query, 5);
    expect(results.length).toBe(5);
    for (const r of results) {
      expect(isNaN(r.score)).toBe(false);
    }
  });

  it('pages without embeddings are excluded from getAllEmbeddings', () => {
    seedPage('https://embedded.com', 'Has embedding');
    seedPage('https://plain.com', 'No embedding');

    const vector = generateVector(4, 1);
    updateCacheEmbedding('https://embedded.com', Buffer.from(vector.buffer), 'model', 4);

    const all = getAllEmbeddings();
    expect(all).toHaveLength(1);
    expect(all[0].normalizedUrl).toContain('embedded.com');
  });

  it('cosine similarity math is correct for known vectors', () => {
    const index = new VectorIndex();

    const v = new Float32Array([0.6, 0.8, 0, 0]);
    index.add('https://same.com', v);

    const results = index.findSimilar(v, 1);
    expect(results[0].score).toBeCloseTo(1.0, 5);

    index.add('https://ortho.com', new Float32Array([0, 0, 1, 0]));
    const results2 = index.findSimilar(v, 2);
    const orthoResult = results2.find(r => r.url === 'https://ortho.com');
    expect(orthoResult!.score).toBeCloseTo(0.0, 5);
  });

  it('handles concurrent embedding updates without corruption', async () => {
    const dims = 4;
    seedPage('https://concurrent.com', 'Concurrent test');

    const promises = Array.from({ length: 10 }, (_, i) => {
      const v = new Float32Array([i * 0.1, 1 - i * 0.1, 0, 0]);
      return Promise.resolve(
        updateCacheEmbedding('https://concurrent.com', Buffer.from(v.buffer), `model-${i}`, dims),
      );
    });

    await Promise.all(promises);

    const emb = getEmbeddingForUrl('https://concurrent.com');
    expect(emb).not.toBeNull();
    expect(emb!.dims).toBe(dims);
  });
});
