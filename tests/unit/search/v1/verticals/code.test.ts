import { describe, it, expect, beforeEach } from 'vitest';
import {
  getCodeEngines,
  _resetCodeEnginesForTest,
} from '../../../../../src/search/v1/verticals/code.js';
import { _resetBreakersForTest } from '../../../../../src/search/v1/engine-base.js';

describe('getCodeEngines', () => {
  beforeEach(() => {
    _resetCodeEnginesForTest();
    _resetBreakersForTest();
  });

  it('returns two entries', () => {
    expect(getCodeEngines()).toHaveLength(2);
  });

  it('wraps github-code and stackoverflow engines (preserving names)', () => {
    const names = getCodeEngines().map((e) => e.engine.name);
    expect(names).toEqual(['github-code', 'stackoverflow']);
  });

  it('memoizes — two calls return the same array reference', () => {
    const a = getCodeEngines();
    const b = getCodeEngines();
    expect(a).toBe(b);
  });

  it('_resetCodeEnginesForTest clears the cache', () => {
    const a = getCodeEngines();
    _resetCodeEnginesForTest();
    const b = getCodeEngines();
    expect(a).not.toBe(b);
  });

  it('weights github-code higher than stackoverflow', () => {
    const entries = getCodeEngines();
    const gh = entries.find((e) => e.engine.name === 'github-code');
    const so = entries.find((e) => e.engine.name === 'stackoverflow');
    expect(gh?.weight).toBeGreaterThan(so?.weight ?? 0);
  });

  it('marks supportsDateFilter false for github-code and true for stackoverflow', () => {
    const entries = getCodeEngines();
    const gh = entries.find((e) => e.engine.name === 'github-code');
    const so = entries.find((e) => e.engine.name === 'stackoverflow');
    expect(gh?.supportsDateFilter).toBe(false);
    expect(so?.supportsDateFilter).toBe(true);
  });
});
