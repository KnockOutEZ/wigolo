// Integration test at the MCP tool boundary for long-tail engine breadth.
//
// WHY: per memory `feedback_slice_brief_integration_surface`, every slice
// that ships a module behind an MCP tool MUST include an integration test
// at the tool boundary, not just module-level unit coverage. Adapter-level
// tests live in tests/unit/search/engines/mojeek.test.ts +
// marginalia.test.ts. This asserts the actual `handleSearch` response
// surfaces results + telemetry from the new long-tail engines after
// general-vertical wiring.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  SearchEngine,
  SearchEngineOptions,
  RawSearchResult,
} from '../../../src/types.js';
import type { SmartRouter } from '../../../src/fetch/router.js';
import type { EngineEntry } from '../../../src/search/core/engine-base.js';

const verticalState: {
  general: EngineEntry[];
  news: EngineEntry[];
  code: EngineEntry[];
  docs: EngineEntry[];
  papers: EngineEntry[];
  images: EngineEntry[];
} = { general: [], news: [], code: [], docs: [], papers: [], images: [] };

vi.mock('../../../src/search/core/verticals/general.js', () => ({
  getGeneralEngines: () => verticalState.general,
  _resetGeneralEnginesForTest: () => {
    verticalState.general = [];
  },
}));
vi.mock('../../../src/search/core/verticals/news.js', () => ({
  getNewsEngines: () => verticalState.news,
  _resetNewsEnginesForTest: () => {
    verticalState.news = [];
  },
}));
vi.mock('../../../src/search/core/verticals/code.js', () => ({
  getCodeEngines: () => verticalState.code,
  _resetCodeEnginesForTest: () => {
    verticalState.code = [];
  },
}));
vi.mock('../../../src/search/core/verticals/docs.js', () => ({
  getDocsEngines: () => verticalState.docs,
  _resetDocsEnginesForTest: () => {
    verticalState.docs = [];
  },
}));
vi.mock('../../../src/search/core/verticals/papers.js', () => ({
  getPapersEngines: () => verticalState.papers,
  _resetPapersEnginesForTest: () => {
    verticalState.papers = [];
  },
}));
vi.mock('../../../src/search/core/verticals/images.js', () => ({
  getImageEngines: () => verticalState.images,
  _resetImageEnginesForTest: () => {
    verticalState.images = [];
  },
}));

import { handleSearch } from '../../../src/tools/search.js';
import { _resetSearchProviderForTest } from '../../../src/providers/search-provider.js';
import { resetConfig } from '../../../src/config.js';
import { initDatabase, closeDatabase } from '../../../src/cache/db.js';

function makeResult(engineName: string, url: string): RawSearchResult {
  return { title: `${engineName}-${url}`, url, snippet: 'snippet', relevance_score: 1, engine: engineName };
}

function makeEntry(name: string, results: RawSearchResult[]): EngineEntry {
  const engine: SearchEngine = {
    name,
    search: vi.fn(async (_q: string, _opts?: SearchEngineOptions) => results),
  };
  return { engine };
}

const fakeRouter = {} as SmartRouter;

describe('handleSearch — long-tail engine integration (S11a)', () => {
  const origEnv = process.env;

  beforeEach(() => {
    // WHY: the suite default (tests/setup.ts) pins WIGOLO_SEARCH=searxng, and
    // getSearchProvider() resolves the backend through the cached getConfig().
    // Without resetConfig() the stale 'searxng' value selects the legacy
    // provider, which reaches for the cache DB and throws "Database not
    // initialized" before the long-tail engines ever dispatch on core. Pin
    // core + reset config + init an in-memory DB so the telemetry/warnings
    // assertions exercise the core provider in isolation.
    process.env = {
      ...origEnv,
      WIGOLO_SEARCH: 'core',
      WIGOLO_RERANKER: 'none',
      VALIDATE_LINKS: 'false',
      LOG_LEVEL: 'error',
    };
    resetConfig();
    _resetSearchProviderForTest();
    initDatabase(':memory:');
    verticalState.general = [];
    verticalState.news = [];
    verticalState.code = [];
    verticalState.docs = [];
    verticalState.papers = [];
    verticalState.images = [];
  });

  afterEach(() => {
    closeDatabase();
    process.env = origEnv;
    resetConfig();
    _resetSearchProviderForTest();
  });

  it('engine_telemetry lists mojeek when the general vertical includes it', async () => {
    verticalState.general = [
      makeEntry('bing', [makeResult('bing', 'https://a.example/x')]),
      makeEntry('mojeek', [makeResult('mojeek', 'https://b.example/y')]),
    ];

    const r = await handleSearch(
      { query: 'q', include_content: false },
      [],
      fakeRouter,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const names = (r.data.engine_telemetry ?? []).map((e) => e.name);
    expect(names).toContain('mojeek');
    // Mojeek's result must appear in the fused list — proves the engine
    // landed in the pool, not just the telemetry.
    expect(r.data.results.some((res) => res.url.includes('b.example'))).toBe(true);
  });

  it('engine_telemetry lists marginalia when the general vertical includes it', async () => {
    verticalState.general = [
      makeEntry('bing', [makeResult('bing', 'https://a.example/x')]),
      makeEntry('marginalia', [makeResult('marginalia', 'https://c.example/z')]),
    ];

    const r = await handleSearch(
      { query: 'q', include_content: false },
      [],
      fakeRouter,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const names = (r.data.engine_telemetry ?? []).map((e) => e.name);
    expect(names).toContain('marginalia');
    expect(r.data.results.some((res) => res.url.includes('c.example'))).toBe(true);
  });

  it('long-tail engine errors surface in engine_warnings without blocking the response', async () => {
    verticalState.general = [
      makeEntry('bing', [makeResult('bing', 'https://a.example/x')]),
      {
        engine: {
          name: 'mojeek',
          search: vi.fn(async () => {
            throw new Error('Mojeek returned 503');
          }),
        },
      },
    ];

    const r = await handleSearch(
      { query: 'q', include_content: false },
      [],
      fakeRouter,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.results.length).toBeGreaterThan(0);
    const warn = r.data.engine_warnings?.find((w) => w.engine === 'mojeek');
    expect(warn).toBeDefined();
    expect(warn!.code).toBe('http_503');
  });
});
