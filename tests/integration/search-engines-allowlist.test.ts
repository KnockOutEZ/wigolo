// search_engines allowlist at the MCP / one-shot CLI tool boundary
// (WIGOLO_SEARCH=core). The orchestrator unit suite covers dispatch mechanics;
// this file pins that handleSearch actually consumes the advertised parameter
// rather than the leftover engines[] argument.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  SearchEngine,
  SearchEngineOptions,
  RawSearchResult,
} from '../../src/types.js';
import type { SmartRouter } from '../../src/fetch/router.js';
import type { EngineEntry } from '../../src/search/core/engine-base.js';

const verticalState: {
  general: EngineEntry[];
  news: EngineEntry[];
  code: EngineEntry[];
  docs: EngineEntry[];
  papers: EngineEntry[];
  images: EngineEntry[];
} = { general: [], news: [], code: [], docs: [], papers: [], images: [] };

vi.mock('../../src/search/core/verticals/general.js', () => ({
  getGeneralEngines: () => verticalState.general,
  _resetGeneralEnginesForTest: () => {
    verticalState.general = [];
  },
}));
vi.mock('../../src/search/core/verticals/news.js', () => ({
  getNewsEngines: () => verticalState.news,
  _resetNewsEnginesForTest: () => {
    verticalState.news = [];
  },
}));
vi.mock('../../src/search/core/verticals/code.js', () => ({
  getCodeEngines: () => verticalState.code,
  _resetCodeEnginesForTest: () => {
    verticalState.code = [];
  },
}));
vi.mock('../../src/search/core/verticals/docs.js', () => ({
  getDocsEngines: () => verticalState.docs,
  _resetDocsEnginesForTest: () => {
    verticalState.docs = [];
  },
}));
vi.mock('../../src/search/core/verticals/papers.js', () => ({
  getPapersEngines: () => verticalState.papers,
  _resetPapersEnginesForTest: () => {
    verticalState.papers = [];
  },
}));
vi.mock('../../src/search/core/verticals/images.js', () => ({
  getImageEngines: () => verticalState.images,
  _resetImageEnginesForTest: () => {
    verticalState.images = [];
  },
}));

vi.mock('../../src/cache/store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/cache/store.js')>();
  return {
    ...actual,
    getCachedSearchResults: vi.fn(() => null),
    cacheSearchResults: vi.fn(),
  };
});

import { handleSearch } from '../../src/tools/search.js';
import { _resetSearchProviderForTest } from '../../src/providers/search-provider.js';
import { resetConfig } from '../../src/config.js';

function makeResult(engineName: string, url: string): RawSearchResult {
  return { title: engineName, url, snippet: 'S', relevance_score: 1, engine: engineName };
}

function makeEntry(name: string, results: RawSearchResult[]): {
  entry: EngineEntry;
  search: ReturnType<typeof vi.fn>;
} {
  const search = vi.fn(async (_q: string, _opts?: SearchEngineOptions) => results);
  const engine: SearchEngine = { name, search };
  return { entry: { engine }, search };
}

const fakeRouter = {} as SmartRouter;

describe('search_engines allowlist (core tool boundary)', () => {
  const origEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...origEnv,
      WIGOLO_SEARCH: 'core',
      WIGOLO_RERANKER: 'none',
      VALIDATE_LINKS: 'false',
      LOG_LEVEL: 'error',
    };
    resetConfig();
    _resetSearchProviderForTest();
    verticalState.general = [];
    verticalState.news = [];
    verticalState.code = [];
    verticalState.docs = [];
    verticalState.papers = [];
    verticalState.images = [];
  });

  afterEach(() => {
    process.env = origEnv;
    resetConfig();
    _resetSearchProviderForTest();
  });

  it('dispatches only the named engines, even when Bing is in the default pool', async () => {
    const bing = makeEntry('bing', [makeResult('bing', 'https://bing.test/1')]);
    const ddg = makeEntry('duckduckgo', [makeResult('duckduckgo', 'https://ddg.test/1')]);
    const wiki = makeEntry('wikipedia', [makeResult('wikipedia', 'https://en.wikipedia.org/wiki/Gold')]);
    verticalState.general = [bing.entry, ddg.entry, wiki.entry];

    const r = await handleSearch(
      {
        query: 'gold price',
        search_engines: ['duckduckgo', 'wikipedia'],
        include_content: false,
      },
      [],
      fakeRouter,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(bing.search).not.toHaveBeenCalled();
    expect(ddg.search).toHaveBeenCalledOnce();
    expect(wiki.search).toHaveBeenCalledOnce();
    expect(r.data.engines_used.sort()).toEqual(['duckduckgo', 'wikipedia']);
  });

  it('pulls a requested engine from another vertical', async () => {
    const bing = makeEntry('bing', [makeResult('bing', 'https://bing.test/1')]);
    verticalState.general = [bing.entry];
    const so = makeEntry('stackoverflow', [makeResult('stackoverflow', 'https://stackoverflow.com/q/1')]);
    verticalState.code = [so.entry];

    const r = await handleSearch(
      {
        query: 'gold price',
        search_engines: ['stackoverflow'],
        include_content: false,
      },
      [],
      fakeRouter,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(bing.search).not.toHaveBeenCalled();
    expect(so.search).toHaveBeenCalledOnce();
    expect(r.data.engines_used).toEqual(['stackoverflow']);
  });

  it('falls back to the default pool when no requested name matches', async () => {
    const bing = makeEntry('bing', [makeResult('bing', 'https://bing.test/1')]);
    verticalState.general = [bing.entry];

    const r = await handleSearch(
      {
        query: 'gold price',
        search_engines: ['not-a-real-engine'],
        include_content: false,
      },
      [],
      fakeRouter,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(bing.search).toHaveBeenCalledOnce();
    expect(r.data.engines_used).toEqual(['bing']);
    const warn = r.data.engine_warnings?.find((w) => w.engine === 'not-a-real-engine');
    expect(warn).toMatchObject({
      engine: 'not-a-real-engine',
      code: 'unknown_engine',
    });
    expect(warn?.hint).toMatch(/available:/);
    expect(warn?.message).toMatch(/default pool/);
  });

  it('surfaces unknown names in engine_warnings when some engines still match', async () => {
    const ddg = makeEntry('duckduckgo', [makeResult('duckduckgo', 'https://ddg.test/1')]);
    verticalState.general = [ddg.entry];

    const r = await handleSearch(
      {
        query: 'gold price',
        search_engines: ['duckduckgo', 'google'],
        include_content: false,
      },
      [],
      fakeRouter,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(ddg.search).toHaveBeenCalledOnce();
    expect(r.data.engines_used).toEqual(['duckduckgo']);
    const warn = r.data.engine_warnings?.find((w) => w.engine === 'google');
    expect(warn).toMatchObject({
      engine: 'google',
      code: 'unknown_engine',
    });
    expect(warn?.message).toMatch(/ignored/);
    expect(warn?.hint).toMatch(/duckduckgo/);
  });
});
