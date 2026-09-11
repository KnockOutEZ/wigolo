import { describe, it, expect, beforeEach } from 'vitest';
import {
  getPapersEngines,
  _resetPapersEnginesForTest,
} from '../../../../../src/search/core/verticals/papers.js';
import { _resetBreakersForTest } from '../../../../../src/search/core/engine-base.js';

describe('getPapersEngines', () => {
  beforeEach(() => {
    _resetPapersEnginesForTest();
    _resetBreakersForTest();
  });

  it('returns five entries', () => {
    expect(getPapersEngines()).toHaveLength(5);
  });

  it('wraps arxiv, semantic-scholar, openalex, dblp, openreview (preserving names)', () => {
    const names = getPapersEngines().map((e) => e.engine.name);
    expect(names).toEqual(['arxiv', 'semantic-scholar', 'openalex', 'dblp', 'openreview']);
  });

  it('marks the three added engines secondary and leaves arxiv/S2 primary', () => {
    const secondaryNames = ['openalex', 'dblp', 'openreview'];
    const entries = getPapersEngines();
    for (const name of secondaryNames) {
      expect(entries.find((e) => e.engine.name === name)?.secondary).toBe(true);
    }
    for (const e of entries) {
      if (secondaryNames.includes(e.engine.name)) continue;
      expect(e.secondary ?? false).toBe(false);
    }
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

  it('marks supportsDateFilter true only on arxiv and semantic-scholar', () => {
    const entries = getPapersEngines();
    const f = (name: string) => entries.find((e) => e.engine.name === name)?.supportsDateFilter;
    expect(f('arxiv')).toBe(true);
    expect(f('semantic-scholar')).toBe(true);
    expect(f('openalex')).toBe(false);
    expect(f('dblp')).toBe(false);
    expect(f('openreview')).toBe(false);
  });
});
