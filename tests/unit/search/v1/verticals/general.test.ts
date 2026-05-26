import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getGeneralEngines,
  _resetGeneralEnginesForTest,
} from '../../../../../src/search/core/verticals/general.js';
import { _resetBreakersForTest } from '../../../../../src/search/core/engine-base.js';

describe('getGeneralEngines', () => {
  const originalBraveKey = process.env.BRAVE_API_KEY;

  beforeEach(() => {
    delete process.env.BRAVE_API_KEY;
    _resetGeneralEnginesForTest();
    _resetBreakersForTest();
  });

  afterEach(() => {
    if (originalBraveKey === undefined) {
      delete process.env.BRAVE_API_KEY;
    } else {
      process.env.BRAVE_API_KEY = originalBraveKey;
    }
    _resetGeneralEnginesForTest();
  });

  // Slice S11a (long-tail engine breadth): mojeek + marginalia added to the
  // general pool for the broader-lexical signal goal. WHY they're at this
  // layer rather than a separate vertical: they're plain web engines, just
  // with thinner indexes — fusing them via RRF in the general pool is what
  // S11a is designed to do.
  it('returns six entries by default (bing, duckduckgo, startpage, wikipedia, mojeek, marginalia)', () => {
    expect(getGeneralEngines()).toHaveLength(6);
  });

  it('wraps bing, duckduckgo, startpage, wikipedia, mojeek, marginalia (preserving names)', () => {
    const names = getGeneralEngines().map((e) => e.engine.name).sort();
    expect(names).toEqual([
      'bing',
      'duckduckgo',
      'marginalia',
      'mojeek',
      'startpage',
      'wikipedia',
    ]);
  });

  it('marks mojeek + marginalia as secondary so they cannot dominate when their lexical alignment is low', () => {
    const entries = getGeneralEngines();
    const mojeek = entries.find((e) => e.engine.name === 'mojeek');
    const marginalia = entries.find((e) => e.engine.name === 'marginalia');
    expect(mojeek?.secondary).toBe(true);
    expect(marginalia?.secondary).toBe(true);
  });

  it('adds brave when BRAVE_API_KEY is set', async () => {
    process.env.BRAVE_API_KEY = 'test-key';
    const { resetConfig } = await import('../../../../../src/config.js');
    resetConfig();
    _resetGeneralEnginesForTest();
    const names = getGeneralEngines().map((e) => e.engine.name).sort();
    expect(names).toContain('brave');
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

  it('sets supportsDateFilter=false on every entry', () => {
    for (const entry of getGeneralEngines()) {
      expect(entry.supportsDateFilter).toBe(false);
    }
  });

  it('weights main scrapers at 1 and wikipedia lower', () => {
    const entries = getGeneralEngines();
    const w = (name: string) => entries.find((e) => e.engine.name === name)?.weight ?? 0;
    expect(w('bing')).toBe(1);
    expect(w('duckduckgo')).toBe(1);
    expect(w('startpage')).toBe(1);
    expect(w('wikipedia')).toBeLessThan(1);
  });
});
