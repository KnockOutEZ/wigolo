import { describe, it, expect, beforeEach } from 'vitest';
import {
  PluginRegistry,
  type PluginRegistryState,
} from '../../../src/plugins/registry.js';
import type { Extractor, SearchEngine } from '../../../src/types.js';

function makeExtractor(name: string): Extractor {
  return {
    name,
    canHandle: (url: string) => url.includes(name),
    extract: (_html: string, _url: string) => ({
      title: `${name} title`,
      markdown: `${name} content`,
      metadata: {},
      links: [],
      images: [],
      extractor: 'site-specific' as const,
    }),
  };
}

function makeSearchEngine(name: string): SearchEngine {
  return {
    name,
    search: async (_query: string) => [{
      title: `${name} result`,
      url: `https://${name}.example/result`,
      snippet: `${name} snippet`,
      relevance_score: 0.9,
      engine: name,
    }],
  };
}

describe('PluginRegistry', () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    registry = new PluginRegistry();
  });

  it('starts with empty extractors and search engines', () => {
    const state = registry.getState();
    expect(state.extractors).toEqual([]);
    expect(state.searchEngines).toEqual([]);
    expect(state.pluginCount).toBe(0);
  });

  it('registers extractors', () => {
    const ext = makeExtractor('test-ext');
    registry.registerExtractor(ext, 'plugin-a');
    expect(registry.getExtractors()).toHaveLength(1);
    expect(registry.getExtractors()[0].name).toBe('test-ext');
  });

  it('registers search engines', () => {
    const eng = makeSearchEngine('test-eng');
    registry.registerSearchEngine(eng, 'plugin-b');
    expect(registry.getSearchEngines()).toHaveLength(1);
    expect(registry.getSearchEngines()[0].name).toBe('test-eng');
  });

  it('prevents duplicate extractor names', () => {
    const ext1 = makeExtractor('dup-ext');
    const ext2 = makeExtractor('dup-ext');
    registry.registerExtractor(ext1, 'plugin-a');
    registry.registerExtractor(ext2, 'plugin-b');
    expect(registry.getExtractors()).toHaveLength(1);
  });

  it('prevents duplicate search engine names', () => {
    const eng1 = makeSearchEngine('dup-eng');
    const eng2 = makeSearchEngine('dup-eng');
    registry.registerSearchEngine(eng1, 'plugin-a');
    registry.registerSearchEngine(eng2, 'plugin-b');
    expect(registry.getSearchEngines()).toHaveLength(1);
  });

  it('tracks plugin count correctly', () => {
    registry.registerExtractor(makeExtractor('ext1'), 'plugin-a');
    registry.registerSearchEngine(makeSearchEngine('eng1'), 'plugin-b');
    registry.registerExtractor(makeExtractor('ext2'), 'plugin-a'); // same plugin
    expect(registry.getState().pluginCount).toBe(2); // 2 unique plugin names
  });

  it('returns the full state snapshot', () => {
    registry.registerExtractor(makeExtractor('ext1'), 'plugin-a');
    registry.registerSearchEngine(makeSearchEngine('eng1'), 'plugin-b');
    const state = registry.getState();
    expect(state.extractors).toEqual([{ name: 'ext1', pluginName: 'plugin-a' }]);
    expect(state.searchEngines).toEqual([{ name: 'eng1', pluginName: 'plugin-b' }]);
    expect(state.pluginCount).toBe(2);
  });

  it('clear() removes all registrations', () => {
    registry.registerExtractor(makeExtractor('ext1'), 'plugin-a');
    registry.registerSearchEngine(makeSearchEngine('eng1'), 'plugin-b');
    registry.clear();
    expect(registry.getExtractors()).toEqual([]);
    expect(registry.getSearchEngines()).toEqual([]);
    expect(registry.getState().pluginCount).toBe(0);
  });

  it('getExtractorByName returns the correct extractor', () => {
    const ext = makeExtractor('findme');
    registry.registerExtractor(ext, 'plugin-a');
    expect(registry.getExtractorByName('findme')).toBe(ext);
    expect(registry.getExtractorByName('nonexistent')).toBeUndefined();
  });

  it('getSearchEngineByName returns the correct engine', () => {
    const eng = makeSearchEngine('findme');
    registry.registerSearchEngine(eng, 'plugin-a');
    expect(registry.getSearchEngineByName('findme')).toBe(eng);
    expect(registry.getSearchEngineByName('nonexistent')).toBeUndefined();
  });

  it('handles registering many extractors and engines', () => {
    for (let i = 0; i < 50; i++) {
      registry.registerExtractor(makeExtractor(`ext-${i}`), `plugin-${i}`);
      registry.registerSearchEngine(makeSearchEngine(`eng-${i}`), `plugin-${i}`);
    }
    expect(registry.getExtractors()).toHaveLength(50);
    expect(registry.getSearchEngines()).toHaveLength(50);
    expect(registry.getState().pluginCount).toBe(50);
  });

  it('extractor canHandle delegates correctly to the registered extractor', () => {
    const ext = makeExtractor('mysite');
    registry.registerExtractor(ext, 'plugin-a');
    const registered = registry.getExtractors()[0];
    expect(registered.canHandle('https://mysite.example/page')).toBe(true);
    expect(registered.canHandle('https://other.example/page')).toBe(false);
  });

  it('search engine search delegates correctly', async () => {
    const eng = makeSearchEngine('test-delegate');
    registry.registerSearchEngine(eng, 'plugin-a');
    const registered = registry.getSearchEngines()[0];
    const results = await registered.search('hello');
    expect(results).toHaveLength(1);
    expect(results[0].title).toContain('test-delegate');
  });

  it('names with special characters are handled', () => {
    const ext = makeExtractor('ext-with-dashes_and_underscores.v2');
    registry.registerExtractor(ext, 'plugin-special');
    expect(registry.getExtractorByName('ext-with-dashes_and_underscores.v2')).toBe(ext);
  });

  it('names with unicode are handled', () => {
    const ext = makeExtractor('extractor-\u00e9\u00e8\u00ea');
    registry.registerExtractor(ext, 'plugin-unicode');
    expect(registry.getExtractorByName('extractor-\u00e9\u00e8\u00ea')).toBe(ext);
  });
});
