import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '../../../src/cache/db.js';
import { cacheContent, updateCacheEmbedding, getEmbeddingForUrl, getAllEmbeddings } from '../../../src/cache/store.js';
import { resetConfig } from '../../../src/config.js';
import type { RawFetchResult, ExtractionResult } from '../../../src/types.js';

function seedPage(url: string): void {
  const raw: RawFetchResult = {
    url,
    finalUrl: url,
    html: '<html><body>test</body></html>',
    contentType: 'text/html',
    statusCode: 200,
    method: 'http',
    headers: {},
  };
  const extraction: ExtractionResult = {
    title: 'Test Page',
    markdown: 'Test content for embedding',
    metadata: {},
    links: [],
    images: [],
    extractor: 'defuddle',
  };
  cacheContent(raw, extraction);
}

describe('updateCacheEmbedding', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    resetConfig();
    initDatabase(':memory:');
    seedPage('https://example.com/page');
  });

  afterEach(() => {
    closeDatabase();
    process.env = originalEnv;
    resetConfig();
  });

  it('updates embedding for an existing cached URL', () => {
    const vector = new Float32Array([0.5, 0.3, 0.1]);
    const buffer = Buffer.from(vector.buffer);

    const updated = updateCacheEmbedding('https://example.com/page', buffer, 'bge-small-en-v1.5', 3);
    expect(updated).toBe(true);

    const db = getDatabase();
    const row = db.prepare(
      'SELECT embedding, embedding_model, embedding_dims FROM url_cache WHERE normalized_url = ?',
    ).get('https://example.com/page') as { embedding: Buffer; embedding_model: string; embedding_dims: number };

    expect(row.embedding_model).toBe('bge-small-en-v1.5');
    expect(row.embedding_dims).toBe(3);
  });

  it('returns false for non-existent URL', () => {
    const vector = new Float32Array([0.1]);
    const buffer = Buffer.from(vector.buffer);

    const updated = updateCacheEmbedding('https://nonexistent.com', buffer, 'bge-small-en-v1.5', 1);
    expect(updated).toBe(false);
  });

  it('overwrites existing embedding', () => {
    const v1 = Buffer.from(new Uint8Array([1, 2, 3, 4]));
    const v2 = Buffer.from(new Uint8Array([5, 6, 7, 8]));

    const r1 = updateCacheEmbedding('https://example.com/page', v1, 'model-a', 2);
    expect(r1).toBe(true);

    const r2 = updateCacheEmbedding('https://example.com/page', v2, 'model-b', 2);
    expect(r2).toBe(true);

    const result = getEmbeddingForUrl('https://example.com/page');
    expect(result).not.toBeNull();
    expect(result!.model).toBe('model-b');
  });

  it('handles empty buffer gracefully', () => {
    const updated = updateCacheEmbedding('https://example.com/page', Buffer.alloc(0), 'model', 0);
    expect(updated).toBe(true);
  });
});

describe('getEmbeddingForUrl', () => {
  beforeEach(() => {
    initDatabase(':memory:');
    resetConfig();

    seedPage('https://example.com/embedded');

    const vector = new Float32Array([0.1, 0.2, 0.3]);
    updateCacheEmbedding('https://example.com/embedded', Buffer.from(vector.buffer), 'bge-small-en-v1.5', 3);
  });

  afterEach(() => {
    closeDatabase();
    resetConfig();
  });

  it('returns embedding data for a URL with embedding', () => {
    const result = getEmbeddingForUrl('https://example.com/embedded');
    expect(result).not.toBeNull();
    expect(result!.model).toBe('bge-small-en-v1.5');
    expect(result!.dims).toBe(3);
    expect(result!.embedding).toBeInstanceOf(Buffer);
  });

  it('returns null for URL without embedding', () => {
    seedPage('https://example.com/no-emb');

    const result = getEmbeddingForUrl('https://example.com/no-emb');
    expect(result).toBeNull();
  });

  it('returns null for non-existent URL', () => {
    const result = getEmbeddingForUrl('https://nonexistent.com');
    expect(result).toBeNull();
  });
});

describe('getAllEmbeddings', () => {
  beforeEach(() => {
    initDatabase(':memory:');
    resetConfig();
  });

  afterEach(() => {
    closeDatabase();
    resetConfig();
  });

  it('returns all URLs with embeddings', () => {
    for (const url of ['https://a.com', 'https://b.com']) {
      seedPage(url);
      const v = new Float32Array([0.1, 0.2]);
      updateCacheEmbedding(url, Buffer.from(v.buffer), 'model', 2);
    }

    seedPage('https://c.com');

    const all = getAllEmbeddings();
    expect(all).toHaveLength(2);
    expect(all.every(e => e.embedding !== null)).toBe(true);
  });

  it('returns empty array when no embeddings exist', () => {
    expect(getAllEmbeddings()).toEqual([]);
  });
});
