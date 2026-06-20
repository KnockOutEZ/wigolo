// Search filtering pipeline integration at the MCP tool boundary, exercised
// against the CORE search provider (WIGOLO_SEARCH=core, the production
// default).
//
// HISTORY: these tests originally injected fake `engine` objects into
// handleSearch(input, [engines], router) and asserted on engine.search calls
// plus a legacy overfetch multiplier (maxResults*3). The core provider
// resolves engines from the per-vertical modules (getGeneralEngines() etc.),
// ignores the passed `engines` argument, and has no overfetch multiplier.
// Rewritten to mock the vertical engine modules — mirroring
// tests/integration/filter-enforcement.test.ts. The end-to-end behaviours
// each test protects are preserved: multi-engine dedup + RRF fusion, hard
// include/exclude domain filtering across fused results, subdomain matching,
// date pass-through to engine options, the no-filter baseline, and the
// max_results cap under domain-filter attrition.

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
} = { general: [], news: [], code: [], docs: [], papers: [] };

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

import { handleSearch } from '../../src/tools/search.js';
import { _resetSearchProviderForTest } from '../../src/providers/search-provider.js';
import { resetConfig } from '../../src/config.js';
import { initDatabase, closeDatabase } from '../../src/cache/db.js';

function makeResult(engineName: string, url: string, relevance = 1): RawSearchResult {
  return { title: 'T', url, snippet: 'S', relevance_score: relevance, engine: engineName };
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

describe('search filtering pipeline integration (core provider)', () => {
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

  it('full pipeline: two engines -> dedup -> domain filter -> output', async () => {
    // react.dev/learn appears in both engines -> must fuse to a single row.
    // After the include_domains hard filter only react.dev + github.com hosts
    // survive: react.dev/learn, react.dev/blog, github.com/facebook/react.
    // The docs vertical is the one category:'docs' routes to.
    const searxng = makeEntry('searxng', [
      makeResult('searxng', 'https://react.dev/learn', 0.95),
      makeResult('searxng', 'https://react.dev/blog', 0.85),
      makeResult('searxng', 'https://medium.com/react', 0.8),
      makeResult('searxng', 'https://github.com/facebook/react', 0.75),
      makeResult('searxng', 'https://stackoverflow.com/q/react', 0.7),
    ]);
    const ddg = makeEntry('duckduckgo', [
      makeResult('duckduckgo', 'https://react.dev/learn', 0.9),
      makeResult('duckduckgo', 'https://w3schools.com/react', 0.65),
      makeResult('duckduckgo', 'https://dev.to/react-guide', 0.6),
    ]);
    verticalState.docs = [searxng.entry, ddg.entry];

    const r = await handleSearch(
      {
        query: 'react hooks tutorial',
        include_domains: ['react.dev', 'github.com'],
        category: 'docs',
        include_content: false,
        max_results: 10,
      },
      [],
      fakeRouter,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.data.results).toHaveLength(3);
    expect(
      r.data.results.every((res) =>
        res.url.includes('react.dev') || res.url.includes('github.com'),
      ),
    ).toBe(true);
    // react.dev/learn fused into a single deduped row, not two.
    const learn = r.data.results.filter((res) => res.url.includes('react.dev/learn'));
    expect(learn).toHaveLength(1);
    // Both engines contributed to the fused list.
    expect(r.data.engines_used).toContain('searxng');
    expect(r.data.engines_used).toContain('duckduckgo');
    // category routed the dispatch to the docs vertical: both docs engines
    // ran and carry `category: 'docs'`.
    expect(searxng.search).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ category: 'docs' }),
    );
    expect(ddg.search).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ category: 'docs' }),
    );
  });

  it('full pipeline: exclude_domains removes results after dedup', async () => {
    const eng = makeEntry('bing', [
      makeResult('bing', 'https://react.dev/a', 0.9),
      makeResult('bing', 'https://medium.com/b', 0.8),
      makeResult('bing', 'https://medium.com/c', 0.7),
      makeResult('bing', 'https://github.com/d', 0.6),
    ]);
    verticalState.general = [eng.entry];

    const r = await handleSearch(
      { query: 'react', exclude_domains: ['medium.com'], include_content: false },
      [],
      fakeRouter,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.results).toHaveLength(2);
    expect(r.data.results.every((res) => !res.url.includes('medium.com'))).toBe(true);
  });

  it('full pipeline: combined include + date filters keep subdomain matches', async () => {
    const eng = makeEntry('bing', [
      makeResult('bing', 'https://docs.react.dev/a', 0.9),
      makeResult('bing', 'https://blog.react.dev/b', 0.8),
      makeResult('bing', 'https://stackoverflow.com/c', 0.7),
    ]);
    verticalState.general = [eng.entry];

    const r = await handleSearch(
      {
        query: 'react hooks',
        include_domains: ['react.dev'],
        from_date: '2026-01-01',
        to_date: '2026-04-01',
        include_content: false,
      },
      [],
      fakeRouter,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // docs.react.dev and blog.react.dev both match react.dev (host-suffix);
    // stackoverflow.com is dropped. Results with no published_date survive
    // the date filter (best-effort, conservative keep).
    expect(r.data.results).toHaveLength(2);
    expect(r.data.results.every((res) => res.url.includes('react.dev'))).toBe(true);
    // Date params threaded into engine options.
    expect(eng.search).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        fromDate: '2026-01-01',
        toDate: '2026-04-01',
      }),
    );
  });

  it('full pipeline: no filters applied preserves all results', async () => {
    const eng = makeEntry('bing', [
      makeResult('bing', 'https://react.dev/a', 0.9),
      makeResult('bing', 'https://medium.com/b', 0.8),
      makeResult('bing', 'https://github.com/c', 0.7),
    ]);
    verticalState.general = [eng.entry];

    const r = await handleSearch(
      { query: 'react', include_content: false },
      [],
      fakeRouter,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.results).toHaveLength(3);
  });

  it('full pipeline: domain-filter attrition still caps to max_results', async () => {
    // Engine over-returns matching hosts; with include_domains active the
    // orchestrator filters then hard-caps to max_results. The core provider
    // over-fetches a bounded recall buffer (wave2.1 FIX4: max_results +
    // ceil(40%)) so the downstream score-floor / stale-demotion have
    // survivors to backfill from; the final slice still caps to max_results.
    // Here max_results=2 → buffered fetch of 3.
    const eng = makeEntry('bing', [
      makeResult('bing', 'https://react.dev/1', 0.9),
      makeResult('bing', 'https://react.dev/2', 0.85),
      makeResult('bing', 'https://react.dev/3', 0.8),
      makeResult('bing', 'https://react.dev/4', 0.75),
      makeResult('bing', 'https://medium.com/x', 0.7),
    ]);
    verticalState.general = [eng.entry];

    const r = await handleSearch(
      { query: 'react', max_results: 2, include_domains: ['react.dev'], include_content: false },
      [],
      fakeRouter,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(eng.search).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ maxResults: 3 }),
    );
    expect(r.data.results.length).toBeLessThanOrEqual(2);
    expect(r.data.results.every((res) => res.url.includes('react.dev'))).toBe(true);
  });
});
