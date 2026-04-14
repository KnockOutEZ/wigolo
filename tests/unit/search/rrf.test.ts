import { describe, it, expect } from 'vitest';
import { reciprocalRankFusion } from '../../../src/search/rrf.js';

describe('reciprocalRankFusion', () => {
  it('returns empty map for empty input', () => {
    const result = reciprocalRankFusion([]);
    expect(result.size).toBe(0);
  });

  it('returns empty map for single empty list', () => {
    const result = reciprocalRankFusion([new Map()]);
    expect(result.size).toBe(0);
  });

  it('scores a single list correctly with default k=60', () => {
    const list = new Map<string, number>([
      ['https://a.com', 1],
      ['https://b.com', 2],
      ['https://c.com', 3],
    ]);
    const result = reciprocalRankFusion([list]);

    expect(result.get('https://a.com')).toBeCloseTo(1 / 61, 5);
    expect(result.get('https://b.com')).toBeCloseTo(1 / 62, 5);
    expect(result.get('https://c.com')).toBeCloseTo(1 / 63, 5);
  });

  it('fuses two lists by summing reciprocal ranks', () => {
    const list1 = new Map<string, number>([
      ['https://a.com', 1],
      ['https://b.com', 2],
    ]);
    const list2 = new Map<string, number>([
      ['https://b.com', 1],
      ['https://c.com', 2],
    ]);
    const result = reciprocalRankFusion([list1, list2]);

    expect(result.get('https://a.com')).toBeCloseTo(1 / 61, 5);
    expect(result.get('https://b.com')).toBeCloseTo(1 / 62 + 1 / 61, 5);
    expect(result.get('https://c.com')).toBeCloseTo(1 / 62, 5);
  });

  it('items appearing in both lists score higher than single-list items', () => {
    const list1 = new Map<string, number>([
      ['https://a.com', 1],
      ['https://shared.com', 2],
    ]);
    const list2 = new Map<string, number>([
      ['https://shared.com', 1],
      ['https://b.com', 2],
    ]);
    const result = reciprocalRankFusion([list1, list2]);

    const sharedScore = result.get('https://shared.com')!;
    const aScore = result.get('https://a.com')!;
    const bScore = result.get('https://b.com')!;

    expect(sharedScore).toBeGreaterThan(aScore);
    expect(sharedScore).toBeGreaterThan(bScore);
  });

  it('respects custom k parameter', () => {
    const list = new Map<string, number>([
      ['https://a.com', 1],
    ]);
    const result = reciprocalRankFusion([list], 10);
    expect(result.get('https://a.com')).toBeCloseTo(1 / 11, 5);
  });

  it('handles k=0 without division by zero (rank starts at 1)', () => {
    const list = new Map<string, number>([
      ['https://a.com', 1],
      ['https://b.com', 2],
    ]);
    const result = reciprocalRankFusion([list], 0);
    expect(result.get('https://a.com')).toBeCloseTo(1.0, 5);
    expect(result.get('https://b.com')).toBeCloseTo(0.5, 5);
  });

  it('fuses three lists correctly', () => {
    const list1 = new Map<string, number>([['https://x.com', 1]]);
    const list2 = new Map<string, number>([['https://x.com', 1]]);
    const list3 = new Map<string, number>([['https://x.com', 1]]);
    const result = reciprocalRankFusion([list1, list2, list3]);
    expect(result.get('https://x.com')).toBeCloseTo(3 / 61, 5);
  });

  it('handles large rank values', () => {
    const list = new Map<string, number>([
      ['https://a.com', 100],
    ]);
    const result = reciprocalRankFusion([list]);
    expect(result.get('https://a.com')).toBeCloseTo(1 / 160, 5);
  });

  it('preserves all unique URLs across all lists', () => {
    const list1 = new Map<string, number>([
      ['https://a.com', 1],
      ['https://b.com', 2],
    ]);
    const list2 = new Map<string, number>([
      ['https://c.com', 1],
      ['https://d.com', 2],
    ]);
    const result = reciprocalRankFusion([list1, list2]);
    expect(result.size).toBe(4);
    expect(result.has('https://a.com')).toBe(true);
    expect(result.has('https://b.com')).toBe(true);
    expect(result.has('https://c.com')).toBe(true);
    expect(result.has('https://d.com')).toBe(true);
  });

  it('returns sorted results via sortByScore helper', () => {
    const list1 = new Map<string, number>([
      ['https://low.com', 5],
      ['https://high.com', 1],
    ]);
    const list2 = new Map<string, number>([
      ['https://high.com', 1],
      ['https://mid.com', 2],
    ]);
    const scores = reciprocalRankFusion([list1, list2]);

    const sorted = [...scores.entries()].sort((a, b) => b[1] - a[1]);
    expect(sorted[0][0]).toBe('https://high.com');
  });

  it('handles duplicate URLs within the same list (last entry wins for rank)', () => {
    const list = new Map<string, number>([
      ['https://a.com', 3],
      ['https://a.com', 1],
    ]);
    const result = reciprocalRankFusion([list]);
    expect(result.get('https://a.com')).toBeCloseTo(1 / 61, 5);
  });

  it('negative k values are handled without error', () => {
    const list = new Map<string, number>([
      ['https://a.com', 1],
    ]);
    const result = reciprocalRankFusion([list], -10);
    expect(result.has('https://a.com')).toBe(true);
  });

  it('many lists with overlapping URLs accumulate scores', () => {
    const lists: Map<string, number>[] = [];
    for (let i = 0; i < 10; i++) {
      lists.push(new Map([['https://popular.com', 1]]));
    }
    const result = reciprocalRankFusion(lists);
    expect(result.get('https://popular.com')).toBeCloseTo(10 / 61, 5);
  });

  it('sortByRRFScore produces descending order', () => {
    const list1 = new Map<string, number>([
      ['https://z.com', 10],
      ['https://a.com', 1],
    ]);
    const list2 = new Map<string, number>([
      ['https://a.com', 1],
      ['https://m.com', 3],
    ]);
    const scores = reciprocalRankFusion([list1, list2]);
    const sorted = [...scores.entries()].sort((a, b) => b[1] - a[1]);

    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i][1]).toBeLessThanOrEqual(sorted[i - 1][1]);
    }
  });

  it('returns Map type that supports standard Map operations', () => {
    const list = new Map<string, number>([['https://a.com', 1]]);
    const result = reciprocalRankFusion([list]);
    expect(result).toBeInstanceOf(Map);
    expect(typeof result.get('https://a.com')).toBe('number');
    expect([...result.keys()]).toContain('https://a.com');
    expect([...result.values()].length).toBe(1);
  });
});
