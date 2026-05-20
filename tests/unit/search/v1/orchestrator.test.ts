import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  SearchEngine,
  SearchEngineOptions,
  RawSearchResult,
} from '../../../../src/types.js';
import type { EngineEntry } from '../../../../src/search/v1/engine-base.js';

// State injected per-test via the vi.mock factory below.
const verticalState: {
  general: EngineEntry[];
  news: EngineEntry[];
  code: EngineEntry[];
  docs: EngineEntry[];
  papers: EngineEntry[];
} = {
  general: [],
  news: [],
  code: [],
  docs: [],
  papers: [],
};

vi.mock('../../../../src/search/v1/verticals/general.js', () => ({
  getGeneralEngines: () => verticalState.general,
  _resetGeneralEnginesForTest: () => {
    verticalState.general = [];
  },
}));
vi.mock('../../../../src/search/v1/verticals/news.js', () => ({
  getNewsEngines: () => verticalState.news,
  _resetNewsEnginesForTest: () => {
    verticalState.news = [];
  },
}));
vi.mock('../../../../src/search/v1/verticals/code.js', () => ({
  getCodeEngines: () => verticalState.code,
  _resetCodeEnginesForTest: () => {
    verticalState.code = [];
  },
}));
vi.mock('../../../../src/search/v1/verticals/docs.js', () => ({
  getDocsEngines: () => verticalState.docs,
  _resetDocsEnginesForTest: () => {
    verticalState.docs = [];
  },
}));
vi.mock('../../../../src/search/v1/verticals/papers.js', () => ({
  getPapersEngines: () => verticalState.papers,
  _resetPapersEnginesForTest: () => {
    verticalState.papers = [];
  },
}));

const { runV1Search } = await import(
  '../../../../src/search/v1/orchestrator.js'
);

function makeResult(
  engineName: string,
  url: string,
  title = url,
  score = 1,
): RawSearchResult {
  return {
    title,
    url,
    snippet: `snippet for ${title}`,
    relevance_score: score,
    engine: engineName,
  };
}

interface MockEngineConfig {
  name: string;
  results?: RawSearchResult[];
  shouldFail?: boolean;
  shouldSkip?: boolean;
  failError?: string;
}

function makeMockEngine(cfg: MockEngineConfig): {
  engine: SearchEngine;
  spy: ReturnType<typeof vi.fn>;
} {
  const spy = vi.fn(
    async (_q: string, _opts?: SearchEngineOptions): Promise<RawSearchResult[]> => {
      if (cfg.shouldSkip) {
        const err = new Error(`breaker open for engine ${cfg.name}`);
        err.name = 'BreakerOpenError';
        throw err;
      }
      if (cfg.shouldFail) {
        throw new Error(cfg.failError ?? 'engine failed');
      }
      return cfg.results ?? [];
    },
  );
  return {
    engine: { name: cfg.name, search: spy },
    spy,
  };
}

function makeEntry(
  cfg: MockEngineConfig & { weight?: number; supportsDateFilter?: boolean },
): { entry: EngineEntry; spy: ReturnType<typeof vi.fn> } {
  const { engine, spy } = makeMockEngine(cfg);
  return {
    entry: {
      engine,
      weight: cfg.weight,
      supportsDateFilter: cfg.supportsDateFilter,
    },
    spy,
  };
}

beforeEach(() => {
  verticalState.general = [];
  verticalState.news = [];
  verticalState.code = [];
  verticalState.docs = [];
  verticalState.papers = [];
});

describe('runV1Search — vertical routing', () => {
  it('routes "fix typescript error" to the code vertical', async () => {
    const { entry, spy } = makeEntry({
      name: 'github-code',
      results: [makeResult('github-code', 'https://gh.test/x')],
    });
    verticalState.code = [entry];

    const out = await runV1Search({ query: 'fix typescript error' });
    expect(out.vertical).toBe('code');
    expect(spy).toHaveBeenCalledOnce();
  });

  it('routes "arxiv paper rust" to the papers vertical', async () => {
    const { entry } = makeEntry({
      name: 'arxiv',
      results: [makeResult('arxiv', 'https://arxiv.org/abs/123')],
    });
    verticalState.papers = [entry];

    const out = await runV1Search({ query: 'arxiv paper rust' });
    expect(out.vertical).toBe('papers');
  });

  it('routes "latest news AI" to the news vertical', async () => {
    const { entry } = makeEntry({
      name: 'hn',
      results: [makeResult('hn', 'https://news.test/1')],
    });
    verticalState.news = [entry];

    const out = await runV1Search({ query: 'latest news AI' });
    expect(out.vertical).toBe('news');
  });

  it('routes a generic query to the general vertical', async () => {
    const { entry } = makeEntry({
      name: 'bing',
      results: [makeResult('bing', 'https://example.com/x')],
    });
    verticalState.general = [entry];

    const out = await runV1Search({ query: 'cute cats' });
    expect(out.vertical).toBe('general');
  });

  it('honors the category hint and overrides the classifier', async () => {
    const { entry } = makeEntry({
      name: 'hn',
      results: [makeResult('hn', 'https://news.test/x')],
    });
    verticalState.news = [entry];

    const out = await runV1Search({
      query: 'fix typescript error', // would otherwise classify as code
      category: 'news',
    });
    expect(out.vertical).toBe('news');
  });
});

describe('runV1Search — date-bounded routing', () => {
  it('promotes a query with fromDate to news vertical via hasDateBound', async () => {
    const { entry } = makeEntry({
      name: 'hn',
      supportsDateFilter: true,
      results: [makeResult('hn', 'https://news.test/a')],
    });
    verticalState.news = [entry];

    const out = await runV1Search({
      query: 'foobar widgets',
      fromDate: '2025-01-01',
    });
    expect(out.vertical).toBe('news');
  });

  it('filters out engines lacking date support when date is bound', async () => {
    const dateAware = makeEntry({
      name: 'stackoverflow',
      supportsDateFilter: true,
      results: [makeResult('stackoverflow', 'https://stackoverflow.com/q/1')],
    });
    const dateNaive = makeEntry({
      name: 'github-code',
      supportsDateFilter: false,
      results: [makeResult('github-code', 'https://gh.test/y')],
    });
    verticalState.code = [dateNaive.entry, dateAware.entry];

    const out = await runV1Search({
      query: 'typescript fix compile error',
      category: 'code',
      fromDate: '2025-01-01',
    });
    expect(dateNaive.spy).not.toHaveBeenCalled();
    expect(dateAware.spy).toHaveBeenCalledOnce();
    expect(out.enginesUsed).toEqual(['stackoverflow']);
  });

  it('falls back to all engines when date filter would remove everything', async () => {
    const dateNaive1 = makeEntry({
      name: 'mdn',
      supportsDateFilter: false,
      results: [makeResult('mdn', 'https://mdn.test/a')],
    });
    const dateNaive2 = makeEntry({
      name: 'devdocs',
      supportsDateFilter: false,
      results: [makeResult('devdocs', 'https://devdocs.test/a')],
    });
    verticalState.docs = [dateNaive1.entry, dateNaive2.entry];

    const out = await runV1Search({
      query: 'how to async iterator',
      category: 'docs',
      fromDate: '2025-01-01',
    });
    expect(dateNaive1.spy).toHaveBeenCalledOnce();
    expect(dateNaive2.spy).toHaveBeenCalledOnce();
    expect(out.degraded).toBe(false);
    expect(out.enginesUsed.sort()).toEqual(['devdocs', 'mdn']);
  });
});

describe('runV1Search — RRF fusion', () => {
  it('fuses overlapping URLs across two equal-weight engines', async () => {
    const sharedUrl = 'https://shared.test/1';
    const a = makeEntry({
      name: 'a',
      weight: 1,
      results: [
        makeResult('a', sharedUrl),
        makeResult('a', 'https://a.test/only'),
      ],
    });
    const b = makeEntry({
      name: 'b',
      weight: 1,
      results: [
        makeResult('b', sharedUrl),
        makeResult('b', 'https://b.test/only'),
      ],
    });
    verticalState.general = [a.entry, b.entry];

    const out = await runV1Search({ query: 'general query' });
    expect(out.results[0].url).toBe(sharedUrl);
    // The two unique URLs follow with equal fused score.
    const tail = out.results.slice(1).map((r) => r.url).sort();
    expect(tail).toEqual(['https://a.test/only', 'https://b.test/only']);
  });

  it('applies per-engine weight: heavier engine pulls its top hit higher', async () => {
    // Two engines return disjoint URLs. The first-rank URL from each scores
    // weight/(60+1). With equal weights, ordering is engine-arrival (a before b).
    // With weight=2 on the second engine, its rank-1 URL should beat the
    // first engine's rank-1 URL.
    const a = makeEntry({
      name: 'a',
      weight: 1.0,
      results: [makeResult('a', 'https://a.test/top')],
    });
    const b = makeEntry({
      name: 'b',
      weight: 2.0,
      results: [makeResult('b', 'https://b.test/top')],
    });
    verticalState.general = [a.entry, b.entry];

    const out = await runV1Search({ query: 'something' });
    // b/61 = 2/61 > 1/61, so b's URL should rank first.
    expect(out.results[0].url).toBe('https://b.test/top');
    expect(out.results[1].url).toBe('https://a.test/top');
  });

  it('weighted fusion: shared overlap with heavier engine outranks unique', async () => {
    const sharedUrl = 'https://overlap.test/x';
    const heavy = makeEntry({
      name: 'heavy',
      weight: 2.0,
      results: [
        makeResult('heavy', 'https://heavy.test/unique'),
        makeResult('heavy', sharedUrl),
      ],
    });
    const light = makeEntry({
      name: 'light',
      weight: 1.0,
      results: [
        makeResult('light', 'https://light.test/unique'),
        makeResult('light', sharedUrl),
      ],
    });
    verticalState.general = [heavy.entry, light.entry];

    const out = await runV1Search({ query: 'something' });
    // shared = 2/62 + 1/62 = 3/62 ≈ 0.0484
    // heavy unique = 2/61 ≈ 0.0328
    // light unique = 1/61 ≈ 0.0164
    expect(out.results.map((r) => r.url)).toEqual([
      sharedUrl,
      'https://heavy.test/unique',
      'https://light.test/unique',
    ]);
  });
});

describe('runV1Search — domain filters', () => {
  it('keeps only URLs matching includeDomains', async () => {
    const { entry } = makeEntry({
      name: 'bing',
      results: [
        makeResult('bing', 'https://allowed.com/a'),
        makeResult('bing', 'https://denied.com/a'),
        makeResult('bing', 'https://sub.allowed.com/b'),
      ],
    });
    verticalState.general = [entry];

    const out = await runV1Search({
      query: 'general query',
      includeDomains: ['allowed.com'],
    });
    const hosts = out.results.map((r) => new URL(r.url).hostname);
    expect(hosts).toContain('allowed.com');
    expect(hosts).toContain('sub.allowed.com');
    expect(hosts).not.toContain('denied.com');
  });

  it('strips URLs matching excludeDomains', async () => {
    const { entry } = makeEntry({
      name: 'bing',
      results: [
        makeResult('bing', 'https://keep.com/a'),
        makeResult('bing', 'https://block.com/a'),
      ],
    });
    verticalState.general = [entry];

    const out = await runV1Search({
      query: 'general query',
      excludeDomains: ['block.com'],
    });
    const hosts = out.results.map((r) => new URL(r.url).hostname);
    expect(hosts).toEqual(['keep.com']);
  });
});

describe('runV1Search — degraded paths', () => {
  it('returns immediately with degraded=true on empty query', async () => {
    const { entry, spy } = makeEntry({
      name: 'bing',
      results: [makeResult('bing', 'https://example.com')],
    });
    verticalState.general = [entry];

    const out = await runV1Search({ query: '   ' });
    expect(out.degraded).toBe(true);
    expect(out.results).toEqual([]);
    expect(out.enginesUsed).toEqual([]);
    expect(out.outcomes).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('marks degraded=true when every engine fails', async () => {
    const a = makeEntry({ name: 'a', shouldFail: true });
    const b = makeEntry({ name: 'b', shouldFail: true });
    verticalState.general = [a.entry, b.entry];

    const out = await runV1Search({ query: 'something' });
    expect(out.degraded).toBe(true);
    expect(out.results).toEqual([]);
    expect(out.enginesUsed).toEqual([]);
    expect(out.outcomes).toHaveLength(2);
    expect(out.outcomes.every((o) => !o.ok)).toBe(true);
  });

  it('keeps degraded=false when at least one engine succeeds', async () => {
    const ok = makeEntry({
      name: 'ok',
      results: [makeResult('ok', 'https://ok.test/a')],
    });
    const bad = makeEntry({ name: 'bad', shouldFail: true });
    verticalState.general = [ok.entry, bad.entry];

    const out = await runV1Search({ query: 'something' });
    expect(out.degraded).toBe(false);
    expect(out.results).toHaveLength(1);
    expect(out.enginesUsed).toEqual(['ok']);
  });

  it('reports skipped engines (breaker tripped) in outcomes but not enginesUsed', async () => {
    // Use the real breaker wrapper with threshold=1 to deterministically
    // trip and then return a skipped outcome on the next dispatch.
    const { wrapWithRetryAndBreaker, _resetBreakersForTest } = await import(
      '../../../../src/search/v1/engine-base.js'
    );
    _resetBreakersForTest();

    const flakySpy = vi.fn(async () => {
      throw new Error('boom');
    });
    const flaky = wrapWithRetryAndBreaker(
      { name: 'flaky', search: flakySpy },
      { failureThreshold: 1, cooldownMs: 60_000 },
    );

    // First call trips the breaker.
    verticalState.general = [{ engine: flaky }];
    const first = await runV1Search({ query: 'general query' });
    expect(first.enginesUsed).toEqual([]);
    expect(first.outcomes[0].skipped).toBeUndefined();

    // Second call should be skipped — engine.search not invoked further.
    const callsBefore = flakySpy.mock.calls.length;
    const ok = makeEntry({
      name: 'ok',
      results: [makeResult('ok', 'https://ok.test/a')],
    });
    verticalState.general = [{ engine: flaky }, ok.entry];

    const out = await runV1Search({ query: 'general query' });
    expect(flakySpy.mock.calls.length).toBe(callsBefore); // no new calls
    expect(out.enginesUsed).toEqual(['ok']);
    const flakyOutcome = out.outcomes.find((o) => o.engine === 'flaky');
    expect(flakyOutcome?.ok).toBe(false);
    expect(flakyOutcome?.skipped).toBe(true);

    _resetBreakersForTest();
  });
});

describe('runV1Search — output shape & misc', () => {
  it('caps results at maxResults', async () => {
    const results = Array.from({ length: 25 }, (_, i) =>
      makeResult('big', `https://big.test/${i}`),
    );
    const { entry } = makeEntry({ name: 'big', results });
    verticalState.general = [entry];

    const out = await runV1Search({ query: 'q', maxResults: 5 });
    expect(out.results).toHaveLength(5);
  });

  it('returns the full output shape with correct types', async () => {
    const { entry } = makeEntry({
      name: 'bing',
      results: [makeResult('bing', 'https://example.com/a')],
    });
    verticalState.general = [entry];

    const out = await runV1Search({ query: 'general query' });
    expect(out).toMatchObject({
      vertical: 'general',
      enginesUsed: ['bing'],
      degraded: false,
    });
    expect(Array.isArray(out.results)).toBe(true);
    expect(Array.isArray(out.outcomes)).toBe(true);
    expect(out.outcomes[0]).toHaveProperty('latencyMs');
  });

  it('passes timeoutMs through to engine.search options', async () => {
    const { entry, spy } = makeEntry({
      name: 'bing',
      results: [makeResult('bing', 'https://example.com/a')],
    });
    verticalState.general = [entry];

    await runV1Search({ query: 'general query', timeoutMs: 2500 });
    expect(spy).toHaveBeenCalledOnce();
    const opts = spy.mock.calls[0][1] as SearchEngineOptions;
    expect(opts.timeoutMs).toBe(2500);
  });

  it('passes language and maxResults through to engine options', async () => {
    const { entry, spy } = makeEntry({
      name: 'bing',
      results: [],
    });
    verticalState.general = [entry];

    await runV1Search({
      query: 'general query',
      language: 'fr',
      maxResults: 7,
    });
    const opts = spy.mock.calls[0][1] as SearchEngineOptions;
    expect(opts.language).toBe('fr');
    expect(opts.maxResults).toBe(7);
  });

  it('omits category from options when vertical is general', async () => {
    const { entry, spy } = makeEntry({ name: 'bing', results: [] });
    verticalState.general = [entry];

    await runV1Search({ query: 'general query' });
    const opts = spy.mock.calls[0][1] as SearchEngineOptions;
    expect(opts.category).toBeUndefined();
  });

  it('sets category to the resolved vertical for non-general queries', async () => {
    const { entry, spy } = makeEntry({
      name: 'arxiv',
      results: [],
    });
    verticalState.papers = [entry];

    await runV1Search({ query: 'arxiv paper rust' });
    const opts = spy.mock.calls[0][1] as SearchEngineOptions;
    expect(opts.category).toBe('papers');
  });

  it('produces a stable order for tied fused scores (engine arrival order)', async () => {
    const a = makeEntry({
      name: 'a',
      results: [makeResult('a', 'https://a.test/1')],
    });
    const b = makeEntry({
      name: 'b',
      results: [makeResult('b', 'https://b.test/1')],
    });
    verticalState.general = [a.entry, b.entry];

    const out = await runV1Search({ query: 'q' });
    expect(out.results.map((r) => r.url)).toEqual([
      'https://a.test/1',
      'https://b.test/1',
    ]);
  });

  it('dedupes duplicate URLs returned within a single engine', async () => {
    const { entry } = makeEntry({
      name: 'dup',
      results: [
        makeResult('dup', 'https://same.test/1', 'first'),
        makeResult('dup', 'https://same.test/1', 'second'),
        makeResult('dup', 'https://other.test/2'),
      ],
    });
    verticalState.general = [entry];

    const out = await runV1Search({ query: 'general query' });
    const urls = out.results.map((r) => r.url);
    expect(urls).toEqual(['https://same.test/1', 'https://other.test/2']);
    // First occurrence wins.
    expect(out.results[0].title).toBe('first');
  });

  it('returns degraded=true when fusion yields zero results after filters', async () => {
    const { entry } = makeEntry({
      name: 'bing',
      results: [makeResult('bing', 'https://blocked.test/a')],
    });
    verticalState.general = [entry];

    const out = await runV1Search({
      query: 'general query',
      excludeDomains: ['blocked.test'],
    });
    expect(out.results).toEqual([]);
    expect(out.degraded).toBe(true);
    // The engine did succeed — surfaced in outcomes.
    expect(out.outcomes[0].ok).toBe(true);
  });
});
