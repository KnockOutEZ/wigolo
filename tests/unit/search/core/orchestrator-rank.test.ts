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

function makeEntry(name: string, results: RawSearchResult[]): EngineEntry {
  const engine: SearchEngine = {
    name,
    search: vi.fn(async (_q: string, _opts?: SearchEngineOptions) => results),
  };
  return { engine };
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
