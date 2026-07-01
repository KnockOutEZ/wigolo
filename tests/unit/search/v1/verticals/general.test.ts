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

  // mojeek + marginalia added to the general pool for a broader-lexical
  // signal. WHY they're at this layer rather than a separate vertical:
  // they're plain web engines, just with thinner indexes — fusing them via
  // RRF in the general pool is the intended design.
  // wiby was removed from the pool: it errored / opened its circuit
  // breaker on every run — pure latency tax, zero contribution. The
  // exact-set assertion below is what enforces the removal: nothing outside
  // this list (and no re-added wiby) can register.
  it('returns five entries by default (bing, duckduckgo, wikipedia, mojeek, marginalia)', () => {
    expect(getGeneralEngines()).toHaveLength(5);
  });

  it('wraps exactly bing, duckduckgo, wikipedia, mojeek, marginalia — no wiby, no dropped engines', () => {
    const names = getGeneralEngines().map((e) => e.engine.name).sort();
    expect(names).toEqual([
      'bing',
      'duckduckgo',
      'marginalia',
      'mojeek',
      'wikipedia',
    ]);
  });

  it('does not register wiby — removed as dead weight (breaker-open every run)', () => {
    const wiby = getGeneralEngines().find((e) => e.engine.name === 'wiby');
    expect(wiby).toBeUndefined();
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
    expect(w('wikipedia')).toBeLessThan(1);
  });
});
