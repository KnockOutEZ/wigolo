import { describe, it, expect, beforeEach } from 'vitest';
import {
  getNewsEngines,
  _resetNewsEnginesForTest,
} from '../../../../../src/search/v1/verticals/news.js';
import { _resetBreakersForTest } from '../../../../../src/search/v1/engine-base.js';

describe('getNewsEngines', () => {
  beforeEach(() => {
    _resetNewsEnginesForTest();
    _resetBreakersForTest();
  });

  it('returns two entries', () => {
    expect(getNewsEngines()).toHaveLength(2);
  });

  it('wraps hn-algolia and lobsters engines (preserving names)', () => {
    const names = getNewsEngines().map((e) => e.engine.name);
    expect(names).toEqual(['hn-algolia', 'lobsters']);
  });

  it('memoizes — two calls return the same array reference', () => {
    const a = getNewsEngines();
    const b = getNewsEngines();
    expect(a).toBe(b);
  });

  it('_resetNewsEnginesForTest clears the cache', () => {
    const a = getNewsEngines();
    _resetNewsEnginesForTest();
    const b = getNewsEngines();
    expect(a).not.toBe(b);
  });

  it('weights HN higher than lobsters', () => {
    const entries = getNewsEngines();
    const hn = entries.find((e) => e.engine.name === 'hn-algolia');
    const lob = entries.find((e) => e.engine.name === 'lobsters');
    expect(hn?.weight).toBeGreaterThan(lob?.weight ?? 0);
  });

  it('marks supportsDateFilter true for hn-algolia and false for lobsters', () => {
    const entries = getNewsEngines();
    const hn = entries.find((e) => e.engine.name === 'hn-algolia');
    const lob = entries.find((e) => e.engine.name === 'lobsters');
    expect(hn?.supportsDateFilter).toBe(true);
    expect(lob?.supportsDateFilter).toBe(false);
  });
});
