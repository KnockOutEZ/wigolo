import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  SearchEngine,
  RawSearchResult,
  SearchEngineOptions,
  RawFetchResult,
  ExtractionResult,
} from '../../src/types.js';
import type { EngineEntry } from '../../src/search/core/engine-base.js';
import type { SmartRouter } from '../../src/fetch/router.js';
import { resetConfig } from '../../src/config.js';
import { initDatabase, closeDatabase } from '../../src/cache/db.js';
import { cacheContent } from '../../src/cache/store.js';

// Integration tests at the tool boundary for filter-enforcement. Hardening a
// module warrants a test at the tool boundary, not just module-level.
//
// These tests exercise:
//   - search response respects include_domains as a HARD filter
//   - search response respects exact_match across pre-dedup variants
//   - find_similar response respects threshold

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

const extractMock = vi.fn().mockResolvedValue({
  title: 'Mock',
  markdown: '# Mock',
  metadata: {},
  links: [],
  images: [],
  extractor: 'defuddle' as const,
});
vi.mock('../../src/providers/extract-provider.js', () => ({
  getExtractProvider: vi.fn(async () => ({
    name: 'v1' as const,
    extract: extractMock,
  })),
  _resetExtractProviderForTest: vi.fn(),
}));

const { handleSearch } = await import('../../src/tools/search.js');
const { handleFindSimilar } = await import('../../src/tools/find-similar.js');
const { _resetSearchProviderForTest } = await import('../../src/providers/search-provider.js');

function makeResult(engineName: string, url: string, title = 'T', snippet = 'S'): RawSearchResult {
  return { title, url, snippet, relevance_score: 1, engine: engineName };
}

function makeEntry(name: string, results: RawSearchResult[]): EngineEntry {
  const engine: SearchEngine = {
    name,
    search: vi.fn(async (_q: string, _opts?: SearchEngineOptions) => results),
  };
  return { engine };
}

function seedCache(url: string, title: string, markdown: string): void {
  const rawResult: RawFetchResult = {
    url,
    finalUrl: url,
    html: `<html><body><h1>${title}</h1><p>${markdown}</p></body></html>`,
    contentType: 'text/html',
    statusCode: 200,
    method: 'http',
    headers: {},
  };
  const extraction: ExtractionResult = {
    title,
    markdown,
    metadata: {},
    links: [],
    images: [],
    extractor: 'defuddle',
  };
  cacheContent(rawResult, extraction);
}

const mockRouter = {
  fetch: vi.fn().mockResolvedValue({
    url: 'https://example.com',
    finalUrl: 'https://example.com',
    html: '<p>x</p>',
    contentType: 'text/html',
    statusCode: 200,
    method: 'http' as const,
    headers: {},
  }),
} as unknown as SmartRouter;

const mockEngine: SearchEngine = {
  name: 'mock',
  search: vi.fn().mockResolvedValue([] satisfies RawSearchResult[]),
};

describe('slice-3 filter enforcement at the tool boundary', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      VALIDATE_LINKS: 'false',
      LOG_LEVEL: 'error',
      // Exercise the CORE backend (where the bugs live). The default test
      // setup pins WIGOLO_SEARCH=searxng so we have to override per-test.
      WIGOLO_SEARCH: 'core',
      // Stop the cold_start weak-signal rescore from masking fused_score.
      WIGOLO_FIND_SIMILAR_COLD_START_THRESHOLD: '0',
    };
    resetConfig();
    _resetSearchProviderForTest();
    initDatabase(':memory:');
    verticalState.general = [];
    verticalState.news = [];
    verticalState.code = [];
    verticalState.docs = [];
    verticalState.papers = [];
    vi.clearAllMocks();
  });

  afterEach(() => {
    closeDatabase();
    process.env = originalEnv;
    resetConfig();
    _resetSearchProviderForTest();
  });

  // C8 at the tool boundary — handleSearch output must contain ZERO off-domain
  // results when include_domains is set.
  it('C8: search response has zero off-domain results when include_domains is set', async () => {
    verticalState.general = [
      makeEntry('engine-a', [
        makeResult('engine-a', 'https://react.dev/learn', 'React Learn', 'Learn React'),
        makeResult('engine-a', 'https://medium.com/x', 'Medium x', 'snippet'),
        makeResult('engine-a', 'https://blog.example.com/y', 'Blog y', 'snippet'),
        makeResult('engine-a', 'https://stackoverflow.com/q/1', 'SO', 'snippet'),
      ]),
    ];

    const r = await handleSearch(
      {
        query: 'react',
        include_domains: ['react.dev'],
        include_content: false,
      },
      [mockEngine],
      mockRouter,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const hosts = r.data.results.map((res) => new URL(res.url).hostname);
    for (const h of hosts) {
      expect(h === 'react.dev' || h.endsWith('.react.dev')).toBe(true);
    }
  });

  // C8 — exclude_domains regression (W2): excluded hosts never appear.
  it('C8/W2: search response strips excluded domains', async () => {
    verticalState.general = [
      makeEntry('engine-a', [
        makeResult('engine-a', 'https://keep.com/a', 'Keep', 'k'),
        makeResult('engine-a', 'https://spam.com/x', 'Spam', 's'),
      ]),
    ];

    const r = await handleSearch(
      {
        query: 'q',
        exclude_domains: ['spam.com'],
        include_content: false,
      },
      [mockEngine],
      mockRouter,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const hosts = r.data.results.map((res) => new URL(res.url).hostname);
    expect(hosts).not.toContain('spam.com');
    expect(hosts).toContain('keep.com');
  });

  // C7 at the tool boundary — exact_match must not drop a URL when ANY
  // contributing engine carried the phrase.
  it('C7: search response keeps a URL when a non-first engine matches the exact phrase', async () => {
    verticalState.general = [
      makeEntry('engine-a', [
        makeResult(
          'engine-a',
          'https://react.dev/reference/react/useState',
          'React Reference',
          'Sanitised snippet without the phrase.',
        ),
      ]),
      makeEntry('engine-b', [
        makeResult(
          'engine-b',
          'https://react.dev/reference/react/useState',
          'useState hook reference',
          'Mentions useState hook explicitly.',
        ),
      ]),
    ];

    const r = await handleSearch(
      {
        query: 'useState hook',
        exact_match: true,
        include_content: false,
      },
      [mockEngine],
      mockRouter,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const urls = r.data.results.map((res) => res.url);
    expect(urls).toContain('https://react.dev/reference/react/useState');
  });

  // H8 at the tool boundary — find_similar response respects threshold.
  it('H8: find_similar response drops results below the threshold', async () => {
    for (let i = 0; i < 5; i++) {
      seedCache(
        `https://noise-${i}.example`,
        `Framework Note ${i}`,
        `# Framework Note ${i}\n\nA short note about an unrelated **framework**.`,
      );
    }

    const r = await handleFindSimilar(
      {
        concept: 'framework',
        include_cache: true,
        include_web: false,
        threshold: 0.9,
      },
      [mockEngine],
      mockRouter,
    );

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const res of r.data.results) {
      expect(res.match_signals.fused_score).toBeGreaterThanOrEqual(0.9);
    }
  });

  // H8 — find_similar threshold:0 baseline parity.
  it('H8: find_similar threshold:0 returns the same set as omitting threshold', async () => {
    seedCache(
      'https://react.dev/hooks',
      'React Hooks',
      '# React Hooks\n\nHooks for **state**.',
    );

    const baseline = await handleFindSimilar(
      { concept: 'React hooks', include_cache: true, include_web: false },
      [mockEngine],
      mockRouter,
    );
    const withZero = await handleFindSimilar(
      { concept: 'React hooks', include_cache: true, include_web: false, threshold: 0 },
      [mockEngine],
      mockRouter,
    );

    expect(baseline.ok && withZero.ok).toBe(true);
    if (!baseline.ok || !withZero.ok) return;
    expect(withZero.data.results.length).toBe(baseline.data.results.length);
  });
});
