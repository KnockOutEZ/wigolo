import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  SearchEngine,
  SearchEngineOptions,
  RawSearchResult,
} from '../../../src/types.js';
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

const { CoreSearchProvider } = await import('../../../src/search/core/core-provider.js');
const { computeFreshnessSignal } = await import('../../../src/search/core/freshness.js');

function makeResult(
  engineName: string,
  url: string,
  publishedDate?: string,
): RawSearchResult {
  return {
    title: 'T',
    url,
    snippet: 'S',
    relevance_score: 1,
    engine: engineName,
    ...(publishedDate ? { published_date: publishedDate } : {}),
  };
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

describe('computeFreshnessSignal (sub-ticket 3.11)', () => {
  it('extracted when engine supplied published_date', () => {
    const fs = computeFreshnessSignal('https://example.com/x', '2024-03-15T00:00:00Z');
    expect(fs.confidence).toBe('extracted');
    expect(fs.published_date).toBe('2024-03-15T00:00:00Z');
    expect(fs.inferred).toBe(false);
  });

  it('inferred-url when URL contains /YYYY/MM/', () => {
    const fs = computeFreshnessSignal('https://blog.example.com/2024/03/post-slug', undefined);
    expect(fs.confidence).toBe('inferred-url');
    expect(fs.published_date).toBe('2024-03-01');
    expect(fs.inferred).toBe(true);
  });

  it('inferred-url with day in URL', () => {
    const fs = computeFreshnessSignal('https://news.example.com/2024/03/15/headline', undefined);
    expect(fs.confidence).toBe('inferred-url');
    expect(fs.published_date).toBe('2024-03-15');
  });

  it('unknown when no signal', () => {
    const fs = computeFreshnessSignal('https://example.com/page', undefined);
    expect(fs.confidence).toBe('unknown');
    expect(fs.published_date).toBeUndefined();
    expect(fs.inferred).toBe(false);
  });
});

describe('SearchResultItem.freshness_signal (sub-ticket 3.11)', () => {
  it('attaches freshness_signal=extracted when engine provides published_date', async () => {
    verticalState.general = [
      makeEntry('bing', [
        makeResult('bing', 'https://example.com/a', '2024-01-01T00:00:00Z'),
      ]),
    ];
    const provider = new CoreSearchProvider();
    const out = await provider.search(
      { query: 'q', include_content: false },
      { router: undefined as never, samplingServer: undefined as never, engines: [], backendStatus: undefined as never },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data.results[0].freshness_signal?.confidence).toBe('extracted');
  });

  it('attaches inferred-url when URL embeds a date', async () => {
    verticalState.general = [
      makeEntry('bing', [makeResult('bing', 'https://blog.example.com/2024/05/post')]),
    ];
    const provider = new CoreSearchProvider();
    const out = await provider.search(
      { query: 'q', include_content: false },
      { router: undefined as never, samplingServer: undefined as never, engines: [], backendStatus: undefined as never },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data.results[0].freshness_signal?.confidence).toBe('inferred-url');
    expect(out.data.results[0].freshness_signal?.published_date).toBe('2024-05-01');
  });
});
