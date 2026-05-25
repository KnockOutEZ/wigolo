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
const { buildQueryUnderstanding } = await import('../../../src/search/core/query-understanding.js');

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

beforeEach(() => {
  verticalState.general = [];
  verticalState.news = [];
  verticalState.code = [];
  verticalState.docs = [];
  verticalState.papers = [];
});

describe('buildQueryUnderstanding (sub-ticket 3.9)', () => {
  it('reads intent from category hint', () => {
    const u = buildQueryUnderstanding('react hooks tutorial', { category: 'docs' });
    expect(u.intent).toBe('docs');
  });

  it('classifies "next" as brand-collision prone', () => {
    const u = buildQueryUnderstanding('next', {});
    expect(u.is_brand_collision_prone).toBe(true);
  });

  it('extracts proper-noun and acronym entities', () => {
    const u = buildQueryUnderstanding('Next.js HNSW pgvector with React', {});
    expect(u.entities).toEqual(expect.arrayContaining(['Next.js', 'HNSW', 'React']));
  });

  it('honours language hint', () => {
    const u = buildQueryUnderstanding('q', { language: 'de' });
    expect(u.language).toBe('de');
  });

  it('returns date_hint when query implies one', () => {
    const u = buildQueryUnderstanding('react news since 2020', {});
    expect(u.date_hint).not.toBeNull();
    expect(u.date_hint?.fromDate).toBe('2020-01-01');
  });
});

describe('CoreSearchProvider — query_understanding on output (sub-ticket 3.9)', () => {
  it('emits query_understanding on SearchOutput', async () => {
    verticalState.general = [
      makeEntry('bing', [makeResult('bing', 'https://example.com/a')]),
    ];
    const provider = new CoreSearchProvider();
    const out = await provider.search(
      { query: 'next', include_content: false },
      { router: undefined as never, samplingServer: undefined as never, engines: [], backendStatus: undefined as never },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data.query_understanding).toBeDefined();
    expect(out.data.query_understanding!.intent).toBeTypeOf('string');
    expect(out.data.query_understanding!.is_brand_collision_prone).toBe(true);
  });
});
