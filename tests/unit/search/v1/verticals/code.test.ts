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

  it('returns four entries (github-code + stackoverflow + mdn + devdocs)', () => {
    expect(getCodeEngines()).toHaveLength(4);
  });

  it('wraps github-code, stackoverflow, mdn, devdocs (preserving names)', () => {
    const names = getCodeEngines().map((e) => e.engine.name).sort();
    expect(names).toEqual(['devdocs', 'github-code', 'mdn', 'stackoverflow']);
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

  it('weights primary code engines higher than the docs-backed fallbacks', () => {
    const entries = getCodeEngines();
    const w = (name: string) => entries.find((e) => e.engine.name === name)?.weight ?? 0;
    expect(w('github-code')).toBeGreaterThan(w('stackoverflow'));
    expect(w('stackoverflow')).toBeGreaterThan(w('mdn'));
    expect(w('mdn')).toBeGreaterThanOrEqual(w('devdocs'));
  });

  it('marks supportsDateFilter correctly per engine', () => {
    const entries = getCodeEngines();
    const f = (name: string) => entries.find((e) => e.engine.name === name)?.supportsDateFilter;
    expect(f('github-code')).toBe(false);
    expect(f('stackoverflow')).toBe(true);
    expect(f('mdn')).toBe(false);
    expect(f('devdocs')).toBe(false);
  });
});
