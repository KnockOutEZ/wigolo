import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  SearchEngine,
  SearchEngineOptions,
  RawSearchResult,
} from '../../../../src/types.js';
import type { EngineEntry } from '../../../../src/search/core/engine-base.js';

const verticalState: {
  general: EngineEntry[];
  news: EngineEntry[];
  code: EngineEntry[];
  docs: EngineEntry[];
  papers: EngineEntry[];
} = { general: [], news: [], code: [], docs: [], papers: [] };

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

const { runV1Search } = await import('../../../../src/search/core/orchestrator.js');

function makeResult(
  engineName: string,
  url: string,
  title: string,
  snippet: string,
): RawSearchResult {
  return { title, url, snippet, relevance_score: 1, engine: engineName };
}

type EngineQualityTier = 'high' | 'medium' | 'low';

function makeEntry(
  name: string,
  results: RawSearchResult[],
  extra: { weight?: number; quality?: EngineQualityTier } = {},
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

beforeEach(() => {
  verticalState.general = [];
  verticalState.news = [];
  verticalState.code = [];
  verticalState.docs = [];
  verticalState.papers = [];
});

describe('runV1Search — brand-collision rank (sub-ticket 2.1)', () => {
  it('demotes a brand-domain hit below the canonical docs hit', async () => {
    // Single engine, brand-domain at rank 1 (higher RRF base), canonical at rank 2.
    const engine = makeEntry('bing', [
      makeResult(
        'bing',
        'https://www.next.co.uk/women',
        "Women's Clothing | Next Official Site",
        "Shop women's clothing, dresses, tops and shoes at Next.",
      ),
      makeResult(
        'bing',
        'https://nextjs.org/docs/app/api-reference/functions/server-actions',
        'Next.js 15 — Server Actions | App Router',
        'Server Actions caching rules, revalidation, and form behaviour in the App Router.',
      ),
    ]);
    verticalState.general = [engine];

    const out = await runV1Search({
      query: 'next.js 15 app router server actions caching rules',
    });

    expect(out.results.length).toBeGreaterThanOrEqual(2);
    const canonicalIdx = out.results.findIndex((r) => r.url.startsWith('https://nextjs.org/'));
    const brandIdx = out.results.findIndex((r) => r.url.startsWith('https://www.next.co.uk/'));
    expect(canonicalIdx).toBeGreaterThanOrEqual(0);
    expect(brandIdx).toBeGreaterThanOrEqual(0);
    expect(canonicalIdx).toBeLessThan(brandIdx);
  });

  it('keeps canonical docs at relevance_score 1.0 after normalisation', async () => {
    const engine = makeEntry('bing', [
      makeResult(
        'bing',
        'https://nextjs.org/docs/app',
        'Next.js 15 App Router',
        'Server actions caching guide.',
      ),
      makeResult(
        'bing',
        'https://www.next.co.uk/',
        'Next Clothing',
        'Fashion store homepage.',
      ),
    ]);
    verticalState.general = [engine];

    const out = await runV1Search({
      query: 'next.js 15 server actions caching',
    });
    const canonical = out.results.find((r) => r.url.startsWith('https://nextjs.org/'));
    expect(canonical).toBeDefined();
    expect(canonical!.relevance_score).toBeCloseTo(1, 5);
  });

  it('drops MDN HTML-element drift below pgvector-relevant sources on code queries', async () => {
    const engine = makeEntry('bing', [
      makeResult(
        'bing',
        'https://developer.mozilla.org/en-US/docs/Web/HTML/Element/search',
        'HTML <search> element',
        'The <search> element semantically represents a search section.',
      ),
      makeResult(
        'bing',
        'https://jkatz.github.io/post/postgres/pgvector-hnsw-performance/',
        'pgvector HNSW performance tuning',
        'Tuning ef_search for pgvector HNSW indexes.',
      ),
    ]);
    verticalState.code = [engine];

    const out = await runV1Search({
      query: 'pgvector HNSW ef_search tuning',
      category: 'code',
    });

    const mdnIdx = out.results.findIndex((r) => r.url.includes('developer.mozilla.org'));
    const pgvectorIdx = out.results.findIndex((r) => r.url.includes('jkatz.github.io'));
    expect(pgvectorIdx).toBeGreaterThanOrEqual(0);
    expect(mdnIdx === -1 || pgvectorIdx < mdnIdx).toBe(true);
  });

  // Tier-based RRF weighting. Previously every engine contributed equal RRF
  // weight. With tier metadata, a high-tier engine's top hit should outrank a
  // low-tier engine's top hit even when they're at the same rank position.
  it('tier-based RRF: high-tier rank-1 outranks low-tier rank-1 on disjoint URLs', async () => {
    // Both engines emit exactly one result at rank 1 with disjoint URLs.
    // With tier weights high=1.0, low=0.5:
    //   high: 1.0 / (60+1) ≈ 0.01639
    //   low:  0.5 / (60+1) ≈ 0.00820
    // So the high-tier URL must come first regardless of arrival order.
    const lowEngine = makeEntry(
      'low-quality',
      [makeResult('low-quality', 'https://low.test/top', 'low result', 'unrelated body')],
      { quality: 'low' },
    );
    const highEngine = makeEntry(
      'high-quality',
      [makeResult('high-quality', 'https://high.test/top', 'high result', 'unrelated body')],
      { quality: 'high' },
    );
    // Arrival order: low first, then high. Without tier weighting the low-tier
    // URL would tie or win on engine-arrival order.
    verticalState.general = [lowEngine, highEngine];

    const out = await runV1Search({ query: 'opaque query without lexical signal' });
    expect(out.results.length).toBeGreaterThanOrEqual(2);
    const highIdx = out.results.findIndex((r) => r.url === 'https://high.test/top');
    const lowIdx = out.results.findIndex((r) => r.url === 'https://low.test/top');
    expect(highIdx).toBeGreaterThanOrEqual(0);
    expect(lowIdx).toBeGreaterThanOrEqual(0);
    expect(highIdx).toBeLessThan(lowIdx);
  });

  it('tier-based RRF: same URL from two tiers does NOT alter dedup, only ranking', async () => {
    // When both engines emit the same URL, the URL should appear exactly once
    // (dedup unaffected) and the merged score should reflect both engines'
    // tier-weighted contributions.
    const sharedUrl = 'https://shared.test/x';
    const highEngine = makeEntry(
      'a',
      [makeResult('a', sharedUrl, 'shared title', 'shared snippet')],
      { quality: 'high' },
    );
    const lowEngine = makeEntry(
      'b',
      [makeResult('b', sharedUrl, 'shared title', 'shared snippet')],
      { quality: 'low' },
    );
    verticalState.general = [highEngine, lowEngine];

    const out = await runV1Search({ query: 'shared exact phrase' });
    const occurrences = out.results.filter((r) => r.url === sharedUrl);
    expect(occurrences.length).toBe(1);
  });

  it('tier-based RRF: explicit weight overrides numeric weight when quality is present', async () => {
    // Legacy entries use `weight`. New entries from S11b will use `quality`.
    // When BOTH are present, `quality` wins (forward-compat with S11b).
    const heavyButLowTier = makeEntry(
      'a',
      [makeResult('a', 'https://a.test/top', 'a title', 'unrelated snippet body')],
      { weight: 5.0, quality: 'low' },
    );
    const lightButHighTier = makeEntry(
      'b',
      [makeResult('b', 'https://b.test/top', 'b title', 'unrelated snippet body')],
      { weight: 0.1, quality: 'high' },
    );
    verticalState.general = [heavyButLowTier, lightButHighTier];

    const out = await runV1Search({ query: 'totally generic query no signal' });
    // The high-tier engine wins despite the lower numeric weight because the
    // tier metadata takes precedence over `weight`.
    expect(out.results[0].url).toBe('https://b.test/top');
  });

  // S11c sub-area 2 — cross-engine canonical URL dedup. The merge step must
  // canonicalize URLs BEFORE RRF fusion, so two engines emitting different
  // variants of the same page (utm, AMP, mobile, trailing slash, protocol)
  // contribute to a single RRF row rather than splitting the signal.
  describe('canonical URL dedup at merge time', () => {
    it('merges utm-tagged and untagged variants into one result', async () => {
      const engineA = makeEntry('a', [
        makeResult('a', 'https://foo.com/x?utm_source=newsletter', 'page x', 'body of x'),
      ]);
      const engineB = makeEntry('b', [
        makeResult('b', 'https://foo.com/x', 'page x', 'body of x'),
      ]);
      verticalState.general = [engineA, engineB];

      const out = await runV1Search({ query: 'foo bar baz some content' });
      const matches = out.results.filter((r) => r.url.includes('foo.com/x'));
      expect(matches.length).toBe(1);
    });

    it('merges AMP and non-AMP variants', async () => {
      const engineA = makeEntry('a', [
        makeResult('a', 'https://foo.com/amp/x', 'page x', 'body'),
      ]);
      const engineB = makeEntry('b', [
        makeResult('b', 'https://foo.com/x', 'page x', 'body'),
      ]);
      verticalState.general = [engineA, engineB];

      const out = await runV1Search({ query: 'foo bar baz some content' });
      const matches = out.results.filter((r) => /foo\.com\/(amp\/)?x$/.test(r.url));
      expect(matches.length).toBe(1);
    });

    it('merges mobile-subdomain and root variants', async () => {
      const engineA = makeEntry('a', [
        makeResult('a', 'https://m.foo.com/x', 'page x', 'body'),
      ]);
      const engineB = makeEntry('b', [
        makeResult('b', 'https://foo.com/x', 'page x', 'body'),
      ]);
      verticalState.general = [engineA, engineB];

      const out = await runV1Search({ query: 'foo bar baz some content' });
      const matches = out.results.filter((r) => /foo\.com\/x/.test(r.url));
      expect(matches.length).toBe(1);
    });

    it('merges http-trailing-slash and https variants', async () => {
      const engineA = makeEntry('a', [
        makeResult('a', 'http://foo.com/x', 'page x', 'body'),
      ]);
      const engineB = makeEntry('b', [
        makeResult('b', 'https://foo.com/x/', 'page x', 'body'),
      ]);
      verticalState.general = [engineA, engineB];

      const out = await runV1Search({ query: 'foo bar baz some content' });
      const matches = out.results.filter((r) => /foo\.com\/x/.test(r.url));
      expect(matches.length).toBe(1);
    });

    it('does NOT merge different paths under the same host', async () => {
      const engineA = makeEntry('a', [
        makeResult('a', 'https://foo.com/x', 'page x', 'body'),
      ]);
      const engineB = makeEntry('b', [
        makeResult('b', 'https://foo.com/y', 'page y', 'body'),
      ]);
      verticalState.general = [engineA, engineB];

      const out = await runV1Search({ query: 'foo bar baz some content' });
      const x = out.results.filter((r) => r.url.endsWith('/x'));
      const y = out.results.filter((r) => r.url.endsWith('/y'));
      expect(x.length).toBe(1);
      expect(y.length).toBe(1);
    });

    it('canonical dedup increases engine_consensus for the merged URL', async () => {
      // Two engines, two URL variants that canonicalize to the same form.
      // The merged result's evidence_score.components.engine_consensus must
      // reflect both engines contributing, not split across two rows.
      const engineA = makeEntry('a', [
        makeResult('a', 'https://foo.com/x?utm_source=a', 'page', 'body'),
      ]);
      const engineB = makeEntry('b', [
        makeResult('b', 'https://www.foo.com/x', 'page', 'body'),
      ]);
      verticalState.general = [engineA, engineB];

      const out = await runV1Search({ query: 'foo bar baz some content' });
      const merged = out.results.find((r) => /foo\.com\/x/.test(r.url));
      expect(merged).toBeDefined();
      expect(merged!.evidence_score?.components.engine_consensus).toBe(2);
    });
  });

  it('emits _score_breakdown only when include_engine_outcomes is true', async () => {
    const engine = makeEntry('bing', [
      makeResult(
        'bing',
        'https://nextjs.org/docs/app',
        'Next.js docs',
        'Server actions caching.',
      ),
    ]);
    verticalState.general = [engine];

    const withFlag = await runV1Search({
      query: 'next.js server actions',
      includeScoreBreakdown: true,
    });
    expect(withFlag.results[0]._score_breakdown).toBeDefined();
    expect(withFlag.results[0]._score_breakdown).toMatchObject({
      base: expect.any(Number),
      domain_quality: expect.any(Number),
      lexical_alignment: expect.any(Number),
      final: expect.any(Number),
    });

    const withoutFlag = await runV1Search({ query: 'next.js server actions' });
    expect(withoutFlag.results[0]._score_breakdown).toBeUndefined();
  });
});

describe('rare-term ranking', () => {
  it('ranks the exact sqlite-vec doc above the generic sqlite.org homepage', async () => {
    verticalState.general = [
      makeEntry('e1', [
        makeResult('e1', 'https://sqlite.org/', 'SQLite Home Page', 'small fast self-contained database'),
        makeResult('e1', 'https://sqlite.org/download.html', 'SQLite Download', 'precompiled binaries'),
        makeResult('e1', 'https://alexgarcia.xyz/sqlite-vec/', 'sqlite-vec: vec0 virtual tables', 'knn query syntax for vec0 virtual tables'),
      ], { quality: 'high' }),
    ];
    const out = await runV1Search({ query: 'sqlite-vec vec0 virtual table knn query syntax', category: 'general' });
    const urls = out.results.map((r) => r.url);
    const docIdx = urls.indexOf('https://alexgarcia.xyz/sqlite-vec/');
    const homeIdx = urls.indexOf('https://sqlite.org/');
    // Encodes WHY: an exact compound-token match must outrank the generic
    // high-authority homepage that merely shares the "sqlite" prefix.
    expect(docIdx).toBeGreaterThanOrEqual(0);
    expect(docIdx).toBeLessThan(homeIdx);
    expect(out.results.slice(0, 2).map((r) => r.url)).toContain('https://alexgarcia.xyz/sqlite-vec/');
  });

  it('ranks the RRF concept page above the "reciprocal" dictionary page', async () => {
    verticalState.general = [
      makeEntry('e1', [
        makeResult('e1', 'https://en.wikipedia.org/wiki/Multiplicative_inverse', 'Reciprocal (mathematics)', 'the reciprocal of a number x is 1/x'),
        makeResult('e1', 'https://example.com/rrf', 'Reciprocal Rank Fusion explained', 'how reciprocal rank fusion combines result rankings'),
      ], { quality: 'high' }),
    ];
    const out = await runV1Search({ query: 'reciprocal rank fusion explained', category: 'general' });
    expect(out.results[0].url).toBe('https://example.com/rrf');
  });
});
