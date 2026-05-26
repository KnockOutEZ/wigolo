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

// Slice 8 / M6: query_understanding.entities is populated for queries
// containing named entities. The audit observed entities=[] on every
// real query. Verify both the casing-sensitive proper-noun path and
// the all-lowercase common-name path the audit hit (e.g. "anthropic ceo").
describe('query_understanding.entities (Slice 8 / M6)', () => {
  it('extracts proper-noun + acronym entities from a properly-cased query', async () => {
    verticalState.general = [
      makeEntry('bing', [makeResult('bing', 'https://example.com/a')]),
    ];
    const provider = new CoreSearchProvider();
    const out = await provider.search(
      { query: 'Anthropic CEO', include_content: false },
      { router: undefined as never, samplingServer: undefined as never, engines: [], backendStatus: undefined as never },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const entities = out.data.query_understanding?.entities ?? [];
    expect(entities.length).toBeGreaterThan(0);
    expect(entities).toEqual(expect.arrayContaining(['Anthropic']));
  });

  it('extracts entities from an all-lowercase query against a known-entity lexicon', async () => {
    // Many search callers downcase their query text before sending; the
    // extractor must still surface the entity rather than returning [].
    verticalState.general = [
      makeEntry('bing', [makeResult('bing', 'https://example.com/a')]),
    ];
    const provider = new CoreSearchProvider();
    const out = await provider.search(
      { query: 'anthropic ceo', include_content: false },
      { router: undefined as never, samplingServer: undefined as never, engines: [], backendStatus: undefined as never },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const entities = (out.data.query_understanding?.entities ?? []).map((e) => e.toLowerCase());
    expect(entities).toEqual(expect.arrayContaining(['anthropic']));
  });
});

// Slice 8 / M7: when caller passes a string[] (multi-query) the
// `rewrites` field must NOT echo the input variants back to them. The
// audit observed rewrites === input — useless, the caller already
// authored those.
describe('query_understanding.rewrites in multi-query (Slice 8 / M7)', () => {
  it('rewrites is empty when caller is the rewriter', async () => {
    verticalState.general = [
      makeEntry('bing', [makeResult('bing', 'https://example.com/a')]),
    ];
    const provider = new CoreSearchProvider();
    const out = await provider.search(
      {
        query: ['hnsw tuning', 'ef_construction m', 'pgvector index'],
        include_content: false,
      },
      { router: undefined as never, samplingServer: undefined as never, engines: [], backendStatus: undefined as never },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data.query_understanding?.rewrites ?? []).toEqual([]);
  });
});
