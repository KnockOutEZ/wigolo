// Search filtering at the MCP tool boundary, exercised against the CORE
// search provider (WIGOLO_SEARCH=core, the production default).
//
// HISTORY: these tests originally injected a fake `engine` object into
// handleSearch(input, [engine], router) and asserted on engine.search calls
// plus a legacy overfetch multiplier (maxResults*2 / *3). The core provider
// resolves engines from the per-vertical modules (getGeneralEngines() etc.)
// and ignores the passed `engines` argument entirely, and it has no overfetch
// multiplier. So the injected engine and the *N assertions targeted a removed
// seam. Rewritten to mock the vertical engine modules (the seam core actually
// reads) — mirroring tests/unit/search/include-domains-hard-filter.test.ts
// and tests/integration/filter-enforcement.test.ts. The behaviours each test
// protects are preserved: include/exclude domain filtering, category routing,
// date pass-through to engine options, includeDomains pass-through to engine
// options, and empty-not-error on full attrition.

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

interface SpyEntry {
  entry: EngineEntry;
  search: ReturnType<typeof vi.fn>;
}

function makeEntry(name: string, results: RawSearchResult[]): SpyEntry {
  const search = vi.fn(async (_q: string, _opts?: SearchEngineOptions) => results);
  const engine: SearchEngine = { name, search };
  return { entry: { engine }, search };
}

const fakeRouter = {} as SmartRouter;

describe('search pipeline filtering (core provider)', () => {
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

  // 1. include_domains is a hard filter: only matching hosts survive.
  it('filters results by include_domains in pipeline', async () => {
    const eng = makeEntry('bing', [
      makeResult('bing', 'https://react.dev/docs'),
      makeResult('bing', 'https://medium.com/react'),
      makeResult('bing', 'https://github.com/react'),
    ]);
    verticalState.general = [eng.entry];

    const r = await handleSearch(
      { query: 'react', include_domains: ['react.dev'], include_content: false },
      [],
      fakeRouter,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.results).toHaveLength(1);
    expect(r.data.results[0].url).toContain('react.dev');
  });

  // 2. exclude_domains hard-drops matched hosts.
  it('filters results by exclude_domains in pipeline', async () => {
    const eng = makeEntry('bing', [
      makeResult('bing', 'https://react.dev/docs'),
      makeResult('bing', 'https://medium.com/react'),
    ]);
    verticalState.general = [eng.entry];

    const r = await handleSearch(
      { query: 'react', exclude_domains: ['medium.com'], include_content: false },
      [],
      fakeRouter,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.results).toHaveLength(1);
    expect(r.data.results[0].url).toContain('react.dev');
  });

  // 3. category routes the dispatch to the matching vertical's engines.
  // The legacy test asserted `category` landed in the engine's options; on
  // core, category selects WHICH vertical's engines run, so we prove routing
  // by seeding only the code vertical and confirming its engine fired (and
  // the general vertical's did not) when category: 'code' is requested.
  it('routes category to the matching vertical engines', async () => {
    // Seed the code vertical with enough results that the partial-starvation
    // backfill does not fire — otherwise a thin vertical would legitimately
    // pull in general, which is a different behaviour than the routing this
    // test protects.
    const codeEng = makeEntry('github-code', [
      makeResult('github-code', 'https://github.com/x/y'),
      makeResult('github-code', 'https://github.com/x/z'),
      makeResult('github-code', 'https://github.com/x/w'),
      makeResult('github-code', 'https://github.com/x/v'),
    ]);
    const generalEng = makeEntry('bing', [
      makeResult('bing', 'https://example.com/a'),
    ]);
    verticalState.code = [codeEng.entry];
    verticalState.general = [generalEng.entry];

    const r = await handleSearch(
      { query: 'react', category: 'code', include_content: false },
      [],
      fakeRouter,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(codeEng.search).toHaveBeenCalled();
    expect(generalEng.search).not.toHaveBeenCalled();
    // The code-vertical engine carries `category: 'code'` in its options.
    expect(codeEng.search).toHaveBeenCalledWith(
      'react',
      expect.objectContaining({ category: 'code' }),
    );
  });

  // 4. from_date / to_date are threaded into the engine search options so
  // date-aware engines can filter natively.
  it('passes from_date and to_date to engine search options', async () => {
    const eng = makeEntry('bing', []);
    verticalState.general = [eng.entry];

    await handleSearch(
      { query: 'react', from_date: '2026-01-01', to_date: '2026-04-01', include_content: false },
      [],
      fakeRouter,
    );

    expect(eng.search).toHaveBeenCalledWith(
      'react',
      expect.objectContaining({
        fromDate: '2026-01-01',
        toDate: '2026-04-01',
      }),
    );
  });

  // 5. Filters that strip every result return empty output, not an error.
  it('returns empty results when all filtered out (no error)', async () => {
    const eng = makeEntry('bing', [
      makeResult('bing', 'https://medium.com/a'),
    ]);
    verticalState.general = [eng.entry];

    const r = await handleSearch(
      { query: 'react', include_domains: ['nonexistent.dev'], include_content: false },
      [],
      fakeRouter,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.results).toEqual([]);
  });

  // 6. include_domains is threaded into the engine search options for native
  // engine-side filtering (the orchestrator still hard-filters defensively
  // after fusion, but the engines get the hint too).
  it('passes include_domains to engine options for native filtering', async () => {
    const eng = makeEntry('bing', []);
    verticalState.general = [eng.entry];

    await handleSearch(
      { query: 'react', include_domains: ['react.dev', 'github.com'], include_content: false },
      [],
      fakeRouter,
    );

    expect(eng.search).toHaveBeenCalledWith(
      'react',
      expect.objectContaining({
        includeDomains: ['react.dev', 'github.com'],
      }),
    );
  });

  // 6b. With a small include_domains set the orchestrator also injects a
  // site:-scoped operator into the dispatched query string so engines that
  // honour `site:` narrow at the source, not just post-filter after fusion.
  it('injects a site: operator into the dispatched query for a small include_domains set', async () => {
    const eng = makeEntry('bing', [makeResult('bing', 'https://react.dev/learn')]);
    verticalState.general = [eng.entry];

    await handleSearch(
      { query: 'react hooks', include_domains: ['react.dev'], include_content: false },
      [],
      fakeRouter,
    );

    const dispatchedQueries = eng.search.mock.calls.map((c) => c[0] as string);
    expect(dispatchedQueries.some((q) => q.includes('site:react.dev'))).toBe(true);
  });

  // 9. Starvation re-dispatch survives the full tool-boundary pipeline. A thin
  // code vertical (1 hit, below the starvation floor) backfills from general;
  // the merged general URL must survive fuseRankedLists → context-rank →
  // score-floor → slice to the handleSearch result, and engine_pool must carry
  // the starvation reason. WHY: the integration-surface invariant — a module
  // behind an MCP tool needs a test at the tool boundary, not just a unit test.
  it('surfaces a starvation-merged general URL and engine_pool at the tool boundary', async () => {
    const codeThin = makeEntry('github-code', [
      makeResult('github-code', 'https://github.com/x/only'),
    ]);
    const generalRich = makeEntry('bing', [
      makeResult('bing', 'https://example.com/g1'),
      makeResult('bing', 'https://example.com/g2'),
      makeResult('bing', 'https://example.com/g3'),
    ]);
    verticalState.code = [codeThin.entry];
    verticalState.general = [generalRich.entry];

    const r = await handleSearch(
      { query: 'fix typescript error', max_results: 10, include_content: false },
      [],
      fakeRouter,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const urls = r.data.results.map((x) => x.url);
    expect(urls).toContain('https://github.com/x/only');
    // A general-only URL merged through the full pipeline to the final result.
    expect(urls.some((u) => u.startsWith('https://example.com/g'))).toBe(true);
    // engine_pool is populated at the tool boundary and carries the reason.
    expect(r.data.engine_pool).toBeDefined();
    expect(r.data.engine_pool!.total).toBeGreaterThan(0);
    expect(r.data.engine_pool!.degraded).toBe(true);
    expect(r.data.engine_pool!.reasons).toContain('starvation_redispatch');
  });

  // 7. exclude_domains is likewise threaded into the engine search options.
  it('passes exclude_domains to engine options for native filtering', async () => {
    const eng = makeEntry('bing', []);
    verticalState.general = [eng.entry];

    await handleSearch(
      { query: 'react', exclude_domains: ['spam.com'], include_content: false },
      [],
      fakeRouter,
    );

    expect(eng.search).toHaveBeenCalledWith(
      'react',
      expect.objectContaining({
        excludeDomains: ['spam.com'],
      }),
    );
  });

  // 8. max_results drives the engine search options and caps the final result
  // count. Core over-fetches a bounded recall buffer (max_results + ceil(40%))
  // so the score-floor + recency demotion have survivors to backfill from, then
  // hard-caps the output to the caller's max_results after fusion — this
  // protects the buffered dispatch + post-fusion cap. (max_results 2 → buffered
  // dispatch 3 = 2 + ceil(2 * 0.4); output still capped to 2.)
  it('passes max_results to engine options and caps the output', async () => {
    const eng = makeEntry('bing', [
      makeResult('bing', 'https://a.example/1'),
      makeResult('bing', 'https://b.example/2'),
      makeResult('bing', 'https://c.example/3'),
      makeResult('bing', 'https://d.example/4'),
      makeResult('bing', 'https://e.example/5'),
    ]);
    verticalState.general = [eng.entry];

    const r = await handleSearch(
      { query: 'react', max_results: 2, include_content: false },
      [],
      fakeRouter,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(eng.search).toHaveBeenCalledWith(
      'react',
      expect.objectContaining({ maxResults: 3 }),
    );
    expect(r.data.results.length).toBeLessThanOrEqual(2);
  });
});
