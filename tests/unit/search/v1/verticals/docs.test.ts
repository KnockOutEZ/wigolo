import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getDocsEngines,
  _resetDocsEnginesForTest,
} from '../../../../../src/search/core/verticals/docs.js';
import { _resetBreakersForTest } from '../../../../../src/search/core/engine-base.js';

describe('getDocsEngines', () => {
  const originalBraveKey = process.env.BRAVE_API_KEY;

  beforeEach(() => {
    delete process.env.BRAVE_API_KEY;
    _resetDocsEnginesForTest();
    _resetBreakersForTest();
  });

  afterEach(() => {
    if (originalBraveKey === undefined) {
      delete process.env.BRAVE_API_KEY;
    } else {
      process.env.BRAVE_API_KEY = originalBraveKey;
    }
    _resetDocsEnginesForTest();
  });

  it('includes mdn and devdocs plus secondary general-web signals', () => {
    const names = getDocsEngines().map((e) => e.engine.name);
    // The two first-party docs APIs stay primary; general-web engines are
    // added so a docs query MDN/DevDocs do not index still has web recall.
    expect(names).toContain('mdn');
    expect(names).toContain('devdocs');
    expect(names).toContain('bing');
    expect(names).toContain('duckduckgo');
  });

  it('marks the general-web engines secondary and leaves mdn/devdocs primary', () => {
    const entries = getDocsEngines();
    const secondaryOf = (name: string) =>
      entries.find((e) => e.engine.name === name)?.secondary ?? false;
    // First-party docs APIs are the authoritative signal — not secondary.
    expect(secondaryOf('mdn')).toBe(false);
    expect(secondaryOf('devdocs')).toBe(false);
    // General-web engines are secondary so they cannot outrank a real MDN hit
    // when their lexical alignment with the query is low.
    expect(secondaryOf('bing')).toBe(true);
    expect(secondaryOf('duckduckgo')).toBe(true);
  });

  it('weights mdn highest and the secondary general engines below it', () => {
    const entries = getDocsEngines();
    const w = (name: string) => entries.find((e) => e.engine.name === name)?.weight ?? 0;
    expect(w('mdn')).toBeGreaterThan(w('devdocs'));
    expect(w('mdn')).toBeGreaterThan(w('bing'));
    expect(w('mdn')).toBeGreaterThan(w('duckduckgo'));
  });

  it('sets a quality tier on every registered entry', () => {
    for (const entry of getDocsEngines()) {
      expect(entry.quality).toBeTypeOf('string');
    }
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

  it('marks supportsDateFilter false on every entry', () => {
    for (const entry of getDocsEngines()) {
      expect(entry.supportsDateFilter).toBe(false);
    }
  });
});
