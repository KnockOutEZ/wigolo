import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getGeneralEngines,
  _resetGeneralEnginesForTest,
} from '../../../../../src/search/core/verticals/general.js';
import { _resetBreakersForTest } from '../../../../../src/search/core/engine-base.js';
import { setPluginSearchEngines } from '../../../../../src/search/core/plugin-engines.js';
import type { RawSearchResult, SearchEngine } from '../../../../../src/types.js';

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

  // docs/plugins.md promises plugin search engines "join the multi-engine
  // dispatch" and show up in engines_used. The core search builds its roster
  // here, so a plugin engine that isn't listed never receives a query.
  describe('plugin search engines', () => {
    afterEach(() => setPluginSearchEngines([]));

    function pluginEngine(name: string, calls: string[]): SearchEngine {
      return {
        name,
        async search(query: string): Promise<RawSearchResult[]> {
          calls.push(query);
          return [{ title: 't', url: 'https://wiki.internal/x', snippet: 's', relevance_score: 1, engine: name }];
        },
      };
    }

    it('WHY: a registered plugin engine joins the general roster and receives the query', async () => {
      const calls: string[] = [];
      setPluginSearchEngines([pluginEngine('internal-wiki', calls)]);
      const entry = getGeneralEngines().find((e) => e.engine.name === 'internal-wiki');
      expect(entry).toBeDefined();
      expect(entry?.quality).toBeDefined();
      const results = await entry!.engine.search('vpn setup');
      expect(calls).toEqual(['vpn setup']);
      expect(results[0].url).toBe('https://wiki.internal/x');
    });

    it('built-in engines are unchanged when plugins are registered', () => {
      const before = getGeneralEngines().map((e) => e.engine.name);
      setPluginSearchEngines([pluginEngine('internal-wiki', [])]);
      expect(getGeneralEngines().map((e) => e.engine.name)).toEqual([...before, 'internal-wiki']);
    });

    it('a plugin registered after the roster was first built still joins it', () => {
      getGeneralEngines();
      setPluginSearchEngines([pluginEngine('late-plugin', [])]);
      expect(getGeneralEngines().some((e) => e.engine.name === 'late-plugin')).toBe(true);
    });

    it('clearing the plugins restores the built-in roster', () => {
      const before = getGeneralEngines();
      setPluginSearchEngines([pluginEngine('internal-wiki', [])]);
      setPluginSearchEngines([]);
      expect(getGeneralEngines()).toBe(before);
    });
  });
});
