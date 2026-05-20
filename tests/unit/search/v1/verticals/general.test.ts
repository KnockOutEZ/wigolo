import { describe, it, expect, beforeEach } from 'vitest';
import {
  getGeneralEngines,
  _resetGeneralEnginesForTest,
} from '../../../../../src/search/v1/verticals/general.js';
import { _resetBreakersForTest } from '../../../../../src/search/v1/engine-base.js';

describe('getGeneralEngines', () => {
  beforeEach(() => {
    _resetGeneralEnginesForTest();
    _resetBreakersForTest();
  });

  it('returns three entries', () => {
    expect(getGeneralEngines()).toHaveLength(3);
  });

  it('wraps bing, duckduckgo, and startpage engines (preserving names)', () => {
    const names = getGeneralEngines().map((e) => e.engine.name);
    expect(names).toEqual(['bing', 'duckduckgo', 'startpage']);
  });

  it('memoizes — two calls return the same array reference', () => {
    const a = getGeneralEngines();
    const b = getGeneralEngines();
    expect(a).toBe(b);
  });

  it('_resetGeneralEnginesForTest clears the cache', () => {
    const a = getGeneralEngines();
    _resetGeneralEnginesForTest();
    const b = getGeneralEngines();
    expect(a).not.toBe(b);
  });

  it('sets weight=1 and supportsDateFilter=false on each entry', () => {
    for (const entry of getGeneralEngines()) {
      expect(entry.weight).toBe(1);
      expect(entry.supportsDateFilter).toBe(false);
    }
  });
});
