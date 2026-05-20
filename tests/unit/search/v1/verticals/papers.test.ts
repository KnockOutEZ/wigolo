import { describe, it, expect, beforeEach } from 'vitest';
import {
  getPapersEngines,
  _resetPapersEnginesForTest,
} from '../../../../../src/search/v1/verticals/papers.js';
import { _resetBreakersForTest } from '../../../../../src/search/v1/engine-base.js';

describe('getPapersEngines', () => {
  beforeEach(() => {
    _resetPapersEnginesForTest();
    _resetBreakersForTest();
  });

  it('returns two entries', () => {
    expect(getPapersEngines()).toHaveLength(2);
  });

  it('wraps arxiv and semantic-scholar engines (preserving names)', () => {
    const names = getPapersEngines().map((e) => e.engine.name);
    expect(names).toEqual(['arxiv', 'semantic-scholar']);
  });

  it('memoizes — two calls return the same array reference', () => {
    const a = getPapersEngines();
    const b = getPapersEngines();
    expect(a).toBe(b);
  });

  it('_resetPapersEnginesForTest clears the cache', () => {
    const a = getPapersEngines();
    _resetPapersEnginesForTest();
    const b = getPapersEngines();
    expect(a).not.toBe(b);
  });

  it('marks supportsDateFilter true on both', () => {
    for (const entry of getPapersEngines()) {
      expect(entry.supportsDateFilter).toBe(true);
    }
  });
});
