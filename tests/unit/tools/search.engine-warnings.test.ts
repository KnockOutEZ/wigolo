// Integration test at the MCP tool boundary.
//
// WHY: per memory `feedback_slice_brief_integration_surface`, shipping a
// module behind an MCP tool MUST include an integration test at the tool
// boundary, not just module-level unit coverage. Module-level wiring is
// covered in tests/unit/search/engine-warnings.test.ts; this asserts that
// `handleSearch` (the tool handler) actually returns the engine_warnings
// field on the response shape when an engine errors.

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
} = { general: [], news: [], code: [], docs: [], papers: [] };

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

import { handleSearch } from '../../../src/tools/search.js';
import { _resetSearchProviderForTest } from '../../../src/providers/search-provider.js';
import { resetConfig } from '../../../src/config.js';
import { initDatabase, closeDatabase } from '../../../src/cache/db.js';

function makeResult(engineName: string, url: string): RawSearchResult {
  return { title: 'T', url, snippet: 'S', relevance_score: 1, engine: engineName };
}

function makeEntry(name: string, results: RawSearchResult[]): EngineEntry {
  const engine: SearchEngine = {
    name,
    search: vi.fn(async (_q: string, _opts?: SearchEngineOptions) => results),
  };
  return { engine };
}

function makeFailingEntry(name: string, message: string): EngineEntry {
  const engine: SearchEngine = {
    name,
    search: vi.fn(async () => {
      throw new Error(message);
    }),
  };
  return { engine };
}

const fakeRouter = {} as SmartRouter;

describe('handleSearch — engine_warnings (M2 integration)', () => {
  const origEnv = process.env;

  beforeEach(() => {
    // WHY: the suite default (tests/setup.ts) pins WIGOLO_SEARCH=searxng, and
    // getSearchProvider() resolves the backend through the cached getConfig().
    // Without resetConfig() the stale 'searxng' value selects the legacy
    // provider, which reaches for the cache DB and throws "Database not
    // initialized" before any core dispatch runs. Pin core + reset config +
    // init an in-memory DB so the engine_warnings assertions exercise the
    // core provider in isolation. VALIDATE_LINKS/LOG_LEVEL keep the run off
    // the network and quiet, matching tests/integration/filter-enforcement.ts.
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
  });

  afterEach(() => {
    closeDatabase();
    process.env = origEnv;
    resetConfig();
    _resetSearchProviderForTest();
  });

  it('search tool response carries engine_warnings array (empty when no engine errored)', async () => {
    verticalState.general = [
      makeEntry('bing', [makeResult('bing', 'https://a.com/x')]),
    ];
    const r = await handleSearch(
      { query: 'q', include_content: false },
      [],
      fakeRouter,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Array.isArray(r.data.engine_warnings)).toBe(true);
    expect(r.data.engine_warnings).toEqual([]);
  });

  it('search tool surfaces a 400-style engine failure in engine_warnings', async () => {
    verticalState.general = [
      makeEntry('bing', [makeResult('bing', 'https://a.com/x')]),
      makeFailingEntry('lobsters', 'Lobsters returned 400'),
    ];
    const r = await handleSearch(
      { query: 'q', include_content: false },
      [],
      fakeRouter,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.engine_warnings).toBeDefined();
    const warn = r.data.engine_warnings!.find((w) => w.engine === 'lobsters');
    expect(warn).toBeDefined();
    expect(warn!.code).toBe('http_400');
  });

  it('search tool emits WIGOLO_GITHUB_TOKEN hint on github-code 401 via tool boundary', async () => {
    verticalState.code = [
      makeFailingEntry('github-code', 'GitHub code returned 401'),
      makeEntry('mdn', [makeResult('mdn', 'https://developer.mozilla.org/x')]),
    ];
    const r = await handleSearch(
      { query: 'q', category: 'code', include_content: false },
      [],
      fakeRouter,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.engine_warnings).toBeDefined();
    const warn = r.data.engine_warnings!.find((w) => w.engine === 'github-code');
    expect(warn).toBeDefined();
    expect(warn!.code).toBe('http_401');
    expect(warn!.hint).toMatch(/WIGOLO_GITHUB_TOKEN/);
  });
});
