import { describe, it, expect } from 'vitest';
import { decomposeMultiHop, expandQueryHeuristic } from '../../../src/search/multi-query.js';

describe('decomposeMultiHop trailing-context preservation', () => {
  it('appends trailing common context to bare entities in vs splits', () => {
    const parts = decomposeMultiHop(
      'trade-offs of master-master vs leader-follower postgres replication',
    );
    expect(parts).not.toBeNull();
    expect(parts).toContain('master-master postgres replication');
    expect(parts).toContain('leader-follower postgres replication');
    // The bare "master-master" must NOT be present — that's the bug that
    // returned Path of Exile / TradingView / Binance from the search engines.
    expect(parts).not.toContain('master-master');
  });

  it('appends trailing context for short comparison segments', () => {
    const parts = decomposeMultiHop('compare REST vs GraphQL APIs');
    expect(parts).toEqual(expect.arrayContaining(['REST APIs', 'GraphQL APIs']));
    expect(parts).not.toContain('REST');
  });

  it('does not strip context from entities already long enough', () => {
    const parts = decomposeMultiHop(
      'compare PostgreSQL streaming replication and logical replication',
    );
    expect(parts).toEqual(
      expect.arrayContaining(['PostgreSQL streaming replication', 'logical replication']),
    );
  });

  it('leaves bare-vs-bare comparisons untouched (no tail available)', () => {
    const parts = decomposeMultiHop('compare Redis vs DragonflyDB');
    expect(parts).toEqual(expect.arrayContaining(['Redis', 'DragonflyDB']));
  });
});

describe('expandQueryHeuristic on hyphenated comparisons', () => {
  it('preserves original query at head and contains context-enriched entities', () => {
    const variants = expandQueryHeuristic(
      'trade-offs of master-master vs leader-follower postgres replication',
    );
    expect(variants[0]).toBe(
      'trade-offs of master-master vs leader-follower postgres replication',
    );
    expect(variants).toContain('master-master postgres replication');
    expect(variants).toContain('leader-follower postgres replication');
    expect(variants).not.toContain('master-master');
  });
});
