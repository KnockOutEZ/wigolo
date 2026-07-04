import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  SearchEngine,
  SearchEngineOptions,
  RawSearchResult,
} from '../../../../src/types.js';
import type { EngineEntry } from '../../../../src/search/core/engine-base.js';

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

vi.mock('../../../../src/search/core/verticals/general.js', () => ({
  getGeneralEngines: () => verticalState.general,
  _resetGeneralEnginesForTest: () => {
    verticalState.general = [];
  },
}));
vi.mock('../../../../src/search/core/verticals/news.js', () => ({
  getNewsEngines: () => verticalState.news,
  _resetNewsEnginesForTest: () => {
    verticalState.news = [];
  },
}));
vi.mock('../../../../src/search/core/verticals/code.js', () => ({
  getCodeEngines: () => verticalState.code,
  _resetCodeEnginesForTest: () => {
    verticalState.code = [];
  },
}));
vi.mock('../../../../src/search/core/verticals/docs.js', () => ({
  getDocsEngines: () => verticalState.docs,
  _resetDocsEnginesForTest: () => {
    verticalState.docs = [];
  },
}));
vi.mock('../../../../src/search/core/verticals/papers.js', () => ({
  getPapersEngines: () => verticalState.papers,
  _resetPapersEnginesForTest: () => {
    verticalState.papers = [];
  },
}));

const { runV1Search } = await import(
  '../../../../src/search/core/orchestrator.js'
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

  // A date bound must NOT silence the
  // date-naive engines. Server-side date filtering is best-effort — engines
  // that can't filter server-side still contribute results, which are then
  // freshness-filtered client-side. Before this fix the orchestrator dropped
  // every date-naive engine the moment a single date-aware engine existed,
  // collapsing a news search to one engine / two results.
  it('still dispatches date-naive engines when a date bound is set', async () => {
    const dateAware = makeEntry({
      name: 'hn-algolia',
      supportsDateFilter: true,
      results: [makeResult('hn-algolia', 'https://news.test/hn')],
    });
    const dateNaive1 = makeEntry({
      name: 'duckduckgo',
      supportsDateFilter: false,
      results: [makeResult('duckduckgo', 'https://news.test/ddg')],
    });
    const dateNaive2 = makeEntry({
      name: 'mojeek',
      supportsDateFilter: false,
      results: [makeResult('mojeek', 'https://news.test/mojeek')],
    });
    verticalState.news = [dateAware.entry, dateNaive1.entry, dateNaive2.entry];

    const out = await runV1Search({
      query: 'wwdc 2026 announcements',
      category: 'news',
      timeRange: 'week',
    });

    // The non-date-aware engines must run — not just the date-aware one.
    expect(dateNaive1.spy).toHaveBeenCalledOnce();
    expect(dateNaive2.spy).toHaveBeenCalledOnce();
    expect(dateAware.spy).toHaveBeenCalledOnce();
    expect(out.enginesUsed.sort()).toEqual(['duckduckgo', 'hn-algolia', 'mojeek']);
  });

  it('still runs every engine when no engine supports server-side date filtering', async () => {
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

  // Client-side freshness filter (the second half of the recall fix): once
  // date-naive engines are allowed to run under a date bound, their results
  // are filtered against the resolved window. Older-than-window results drop;
  // within-window AND undated results survive (don't nuke recall on results
  // that simply lack a parseable published_date).
  it('drops only the older-than-window result; keeps within-window and undated', async () => {
    const now = Date.now();
    const DAY = 86_400_000;
    const inWindow = new Date(now - 2 * DAY).toISOString().slice(0, 10);
    const older = new Date(now - 120 * DAY).toISOString().slice(0, 10);

    const fresh = makeResult('duckduckgo', 'https://news.test/fresh');
    fresh.published_date = inWindow;
    const stale = makeResult('duckduckgo', 'https://news.test/stale');
    stale.published_date = older;
    const undated = makeResult('duckduckgo', 'https://news.test/undated');

    const ddg = makeEntry({
      name: 'duckduckgo',
      supportsDateFilter: false,
      results: [fresh, stale, undated],
    });
    verticalState.news = [ddg.entry];

    const out = await runV1Search({
      query: 'wwdc 2026 announcements',
      category: 'news',
      timeRange: 'week',
      maxResults: 10,
    });

    const urls = out.results.map((r) => r.url);
    expect(urls).toContain('https://news.test/fresh');
    expect(urls).toContain('https://news.test/undated');
    expect(urls).not.toContain('https://news.test/stale');
  });
});

describe('runV1Search — hard freshness window (dated out-of-window)', () => {
  const DAY = 86_400_000;

  // The leak this slice closes: a DATED result whose published_date is not
  // lexically ISO-ordered ("Jan 15, 2026", "2026/01/15") compared TRUE against
  // the "YYYY-MM-DD" week window in the old string filter and survived despite
  // being months old. The robust parse must drop it.
  it('drops a months-old result whose published_date is a NON-ISO format', async () => {
    const dayAgo = new Date(Date.now() - 2 * DAY).toISOString().slice(0, 10);

    const fresh = makeResult('duckduckgo', 'https://news.test/fresh');
    fresh.published_date = dayAgo;
    const oldHuman = makeResult('duckduckgo', 'https://news.test/old-human');
    oldHuman.published_date = 'Jan 15, 2026'; // ~5-6 months before "now"
    const oldSlash = makeResult('duckduckgo', 'https://news.test/old-slash');
    oldSlash.published_date = '2026/01/15';

    const ddg = makeEntry({
      name: 'duckduckgo',
      supportsDateFilter: false,
      results: [fresh, oldHuman, oldSlash],
    });
    verticalState.news = [ddg.entry];

    const out = await runV1Search({
      query: 'ai model launch',
      category: 'news',
      timeRange: 'week',
      maxResults: 10,
    });

    const urls = out.results.map((r) => r.url);
    expect(urls).toContain('https://news.test/fresh');
    expect(urls).not.toContain('https://news.test/old-human');
    expect(urls).not.toContain('https://news.test/old-slash');
  });

  // Non-empty guarantee: when EVERY result is dated and out of window, the
  // window must not empty the set — the pre-filter results are kept so scarce
  // (or entirely-old) coverage still returns something.
  it('never empties the set — keeps out-of-window dated results when nothing is in-window', async () => {
    const old1 = makeResult('duckduckgo', 'https://news.test/old-1');
    old1.published_date = '2020-01-01T00:00:00.000Z';
    const old2 = makeResult('duckduckgo', 'https://news.test/old-2');
    old2.published_date = '2021-06-15T00:00:00.000Z';

    const ddg = makeEntry({
      name: 'duckduckgo',
      supportsDateFilter: false,
      results: [old1, old2],
    });
    verticalState.news = [ddg.entry];

    const out = await runV1Search({
      query: 'ai model launch',
      category: 'news',
      timeRange: 'week',
      maxResults: 10,
    });

    expect(out.results.length).toBeGreaterThan(0);
  });

  // NEGATIVE gate: with NO explicit time_range / from_date / to_date, an old
  // DATED result must be completely unaffected — the window gate must not fire.
  it('does NOT window out old dated results when no time_range/from_date is set', async () => {
    const old = makeResult('duckduckgo', 'https://gen.test/old');
    old.published_date = '2020-01-01T00:00:00.000Z';
    const oldHuman = makeResult('duckduckgo', 'https://gen.test/old-human');
    oldHuman.published_date = 'Jan 15, 2020';

    const ddg = makeEntry({
      name: 'duckduckgo',
      supportsDateFilter: false,
      results: [old, oldHuman],
    });
    verticalState.general = [ddg.entry];

    // A plain query with no date bound and no temporal keyword.
    const out = await runV1Search({ query: 'react hooks reference', maxResults: 10 });

    const urls = out.results.map((r) => r.url);
    expect(urls).toContain('https://gen.test/old');
    expect(urls).toContain('https://gen.test/old-human');
  });

  // NEGATIVE gate: a result with an UNPARSEABLE published_date must NOT be
  // treated as out of window — it survives (undated-equivalent), even under an
  // explicit window.
  it('keeps a result with an unparseable published_date under an explicit window', async () => {
    const dayAgo = new Date(Date.now() - 2 * DAY).toISOString().slice(0, 10);
    const fresh = makeResult('duckduckgo', 'https://news.test/fresh');
    fresh.published_date = dayAgo;
    const bogus = makeResult('duckduckgo', 'https://news.test/bogus-date');
    bogus.published_date = 'sometime last spring';

    const ddg = makeEntry({
      name: 'duckduckgo',
      supportsDateFilter: false,
      results: [fresh, bogus],
    });
    verticalState.news = [ddg.entry];

    const out = await runV1Search({
      query: 'ai model launch',
      category: 'news',
      timeRange: 'week',
      maxResults: 10,
    });

    const urls = out.results.map((r) => r.url);
    expect(urls).toContain('https://news.test/fresh');
    expect(urls).toContain('https://news.test/bogus-date');
  });

  // from_date/to_date explicit window (not just time_range): a same-day
  // full-ISO timestamp on the toDate boundary is IN window, an after-window
  // dated result is dropped.
  it('honours from_date/to_date boundaries on full-ISO timestamps', async () => {
    const onToDate = makeResult('duckduckgo', 'https://news.test/on-to-date');
    onToDate.published_date = '2026-07-01T15:44:13.000Z';
    const afterWindow = makeResult('duckduckgo', 'https://news.test/after');
    afterWindow.published_date = '2026-07-05T00:00:00.000Z';
    const beforeWindow = makeResult('duckduckgo', 'https://news.test/before');
    beforeWindow.published_date = '2026-06-20T00:00:00.000Z';

    const ddg = makeEntry({
      name: 'duckduckgo',
      supportsDateFilter: false,
      results: [onToDate, afterWindow, beforeWindow],
    });
    verticalState.news = [ddg.entry];

    const out = await runV1Search({
      query: 'ai model launch',
      category: 'news',
      fromDate: '2026-06-27',
      toDate: '2026-07-01',
      maxResults: 10,
    });

    const urls = out.results.map((r) => r.url);
    expect(urls).toContain('https://news.test/on-to-date');
    expect(urls).not.toContain('https://news.test/after');
    expect(urls).not.toContain('https://news.test/before');
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

describe('runV1Search — brand-collision guard', () => {
  it('demotes retail TLDs (.co.uk, .shop) for short queries', async () => {
    // Query "next" used to surface next.co.uk fashion above nextjs-related
    // pages because Bing literal-matched the brand. The guard penalizes
    // retail TLDs when the query has ≤2 tokens so authoritative pages win.
    const { entry } = makeEntry({
      name: 'bing',
      results: [
        makeResult('bing', 'https://next.co.uk/fashion'),
        makeResult('bing', 'https://example.dev/post-about-next'),
      ],
    });
    verticalState.general = [entry];

    const out = await runV1Search({ query: 'next' });
    expect(out.results[0].url).toBe('https://example.dev/post-about-next');
    expect(out.results[1].url).toBe('https://next.co.uk/fashion');
  });

  it('does not apply the guard for longer queries with disambiguating context', async () => {
    // Three tokens — the query is specific enough that retail collisions
    // are unlikely. Don't penalize.
    const { entry } = makeEntry({
      name: 'bing',
      results: [
        makeResult('bing', 'https://shop.example.shop/abc'),
        makeResult('bing', 'https://other.example/page'),
      ],
    });
    verticalState.general = [entry];

    const out = await runV1Search({
      query: 'shop example abc detailed product listing review',
    });
    expect(out.results[0].url).toBe('https://shop.example.shop/abc');
  });

  it('leaves results untouched when no retail TLDs are present', async () => {
    // Use .example hostnames so neither matches AUTHORITATIVE_TLD in
    // authority-boost (which would re-order .org above .com on a 1-token query).
    const { entry } = makeEntry({
      name: 'bing',
      results: [
        makeResult('bing', 'https://alpha.example/a'),
        makeResult('bing', 'https://beta.example/b'),
      ],
    });
    verticalState.general = [entry];

    const out = await runV1Search({ query: 'foo' });
    expect(out.results.map((r) => r.url)).toEqual([
      'https://alpha.example/a',
      'https://beta.example/b',
    ]);
  });
});

describe('runV1Search — domain filters', () => {
  it('hard-filters off-domain results even when matches are sparse', async () => {
    // includeDomains is a HARD whitelist. Earlier the
    // orchestrator used a soft floor that backfilled non-matching domains
    // when fewer than 3 matched. This leaked off-domain
    // results, sometimes ranked above on-domain. Now: drop every off-domain
    // result, even if only one in-domain hit survives.
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
    expect(hosts.sort()).toEqual(['allowed.com', 'sub.allowed.com']);
    expect(hosts).not.toContain('denied.com');
  });

  it('keeps in-domain results when matches exceed any size', async () => {
    const { entry } = makeEntry({
      name: 'bing',
      results: [
        makeResult('bing', 'https://allowed.com/a'),
        makeResult('bing', 'https://allowed.com/b'),
        makeResult('bing', 'https://allowed.com/c'),
        makeResult('bing', 'https://denied.com/a'),
      ],
    });
    verticalState.general = [entry];

    const out = await runV1Search({
      query: 'general query',
      includeDomains: ['allowed.com'],
    });
    const hosts = out.results.map((r) => new URL(r.url).hostname);
    expect(hosts.every((h) => h === 'allowed.com')).toBe(true);
  });

  it('returns empty results when zero in-domain matches (no silent backfill) (C8)', async () => {
    // Was: soft-floor backfilled non-matching results so callers got a
    // non-empty response. Now: empty array is the correct answer; the caller
    // sets the filter, the caller owns the empty case.
    const { entry } = makeEntry({
      name: 'bing',
      results: [
        makeResult('bing', 'https://other.example/a'),
        makeResult('bing', 'https://elsewhere.example/b'),
      ],
    });
    verticalState.general = [entry];

    const out = await runV1Search({
      query: 'general query',
      includeDomains: ['noresults.example'],
    });
    expect(out.results).toEqual([]);
  });

  it('still hard-strips URLs matching excludeDomains alongside includeDomains', async () => {
    const { entry } = makeEntry({
      name: 'bing',
      results: [
        makeResult('bing', 'https://allowed.com/a'),
        makeResult('bing', 'https://block.com/a'),
      ],
    });
    verticalState.general = [entry];

    const out = await runV1Search({
      query: 'general query',
      includeDomains: ['allowed.com'],
      excludeDomains: ['block.com'],
    });
    const hosts = out.results.map((r) => new URL(r.url).hostname);
    expect(hosts).toContain('allowed.com');
    expect(hosts).not.toContain('block.com');
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
      '../../../../src/search/core/engine-base.js'
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

describe('runV1Search — degraded fallback to general', () => {
  it('retries as general when the routed code vertical degrades', async () => {
    // Code engines all fail. General has a working engine — orchestrator
    // should fall back so the caller gets results instead of an empty list.
    const codeBad = makeEntry({ name: 'github-code', shouldFail: true });
    verticalState.code = [codeBad.entry];

    const generalOk = makeEntry({
      name: 'bing',
      results: [makeResult('bing', 'https://example.com/hnsw')],
    });
    verticalState.general = [generalOk.entry];

    const out = await runV1Search({ query: 'fix typescript HNSW tuning' });
    expect(out.degraded).toBe(false);
    expect(out.vertical).toBe('general');
    expect(out.results.map((r) => r.url)).toEqual(['https://example.com/hnsw']);
  });

  it('does not fall back when the original vertical succeeds', async () => {
    // Return enough results (≥ the starvation floor) that neither the
    // query-wide degraded fallback nor the partial-starvation backfill fires —
    // a healthy, well-populated vertical must not touch the general pool.
    const codeOk = makeEntry({
      name: 'github-code',
      results: [
        makeResult('github-code', 'https://gh.test/code1'),
        makeResult('github-code', 'https://gh.test/code2'),
        makeResult('github-code', 'https://gh.test/code3'),
        makeResult('github-code', 'https://gh.test/code4'),
      ],
    });
    verticalState.code = [codeOk.entry];

    const generalSpy = makeEntry({ name: 'bing', results: [] });
    verticalState.general = [generalSpy.entry];

    const out = await runV1Search({ query: 'fix typescript error' });
    expect(out.vertical).toBe('code');
    expect(generalSpy.spy).not.toHaveBeenCalled();
  });

  it('does not fall back from general (no infinite recursion)', async () => {
    const bad = makeEntry({ name: 'bing', shouldFail: true });
    verticalState.general = [bad.entry];

    const out = await runV1Search({ query: 'arbitrary phrase' });
    expect(out.vertical).toBe('general');
    expect(out.degraded).toBe(true);
  });

  it('reports the fallback vertical (general) in the returned output', async () => {
    const codeBad = makeEntry({ name: 'github-code', shouldFail: true });
    verticalState.code = [codeBad.entry];
    const generalOk = makeEntry({
      name: 'bing',
      results: [makeResult('bing', 'https://example.com/hit')],
    });
    verticalState.general = [generalOk.entry];

    const out = await runV1Search({ query: 'fix python regex' });
    expect(out.vertical).toBe('general');
  });
});

describe('runV1Search — per-result starvation re-dispatch', () => {
  // A non-general vertical that returns fewer than the starvation floor must
  // pull in the general pool and RRF-merge, rather than shipping a near-empty
  // set. This is distinct from the query-wide degraded fallback (which only
  // fires when the vertical returns ZERO). WHY: a vertical with a thin engine
  // pool (e.g. papers = arxiv only) starves on any query it doesn't index; the
  // caller still deserves web recall. pool_degraded surfaces that it happened.
  it('re-dispatches to general and merges when a vertical returns below the floor', async () => {
    const papersThin = makeEntry({
      name: 'arxiv',
      results: [makeResult('arxiv', 'https://arxiv.org/abs/only')],
    });
    verticalState.papers = [papersThin.entry];

    const generalRich = makeEntry({
      name: 'bing',
      results: [
        makeResult('bing', 'https://example.com/g1'),
        makeResult('bing', 'https://example.com/g2'),
        makeResult('bing', 'https://example.com/g3'),
        makeResult('bing', 'https://example.com/g4'),
      ],
    });
    verticalState.general = [generalRich.entry];

    const out = await runV1Search({
      query: 'arxiv quantum error correction surface code',
      maxResults: 10,
    });

    expect(out.vertical).toBe('papers');
    // The general pool must have been dispatched to backfill the thin vertical.
    expect(generalRich.spy).toHaveBeenCalled();
    const urls = out.results.map((r) => r.url);
    expect(urls).toContain('https://arxiv.org/abs/only');
    // At least one general-only URL merged in.
    expect(urls.some((u) => u.startsWith('https://example.com/g'))).toBe(true);
    expect(out.pool_degraded).toBeDefined();
    expect(out.pool_degraded?.reasons).toContain('starvation_redispatch');
  });

  it('does NOT re-dispatch to general when the vertical is already well-populated', async () => {
    const codeRich = makeEntry({
      name: 'github-code',
      results: Array.from({ length: 12 }, (_, i) =>
        makeResult('github-code', `https://gh.test/${i}`),
      ),
    });
    verticalState.code = [codeRich.entry];

    const generalSpy = makeEntry({ name: 'bing', results: [makeResult('bing', 'https://example.com/g')] });
    verticalState.general = [generalSpy.entry];

    const out = await runV1Search({ query: 'fix typescript error', maxResults: 5 });
    expect(out.vertical).toBe('code');
    expect(generalSpy.spy).not.toHaveBeenCalled();
    expect(out.pool_degraded).toBeUndefined();
  });

  it('does NOT re-dispatch for the general vertical (nowhere to fall back to)', async () => {
    const thin = makeEntry({
      name: 'bing',
      results: [makeResult('bing', 'https://example.com/one')],
    });
    verticalState.general = [thin.entry];

    const out = await runV1Search({ query: 'some sparse query', maxResults: 10 });
    expect(out.vertical).toBe('general');
    // Called exactly once (the initial dispatch), not a second starvation wave.
    expect(thin.spy).toHaveBeenCalledOnce();
    expect(out.pool_degraded).toBeUndefined();
  });

  it('does not double-count a URL a shared engine returns in both waves', async () => {
    // code + general share an engine name (duckduckgo). A thin code vertical
    // triggers the starvation re-dispatch to general, where the SAME engine
    // returns the SAME URL again. WHY: without per-(engine,url) dedupe across
    // waves the shared URL's RRF contribution + engine_consensus would be
    // summed twice, inflating its rank on a wasted duplicate. Consensus for a
    // URL only that one engine returned must stay 1.
    const sharedUrl = 'https://shared.test/doc';
    const codeDdg = makeEntry({
      name: 'duckduckgo',
      results: [makeResult('duckduckgo', sharedUrl)],
    });
    verticalState.code = [codeDdg.entry];

    const generalDdg = makeEntry({
      name: 'duckduckgo',
      results: [
        makeResult('duckduckgo', sharedUrl),
        makeResult('duckduckgo', 'https://general.test/other'),
      ],
    });
    verticalState.general = [generalDdg.entry];

    const out = await runV1Search({ query: 'fix typescript error', maxResults: 10 });
    // Starvation fired (thin code vertical).
    expect(generalDdg.spy).toHaveBeenCalled();
    const shared = out.results.find((r) => r.url === sharedUrl);
    expect(shared).toBeDefined();
    // Only duckduckgo returned this URL, across two waves — counted once.
    expect(shared!.evidence_score?.components.engine_consensus).toBe(1);
    // The URL appears exactly once (dedup intact).
    expect(out.results.filter((r) => r.url === sharedUrl)).toHaveLength(1);
  });
});

describe('runV1Search — news undated demotion', () => {
  // When a caller sets an explicit recency window on a news query, an undated
  // page must lose slots to a dated in-window page — but must NOT be dropped
  // (recall must not collapse to only dated results). WHY: an undated homepage
  // is weaker evidence than a dated release note for a "latest X" query, yet
  // dropping undated entirely nukes recall.
  //
  // The setup ISOLATES the ×0.3 undated demotion from the pre-existing recency
  // BOOST: the undated result comes from a heavier engine (weight 2) at rank 1,
  // the dated result from a lighter engine (weight 1) and is deliberately near
  // the window edge (~29 days old, TAU_DAYS=30 → recency boost ~1.37). Weight-2
  // undated (base 2/61) beats weight-1 dated even after that boost
  // (1/61 × 1.37), so recency ALONE keeps undated first. ONLY the ×0.3 demotion
  // can flip the order. Neutralising undatedMul→1.0 therefore breaks this test.
  // Neutral hosts + identical titles/snippets keep domain-quality + lexical
  // alignment equal across the two results so the demotion is the sole variable.
  it('demotes an undated news result below a dated in-window result', async () => {
    const now = Date.now();
    const DAY = 86_400_000;
    // 29 days old: in-window (time_range=month ≈ 30d) but far enough that the
    // recency boost is near its in-window floor (~1.37), not the ~1.9 of a
    // 2-day-old page.
    const nearEdge = new Date(now - 29 * DAY).toISOString().slice(0, 10);

    const undated = makeResult('undated-eng', 'https://example.com/undated-home', 'Kernel release notes');
    const dated = makeResult('dated-eng', 'https://example.org/dated-release', 'Kernel release notes');
    dated.published_date = nearEdge;

    const undatedEngine = makeEntry({
      name: 'undated-eng',
      weight: 2,
      results: [undated],
    });
    const datedEngine = makeEntry({
      name: 'dated-eng',
      weight: 1,
      results: [dated],
    });
    verticalState.news = [undatedEngine.entry, datedEngine.entry];

    const out = await runV1Search({
      query: 'latest kernel LTS release',
      category: 'news',
      timeRange: 'month',
      maxResults: 10,
    });

    const byUrl = new Map(out.results.map((r) => [r.url, r]));
    // Both survive (recall preserved — undated is demoted, not dropped).
    expect(byUrl.has('https://example.org/dated-release')).toBe(true);
    expect(byUrl.has('https://example.com/undated-home')).toBe(true);
    const urls = out.results.map((r) => r.url);
    const datedIdx = urls.indexOf('https://example.org/dated-release');
    const undatedIdx = urls.indexOf('https://example.com/undated-home');
    // Dated ranks first — a flip that only the ×0.3 undated demotion can cause,
    // since the weight-2 undated result out-bases the boosted weight-1 dated one.
    expect(datedIdx).toBeLessThan(undatedIdx);
    // Numeric isolation: undated is suppressed well below the dated result.
    // Without the demotion the weight-2 undated result would score ABOVE the
    // dated one (ratio ~1.4); the ×0.3 drives the ratio under 0.6.
    const ratio =
      byUrl.get('https://example.com/undated-home')!.relevance_score /
      byUrl.get('https://example.org/dated-release')!.relevance_score;
    expect(ratio).toBeLessThan(0.6);
  });
});

describe('runV1Search — authority boost', () => {
  it('promotes a known authoritative domain above a higher-ranked brand collision', async () => {
    // Bing top-ranks a random retail domain ahead of the authoritative redis.io docs page.
    // Authority boost should flip the order for a query whose subject token maps to a
    // KNOWN_SUBJECT_DOMAIN entry.
    const { entry } = makeEntry({
      name: 'bing',
      results: [
        makeResult('bing', 'https://random-retailer.com/redis-tshirt'),
        makeResult('bing', 'https://redis.io/docs/cache'),
      ],
    });
    verticalState.general = [entry];

    const out = await runV1Search({ query: 'redis cache' });
    expect(out.results[0].url).toBe('https://redis.io/docs/cache');
    expect(out.results[1].url).toBe('https://random-retailer.com/redis-tshirt');
  });

  it('promotes a known docs host (kubernetes.io) for a kubernetes query', async () => {
    const { entry } = makeEntry({
      name: 'bing',
      results: [
        makeResult('bing', 'https://blog.unrelated.example/k8s-rant'),
        makeResult('bing', 'https://kubernetes.io/docs/concepts/'),
      ],
    });
    verticalState.general = [entry];

    const out = await runV1Search({ query: 'kubernetes pod lifecycle' });
    expect(out.results[0].url).toBe('https://kubernetes.io/docs/concepts/');
  });

  it('does not reorder results for queries with no recognized subject', async () => {
    // Query has no subject in KNOWN_SUBJECT_DOMAIN and no docs.* / authoritative TLD hit.
    const { entry } = makeEntry({
      name: 'bing',
      results: [
        makeResult('bing', 'https://example-a.example/post'),
        makeResult('bing', 'https://example-b.example/post'),
      ],
    });
    verticalState.general = [entry];

    const out = await runV1Search({ query: 'blue elephant garden party' });
    expect(out.results.map((r) => r.url)).toEqual([
      'https://example-a.example/post',
      'https://example-b.example/post',
    ]);
  });

  it('still applies domain filters after authority boost', async () => {
    const { entry } = makeEntry({
      name: 'bing',
      results: [
        makeResult('bing', 'https://redis.io/docs/cache'),
        makeResult('bing', 'https://otherdomain.example/redis'),
      ],
    });
    verticalState.general = [entry];

    const out = await runV1Search({
      query: 'redis cache',
      excludeDomains: ['redis.io'],
    });
    const urls = out.results.map((r) => r.url);
    expect(urls).not.toContain('https://redis.io/docs/cache');
    expect(urls).toContain('https://otherdomain.example/redis');
  });
});

describe('runV1Search — recency boost', () => {
  function withDate(
    engineName: string,
    url: string,
    publishedDate: string | undefined,
  ): RawSearchResult {
    return {
      title: url,
      url,
      snippet: `snippet for ${url}`,
      relevance_score: 1,
      engine: engineName,
      published_date: publishedDate,
    };
  }

  const today = new Date().toISOString();
  const twoYearsAgo = new Date(
    Date.now() - 730 * 86_400_000,
  ).toISOString();

  it('promotes a recent result above an older one for "latest news AI"', async () => {
    // Single engine returns the older URL first (rank 1) and the recent URL second.
    // Without recency boost the older URL would win on RRF rank. With boost the
    // recent URL multiplier (~2.0) beats the older URL's ~1.0 despite worse rank.
    const { entry } = makeEntry({
      name: 'hn',
      results: [
        withDate('hn', 'https://old.test/a', twoYearsAgo),
        withDate('hn', 'https://new.test/b', today),
      ],
    });
    verticalState.news = [entry];

    const out = await runV1Search({ query: 'latest news AI' });
    expect(out.vertical).toBe('news');
    // recent: 2.0 / 62 ≈ 0.0323; old: 1.0 / 61 ≈ 0.0164
    expect(out.results[0].url).toBe('https://new.test/b');
    expect(out.results[1].url).toBe('https://old.test/a');
  });

  it('does not apply recency boost for a query without temporal intent', async () => {
    // Without temporal intent ordering follows engine rank regardless of published_date.
    // Use neutral hosts so authority boost doesn't enter the picture — the query
    // "best pizza in new york" contains 'new' which would otherwise match a
    // host like 'new.test' via authority-boost's startsWith fallback.
    const { entry } = makeEntry({
      name: 'bing',
      results: [
        withDate('bing', 'https://example.com/old-page', twoYearsAgo),
        withDate('bing', 'https://example.com/recent-page', today),
      ],
    });
    verticalState.general = [entry];

    const out = await runV1Search({ query: 'best pizza in new york' });
    expect(out.vertical).toBe('general');
    expect(out.results[0].url).toBe('https://example.com/old-page');
    expect(out.results[1].url).toBe('https://example.com/recent-page');
  });

  it('applies recency boost when vertical is news even without keywords', async () => {
    // Force news via category hint; recency boost should still flip ordering.
    const { entry } = makeEntry({
      name: 'hn',
      results: [
        withDate('hn', 'https://old.test/a', twoYearsAgo),
        withDate('hn', 'https://new.test/b', today),
      ],
    });
    verticalState.news = [entry];

    const out = await runV1Search({
      query: 'quantum computing',
      category: 'news',
    });
    expect(out.results[0].url).toBe('https://new.test/b');
  });

  it('parses natural-language date hint and forwards it to engine options', async () => {
    const { entry, spy } = makeEntry({
      name: 'hn',
      supportsDateFilter: true,
      results: [makeResult('hn', 'https://news.test/a')],
    });
    verticalState.news = [entry];

    await runV1Search({ query: 'AI news between 2023 and 2024' });
    const opts = spy.mock.calls[0][1] as SearchEngineOptions;
    expect(opts.fromDate).toBe('2023-01-01');
    expect(opts.toDate).toBe('2024-12-31');
  });

  it('caller-supplied fromDate overrides inferred date hint', async () => {
    const { entry, spy } = makeEntry({
      name: 'hn',
      supportsDateFilter: true,
      results: [makeResult('hn', 'https://news.test/a')],
    });
    verticalState.news = [entry];

    await runV1Search({
      query: 'AI news between 2023 and 2024',
      fromDate: '2025-06-01',
    });
    const opts = spy.mock.calls[0][1] as SearchEngineOptions;
    expect(opts.fromDate).toBe('2025-06-01');
    // toDate falls through to the inferred hint since caller didn't override it.
    expect(opts.toDate).toBe('2024-12-31');
  });

  it('does not apply recency boost when published_date is missing on all results', async () => {
    // Both URLs have no published_date → multiplier is 1.0 → ordering by rank.
    const { entry } = makeEntry({
      name: 'hn',
      results: [
        withDate('hn', 'https://a.test/1', undefined),
        withDate('hn', 'https://b.test/2', undefined),
      ],
    });
    verticalState.news = [entry];

    const out = await runV1Search({ query: 'latest news AI' });
    expect(out.results.map((r) => r.url)).toEqual([
      'https://a.test/1',
      'https://b.test/2',
    ]);
  });
});
