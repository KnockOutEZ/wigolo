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

// Brand-collision detector v2 (item 3). The old predicate only fired on a
// <=2-token, all-common-noun query, so a real "Entity + generic tail" collision
// like "Phoenix framework deployment" (Phoenix = Elixir framework / city / bird)
// never fired. WHY it matters: a proper-noun-head + generic-tail query is the
// canonical ambiguous case the caller needs disambiguated — the detector must
// fire regardless of token count, but MUST NOT fire on a pure technical query
// that carries no generic tail (those disambiguate themselves).
describe('buildQueryUnderstanding — brand-collision v2 (proper-noun head + generic tail)', () => {
  it('fires on a 3-token proper-noun-head + generic-tail query', () => {
    const u = buildQueryUnderstanding('Phoenix framework deployment', {});
    expect(u.is_brand_collision_prone).toBe(true);
  });

  it('fires on an entity head with a "documentation" generic tail', () => {
    const u = buildQueryUnderstanding('Apollo API documentation', {});
    expect(u.is_brand_collision_prone).toBe(true);
  });

  it('does NOT fire on a pure technical query with no generic tail', () => {
    // "pgvector hnsw ef_search tuning" — an entity + technical qualifiers, but
    // no ambiguous generic category word. Disambiguates itself; must stay false.
    const u = buildQueryUnderstanding('pgvector hnsw ef_search tuning', {});
    expect(u.is_brand_collision_prone).toBe(false);
  });

  it('does NOT fire on a generic-tail query with no proper-noun head', () => {
    // No entity head anchors the collision — a bare category phrase should not
    // trip the detector.
    const u = buildQueryUnderstanding('open source database framework', {});
    expect(u.is_brand_collision_prone).toBe(false);
  });

  it('does NOT fire on an error-token query even with a generic tail', () => {
    // Error strings must not be swallowed by the brand-collision path — S1 owns
    // error-intent handling; the detector defers to it.
    const u = buildQueryUnderstanding('TypeError undefined api reference', {});
    expect(u.is_brand_collision_prone).toBe(false);
  });

  // BLOCKER I2 — a capitalized SENTENCE-FRAME lead (interrogative / article /
  // imperative verb) is not an entity head, so an ordinary question that ends
  // in a generic-tail noun must NOT be flagged brand-collision-prone.
  it.each([
    'How to deploy Rails',
    'Configure nginx reverse proxy',
    'Deploy app to kubernetes',
    'Best framework for api development',
    'When to use a cache',
    'The framework guide for beginners',
  ])('does NOT flag sentence-frame lead: "%s"', (q) => {
    expect(buildQueryUnderstanding(q, {}).is_brand_collision_prone).toBe(false);
  });

  it('still flags a genuine capitalized brand head + generic tail', () => {
    expect(buildQueryUnderstanding('Stripe payment api', {}).is_brand_collision_prone).toBe(true);
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

// query_understanding.entities is populated for queries
// containing named entities. A naive implementation returns entities=[] on
// every real query. Verify both the casing-sensitive proper-noun path and
// the all-lowercase common-name path (e.g. "anthropic ceo").
describe('query_understanding.entities', () => {
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

// When caller passes a string[] (multi-query) the
// `rewrites` field must NOT echo the input variants back to them. Echoing
// rewrites === input is useless — the caller already authored those.
describe('query_understanding.rewrites in multi-query', () => {
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

describe('buildQueryUnderstanding compound_terms', () => {
  it('surfaces detected compound tokens', () => {
    const qu = buildQueryUnderstanding('sqlite-vec vec0 knn query');
    expect(qu.compound_terms).toEqual(expect.arrayContaining(['sqlite-vec', 'vec0']));
  });
  it('is empty for plain queries', () => {
    expect(buildQueryUnderstanding('best coffee maker').compound_terms).toEqual([]);
  });
});
