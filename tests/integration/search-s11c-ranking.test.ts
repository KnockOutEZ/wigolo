import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  RawSearchResult,
  SearchEngine,
  SearchEngineOptions,
  SearchInput,
} from '../../src/types.js';
import type { EngineEntry } from '../../src/search/core/engine-base.js';
import type { SearchContext } from '../../src/providers/search-provider.js';

// S11c integration test at the CoreSearchProvider boundary.
//
// Memory `feedback_slice_brief_integration_surface` requires a tool-boundary
// integration test for every behavioural change. This file proves that:
//
//   1. tier-based RRF weighting is observable in the final search response,
//   2. cross-engine canonical URL dedup is observable in the final response,
//   3. low-recall query expansion is observable in `query_understanding.rewrites`.
//
// Mocks live at the vertical-engine layer so we exercise the full orchestrator
// pipeline (intent → engines → RRF → dedup → rerank → response shape) without
// hitting real HTTP.

type EngineQualityTier = 'high' | 'medium' | 'low';

const verticalState: { general: EngineEntry[] } = { general: [] };

vi.mock('../../src/search/core/verticals/general.js', () => ({
  getGeneralEngines: () => verticalState.general,
  _resetGeneralEnginesForTest: () => {
    verticalState.general = [];
  },
}));
vi.mock('../../src/search/core/verticals/news.js', () => ({
  getNewsEngines: () => [],
  _resetNewsEnginesForTest: () => {},
}));
vi.mock('../../src/search/core/verticals/code.js', () => ({
  getCodeEngines: () => [],
  _resetCodeEnginesForTest: () => {},
}));
vi.mock('../../src/search/core/verticals/docs.js', () => ({
  getDocsEngines: () => [],
  _resetDocsEnginesForTest: () => {},
}));
vi.mock('../../src/search/core/verticals/papers.js', () => ({
  getPapersEngines: () => [],
  _resetPapersEnginesForTest: () => {},
}));

const { CoreSearchProvider } = await import('../../src/search/core/core-provider.js');
const { initDatabase, closeDatabase } = await import('../../src/cache/db.js');

function makeResult(
  engineName: string,
  url: string,
  title = url,
  snippet = `snippet for ${url}`,
): RawSearchResult {
  return {
    title,
    url,
    snippet,
    relevance_score: 1,
    engine: engineName,
  };
}

function makeEntry(
  name: string,
  results: RawSearchResult[],
  extra: { quality?: EngineQualityTier; weight?: number } = {},
): EngineEntry & { quality?: EngineQualityTier } {
  const engine: SearchEngine = {
    name,
    search: vi.fn(async (_q: string, _opts?: SearchEngineOptions) => results),
  };
  return {
    engine,
    ...(extra.weight !== undefined ? { weight: extra.weight } : {}),
    ...(extra.quality !== undefined ? { quality: extra.quality } : {}),
  };
}

function mockCtx(): SearchContext {
  return {};
}

describe('S11c integration — tool-boundary observable behaviour', () => {
  beforeEach(() => {
    initDatabase(':memory:');
    verticalState.general = [];
  });
  afterEach(() => {
    closeDatabase();
  });

  describe('tier-based RRF weights visible end-to-end', () => {
    it('the high-tier engine result outranks the low-tier engine result in the search response', async () => {
      verticalState.general = [
        makeEntry(
          'low',
          [makeResult('low', 'https://low.test/x', 'low title', 'arbitrary body')],
          { quality: 'low' },
        ),
        makeEntry(
          'high',
          [makeResult('high', 'https://high.test/x', 'high title', 'arbitrary body')],
          { quality: 'high' },
        ),
      ];

      const input: SearchInput = {
        query: 'opaque generic query no lexical signal',
        include_content: false,
      };
      const provider = new CoreSearchProvider();
      const result = await provider.search(input, mockCtx());
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const urls = result.data.results.map((r) => r.url);
      const highIdx = urls.indexOf('https://high.test/x');
      const lowIdx = urls.indexOf('https://low.test/x');
      expect(highIdx).toBeGreaterThanOrEqual(0);
      expect(lowIdx).toBeGreaterThanOrEqual(0);
      expect(highIdx).toBeLessThan(lowIdx);
    });
  });

  describe('low-recall query expansion visible end-to-end', () => {
    it('fires an auto-rewrite when initial query produces <= LOW_RECALL_THRESHOLD results, and the rewrite increases recall', async () => {
      // Engine returns one result for the original query, three more for the
      // expanded query. The provider should fire one auto-rewrite, fuse the
      // expanded results, and end up with > 1 result.
      let callCount = 0;
      const seenQueries: string[] = [];
      const engine: SearchEngine = {
        name: 'mock',
        search: vi.fn(async (q: string) => {
          callCount += 1;
          seenQueries.push(q);
          if (callCount === 1) {
            // Sparse initial result
            return [makeResult('mock', 'https://result.test/a', 'a', 'body')];
          }
          // Expanded query brings in more results
          return [
            makeResult('mock', 'https://result.test/b', 'b', 'body'),
            makeResult('mock', 'https://result.test/c', 'c', 'body'),
            makeResult('mock', 'https://result.test/d', 'd', 'body'),
          ];
        }),
      };
      verticalState.general = [{ engine }];

      const input: SearchInput = {
        // "RAG" has an acronym expansion in the static map -> the rewrite
        // adds "retrieval augmented generation" so engines see fuller query.
        query: 'RAG tutorial overview',
        include_content: false,
      };
      const provider = new CoreSearchProvider();
      const result = await provider.search(input, mockCtx());
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // The provider must have invoked the engine twice: once for the
      // original query, once for the rewrite.
      expect(callCount).toBe(2);
      // The auto-rewrite is surfaced through query_understanding.rewrites.
      expect(result.data.query_understanding?.rewrites?.length ?? 0).toBeGreaterThan(0);
      const rewrites = result.data.query_understanding?.rewrites ?? [];
      expect(
        rewrites.some((r) => r.toLowerCase().includes('retrieval augmented generation')),
      ).toBe(true);
      // Recall went up.
      expect(result.data.results.length).toBeGreaterThan(1);
    });

    it('does NOT fire when the initial result count is above the threshold', async () => {
      let callCount = 0;
      const engine: SearchEngine = {
        name: 'mock',
        search: vi.fn(async () => {
          callCount += 1;
          return [
            makeResult('mock', 'https://r.test/1', '1', 'body'),
            makeResult('mock', 'https://r.test/2', '2', 'body'),
            makeResult('mock', 'https://r.test/3', '3', 'body'),
            makeResult('mock', 'https://r.test/4', '4', 'body'),
            makeResult('mock', 'https://r.test/5', '5', 'body'),
          ];
        }),
      };
      verticalState.general = [{ engine }];

      const input: SearchInput = {
        query: 'RAG tutorial pipeline overview',
        include_content: false,
      };
      const provider = new CoreSearchProvider();
      const result = await provider.search(input, mockCtx());
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Only one call — the initial query produced 5 results, no rewrite.
      expect(callCount).toBe(1);
      // No auto-rewrite surfaced.
      const rewrites = result.data.query_understanding?.rewrites ?? [];
      const hasAuto = rewrites.some((r) =>
        r.toLowerCase().includes('retrieval augmented generation'),
      );
      expect(hasAuto).toBe(false);
    });

    it('does NOT fire when the query has no expandable token', async () => {
      let callCount = 0;
      const engine: SearchEngine = {
        name: 'mock',
        search: vi.fn(async () => {
          callCount += 1;
          // Sparse return so the threshold *would* trigger if a rewrite were
          // available — but the query has no expandable token, so the
          // provider must not retry.
          return [makeResult('mock', 'https://r.test/lonely', 'a', 'body')];
        }),
      };
      verticalState.general = [{ engine }];

      const input: SearchInput = {
        query: 'the and of', // all stop-words, no expansion possible
        include_content: false,
      };
      const provider = new CoreSearchProvider();
      const result = await provider.search(input, mockCtx());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(callCount).toBe(1);
    });
  });

  describe('canonical URL dedup visible end-to-end', () => {
    it('utm-tagged and untagged variants merge into one row in the final result list', async () => {
      verticalState.general = [
        makeEntry('a', [
          makeResult('a', 'https://foo.test/x?utm_source=alpha', 'page x', 'body'),
        ]),
        makeEntry('b', [
          makeResult('b', 'https://foo.test/x', 'page x', 'body'),
        ]),
      ];

      const input: SearchInput = {
        query: 'foo test bar baz',
        include_content: false,
      };
      const provider = new CoreSearchProvider();
      const result = await provider.search(input, mockCtx());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const matches = result.data.results.filter((r) => /foo\.test\/x/.test(r.url));
      expect(matches.length).toBe(1);
    });

    it('AMP, mobile, trailing-slash, and protocol variants all merge across engines', async () => {
      verticalState.general = [
        makeEntry('a', [
          makeResult('a', 'https://foo.test/amp/x', 'amp', 'body'),
        ]),
        makeEntry('b', [
          makeResult('b', 'http://m.foo.test/x/', 'mobile', 'body'),
        ]),
        makeEntry('c', [
          makeResult('c', 'https://www.foo.test/x', 'desktop', 'body'),
        ]),
      ];

      const input: SearchInput = {
        query: 'foo test bar baz',
        include_content: false,
      };
      const provider = new CoreSearchProvider();
      const result = await provider.search(input, mockCtx());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const matches = result.data.results.filter((r) => /foo\.test/.test(r.url));
      expect(matches.length).toBe(1);
    });

    it('distinct paths under the same host stay separate (negative case)', async () => {
      verticalState.general = [
        makeEntry('a', [
          makeResult('a', 'https://foo.test/x', 'x', 'body'),
          makeResult('a', 'https://foo.test/y', 'y', 'body'),
        ]),
      ];

      const input: SearchInput = {
        query: 'foo test bar baz',
        include_content: false,
      };
      const provider = new CoreSearchProvider();
      const result = await provider.search(input, mockCtx());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const xs = result.data.results.filter((r) => r.url.endsWith('/x'));
      const ys = result.data.results.filter((r) => r.url.endsWith('/y'));
      expect(xs.length).toBe(1);
      expect(ys.length).toBe(1);
    });
  });
});
