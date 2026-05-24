import { describe, it, expect } from 'vitest';
import { generateSearchQueries } from '../../../../src/search/find-similar.js';

describe('generateSearchQueries', () => {
  it('produces title-first query plus token query for strong signal', () => {
    const out = generateSearchQueries(
      ['postgres', 'logical', 'replication'],
      'Postgres logical replication overview',
    );
    expect(out[0]).toContain('Postgres logical replication');
    expect(out.some((q) => q.includes('postgres'))).toBe(true);
    expect(out.length).toBeGreaterThanOrEqual(2);
  });

  it('filters out stopwords from token-only queries', () => {
    const out = generateSearchQueries(['the', 'a', 'replication', 'patterns'], 'replication patterns');
    expect(out.some((q) => q.split(/\s+/).includes('the'))).toBe(false);
    expect(out.some((q) => q.split(/\s+/).includes('a'))).toBe(false);
    expect(out.some((q) => q.includes('replication'))).toBe(true);
  });

  it('returns empty when signal too weak to disambiguate', () => {
    expect(generateSearchQueries([], '')).toEqual([]);
    expect(generateSearchQueries(['the'], '')).toEqual([]);
    expect(generateSearchQueries(['a', 'is'], '')).toEqual([]);
  });

  it('allows single-token query when title carries the topic', () => {
    const out = generateSearchQueries(['kubernetes'], 'Kubernetes Networking Deep Dive');
    expect(out[0]).toBe('Kubernetes Networking Deep Dive');
  });

  it('does not emit a generic tutorial-guide query (replaced with "overview")', () => {
    const out = generateSearchQueries(
      ['vector', 'database', 'similarity', 'search'],
      'vector database similarity search',
    );
    expect(out.some((q) => /tutorial guide/i.test(q))).toBe(false);
  });

  it('truncates long titles to 150 chars', () => {
    const long = 'topic '.repeat(80).trim();
    const out = generateSearchQueries(['topic'], long);
    expect(out[0].length).toBeLessThanOrEqual(150);
  });
});
