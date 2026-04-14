import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../src/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { VectorIndex, cosineSimilarity } from '../../../src/embedding/vector-index.js';

function toFloat32(values: number[]): Float32Array {
  return new Float32Array(values);
}

function normalize(v: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  const result = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) result[i] = v[i] / norm;
  return result;
}

describe('VectorIndex', () => {
  let index: VectorIndex;

  beforeEach(() => {
    index = new VectorIndex();
  });

  it('starts empty', () => {
    expect(index.size()).toBe(0);
  });

  it('adds vectors and reports correct size', () => {
    index.add('https://a.com', toFloat32([1, 0, 0]));
    index.add('https://b.com', toFloat32([0, 1, 0]));
    expect(index.size()).toBe(2);
  });

  it('removes vectors', () => {
    index.add('https://a.com', toFloat32([1, 0, 0]));
    index.add('https://b.com', toFloat32([0, 1, 0]));
    index.remove('https://a.com');
    expect(index.size()).toBe(1);
  });

  it('remove returns false for non-existent key', () => {
    index.add('https://a.com', toFloat32([1, 0, 0]));
    expect(index.remove('https://nonexistent.com')).toBe(false);
    expect(index.size()).toBe(1);
  });

  it('findSimilar returns results sorted by cosine similarity (descending)', () => {
    const va = normalize(toFloat32([1, 0, 0]));
    const vb = normalize(toFloat32([0.9, 0.1, 0]));
    const vc = normalize(toFloat32([0, 0, 1]));

    index.add('https://a.com', va);
    index.add('https://b.com', vb);
    index.add('https://c.com', vc);

    const query = normalize(toFloat32([1, 0.05, 0]));
    const results = index.findSimilar(query, 3);

    expect(results.length).toBe(3);
    expect(results[0].url).toBe('https://a.com');
    expect(results[1].url).toBe('https://b.com');
    expect(results[2].url).toBe('https://c.com');

    expect(results[0].score).toBeGreaterThan(results[1].score);
    expect(results[1].score).toBeGreaterThan(results[2].score);
  });

  it('findSimilar respects topK limit', () => {
    for (let i = 0; i < 10; i++) {
      const v = new Float32Array(3);
      v[i % 3] = 1;
      index.add(`https://example.com/${i}`, v);
    }

    const query = toFloat32([1, 0, 0]);
    const results = index.findSimilar(query, 3);

    expect(results.length).toBe(3);
  });

  it('findSimilar returns empty for empty index', () => {
    const query = toFloat32([1, 0, 0]);
    const results = index.findSimilar(query, 5);
    expect(results).toEqual([]);
  });

  it('findSimilar excludes URLs in excludeUrls set', () => {
    index.add('https://allowed.com', normalize(toFloat32([1, 0, 0])));
    index.add('https://blocked.com', normalize(toFloat32([0.99, 0.01, 0])));
    index.add('https://other.com', normalize(toFloat32([0, 1, 0])));

    const query = normalize(toFloat32([1, 0, 0]));
    const results = index.findSimilar(query, 10, new Set(['https://blocked.com']));

    expect(results.length).toBe(2);
    expect(results.every(r => r.url !== 'https://blocked.com')).toBe(true);
  });

  it('cosine similarity of identical vectors is ~1.0', () => {
    const v = normalize(toFloat32([0.5, 0.3, 0.1, 0.8]));
    index.add('https://same.com', v);

    const results = index.findSimilar(v, 1);

    expect(results.length).toBe(1);
    expect(results[0].score).toBeCloseTo(1.0, 4);
  });

  it('cosine similarity of orthogonal vectors is ~0.0', () => {
    index.add('https://a.com', toFloat32([1, 0, 0]));

    const query = toFloat32([0, 1, 0]);
    const results = index.findSimilar(query, 1);

    expect(results.length).toBe(1);
    expect(results[0].score).toBeCloseTo(0.0, 4);
  });

  it('handles high-dimensional vectors (384-dim)', () => {
    const dims = 384;
    const v1 = new Float32Array(dims);
    const v2 = new Float32Array(dims);
    for (let i = 0; i < dims; i++) {
      v1[i] = Math.random();
      v2[i] = Math.random();
    }

    index.add('https://a.com', v1);
    index.add('https://b.com', v2);

    const results = index.findSimilar(v1, 2);
    expect(results.length).toBe(2);
    expect(results[0].url).toBe('https://a.com');
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it('overwrites vector when adding same URL', () => {
    index.add('https://a.com', toFloat32([1, 0, 0]));
    index.add('https://a.com', toFloat32([0, 1, 0]));

    expect(index.size()).toBe(1);

    const results = index.findSimilar(toFloat32([0, 1, 0]), 1);
    expect(results[0].url).toBe('https://a.com');
    expect(results[0].score).toBeCloseTo(1.0, 4);
  });

  it('clear removes all vectors', () => {
    index.add('https://a.com', toFloat32([1, 0, 0]));
    index.add('https://b.com', toFloat32([0, 1, 0]));

    index.clear();

    expect(index.size()).toBe(0);
    expect(index.findSimilar(toFloat32([1, 0, 0]), 10)).toEqual([]);
  });

  it('has method checks if URL is indexed', () => {
    index.add('https://a.com', toFloat32([1, 0, 0]));

    expect(index.has('https://a.com')).toBe(true);
    expect(index.has('https://b.com')).toBe(false);
  });

  it('get returns vector for existing URL', () => {
    const v = toFloat32([1, 0, 0]);
    index.add('https://a.com', v);

    expect(index.get('https://a.com')).toEqual(v);
    expect(index.get('https://b.com')).toBeUndefined();
  });

  it('getAllUrls returns all indexed URLs', () => {
    index.add('https://a.com', toFloat32([1, 0, 0]));
    index.add('https://b.com', toFloat32([0, 1, 0]));

    const urls = index.getAllUrls();
    expect(urls).toHaveLength(2);
    expect(urls).toContain('https://a.com');
    expect(urls).toContain('https://b.com');
  });

  it('loadFromBuffers populates the index from Buffer entries', () => {
    const v1 = toFloat32([1, 0, 0]);
    const v2 = toFloat32([0, 1, 0]);

    const entries = [
      { url: 'https://a.com', embedding: Buffer.from(v1.buffer), dims: 3 },
      { url: 'https://b.com', embedding: Buffer.from(v2.buffer), dims: 3 },
    ];

    const loaded = index.loadFromBuffers(entries);

    expect(loaded).toBe(2);
    expect(index.size()).toBe(2);
    expect(index.has('https://a.com')).toBe(true);
    expect(index.has('https://b.com')).toBe(true);
  });

  it('scores are between 0 and 1 for normalized vectors', () => {
    for (let i = 0; i < 5; i++) {
      const v = new Float32Array(3);
      for (let j = 0; j < 3; j++) v[j] = Math.random() - 0.5;
      let norm = 0;
      for (let j = 0; j < 3; j++) norm += v[j] * v[j];
      norm = Math.sqrt(norm);
      for (let j = 0; j < 3; j++) v[j] /= norm;

      index.add(`https://example.com/${i}`, v);
    }

    const query = normalize(toFloat32([0.5, 0.5, 0.5]));
    const results = index.findSimilar(query, 5);

    for (const result of results) {
      expect(result.score).toBeGreaterThanOrEqual(-1.001);
      expect(result.score).toBeLessThanOrEqual(1.001);
    }
  });

  it('handles zero vector gracefully', () => {
    index.add('https://zero.com', toFloat32([0, 0, 0]));
    index.add('https://nonzero.com', toFloat32([1, 0, 0]));

    const results = index.findSimilar(toFloat32([1, 0, 0]), 2);
    expect(results.length).toBe(2);
  });

  it('handles topK larger than index size', () => {
    index.add('https://a.com', toFloat32([1, 0, 0]));

    const results = index.findSimilar(toFloat32([1, 0, 0]), 100);
    expect(results.length).toBe(1);
  });

  it('handles topK of 0', () => {
    index.add('https://a.com', toFloat32([1, 0, 0]));

    const results = index.findSimilar(toFloat32([1, 0, 0]), 0);
    expect(results.length).toBe(0);
  });

  it('skips vectors with mismatched dimensions', () => {
    index.add('https://a.com', toFloat32([1, 0, 0]));
    index.add('https://b.com', toFloat32([1, 0])); // 2-dim, mismatch

    const query = toFloat32([1, 0, 0]); // 3-dim
    const results = index.findSimilar(query, 10);

    expect(results.length).toBe(1);
    expect(results[0].url).toBe('https://a.com');
  });
});

describe('cosineSimilarity (exported)', () => {
  it('returns 1.0 for identical normalized vectors', () => {
    const v = normalize(toFloat32([0.5, 0.3, 0.8]));
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity(toFloat32([1, 0, 0]), toFloat32([0, 1, 0]))).toBeCloseTo(0.0, 5);
  });

  it('returns 0 for mismatched lengths', () => {
    expect(cosineSimilarity(toFloat32([1, 0]), toFloat32([1, 0, 0]))).toBe(0);
  });

  it('returns 0 for empty vectors', () => {
    expect(cosineSimilarity(new Float32Array(0), new Float32Array(0))).toBe(0);
  });
});
