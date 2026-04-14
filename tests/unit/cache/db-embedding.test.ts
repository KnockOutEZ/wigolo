import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase, getDatabase, closeDatabase } from '../../../src/cache/db.js';

describe('embedding columns migration', () => {
  beforeEach(() => {
    initDatabase(':memory:');
  });

  afterEach(() => {
    closeDatabase();
  });

  it('url_cache table has embedding BLOB column', () => {
    const db = getDatabase();
    const columns = db.pragma('table_info(url_cache)') as Array<{ name: string; type: string }>;
    const embeddingCol = columns.find(c => c.name === 'embedding');
    expect(embeddingCol).toBeDefined();
    expect(embeddingCol!.type).toBe('BLOB');
  });

  it('url_cache table has embedding_model TEXT column', () => {
    const db = getDatabase();
    const columns = db.pragma('table_info(url_cache)') as Array<{ name: string; type: string }>;
    const modelCol = columns.find(c => c.name === 'embedding_model');
    expect(modelCol).toBeDefined();
    expect(modelCol!.type).toBe('TEXT');
  });

  it('url_cache table has embedding_dims INTEGER column', () => {
    const db = getDatabase();
    const columns = db.pragma('table_info(url_cache)') as Array<{ name: string; type: string }>;
    const dimsCol = columns.find(c => c.name === 'embedding_dims');
    expect(dimsCol).toBeDefined();
    expect(dimsCol!.type).toBe('INTEGER');
  });

  it('can insert and retrieve embedding data', () => {
    const db = getDatabase();

    const vector = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    const buffer = Buffer.from(vector.buffer);

    db.prepare(`
      INSERT INTO url_cache (url, normalized_url, title, markdown, raw_html,
        metadata, links, images, fetch_method, extractor_used,
        content_hash, fetched_at, embedding, embedding_model, embedding_dims)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?)
    `).run(
      'https://test.com', 'https://test.com', 'Test', 'content', '<html>',
      '{}', '[]', '[]', 'http', 'defuddle',
      'abc123', buffer, 'bge-small-en-v1.5', 4,
    );

    const row = db.prepare(
      'SELECT embedding, embedding_model, embedding_dims FROM url_cache WHERE url = ?',
    ).get('https://test.com') as { embedding: Buffer; embedding_model: string; embedding_dims: number };

    expect(row.embedding_model).toBe('bge-small-en-v1.5');
    expect(row.embedding_dims).toBe(4);

    const retrieved = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding_dims);
    expect(retrieved[0]).toBeCloseTo(0.1);
    expect(retrieved[1]).toBeCloseTo(0.2);
    expect(retrieved[2]).toBeCloseTo(0.3);
    expect(retrieved[3]).toBeCloseTo(0.4);
  });

  it('embedding columns default to NULL', () => {
    const db = getDatabase();

    db.prepare(`
      INSERT INTO url_cache (url, normalized_url, title, markdown, raw_html,
        metadata, links, images, fetch_method, extractor_used,
        content_hash, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      'https://noembedding.com', 'https://noembedding.com', 'No Emb', '', '',
      '{}', '[]', '[]', 'http', 'defuddle', 'hash123',
    );

    const row = db.prepare(
      'SELECT embedding, embedding_model, embedding_dims FROM url_cache WHERE url = ?',
    ).get('https://noembedding.com') as { embedding: null; embedding_model: null; embedding_dims: null };

    expect(row.embedding).toBeNull();
    expect(row.embedding_model).toBeNull();
    expect(row.embedding_dims).toBeNull();
  });

  it('migration is idempotent (calling initDatabase twice does not error)', () => {
    closeDatabase();
    expect(() => initDatabase(':memory:')).not.toThrow();

    const db = getDatabase();
    const columns = db.pragma('table_info(url_cache)') as Array<{ name: string }>;
    const hasEmbedding = columns.some(c => c.name === 'embedding');
    expect(hasEmbedding).toBe(true);
  });
});
