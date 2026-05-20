import { describe, it, expect, beforeEach } from 'vitest';
import {
  getDocsEngines,
  _resetDocsEnginesForTest,
} from '../../../../../src/search/v1/verticals/docs.js';
import { _resetBreakersForTest } from '../../../../../src/search/v1/engine-base.js';

describe('getDocsEngines', () => {
  beforeEach(() => {
    _resetDocsEnginesForTest();
    _resetBreakersForTest();
  });

  it('returns two entries', () => {
    expect(getDocsEngines()).toHaveLength(2);
  });

  it('wraps mdn and devdocs engines (preserving names)', () => {
    const names = getDocsEngines().map((e) => e.engine.name);
    expect(names).toEqual(['mdn', 'devdocs']);
  });

  it('memoizes — two calls return the same array reference', () => {
    const a = getDocsEngines();
    const b = getDocsEngines();
    expect(a).toBe(b);
  });

  it('_resetDocsEnginesForTest clears the cache', () => {
    const a = getDocsEngines();
    _resetDocsEnginesForTest();
    const b = getDocsEngines();
    expect(a).not.toBe(b);
  });

  it('weights mdn higher than devdocs', () => {
    const entries = getDocsEngines();
    const mdn = entries.find((e) => e.engine.name === 'mdn');
    const dd = entries.find((e) => e.engine.name === 'devdocs');
    expect(mdn?.weight).toBeGreaterThan(dd?.weight ?? 0);
  });

  it('marks supportsDateFilter false on both', () => {
    for (const entry of getDocsEngines()) {
      expect(entry.supportsDateFilter).toBe(false);
    }
  });
});
