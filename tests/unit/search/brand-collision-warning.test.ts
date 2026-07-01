import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  SearchEngine,
  SearchEngineOptions,
  RawSearchResult,
} from '../../../src/types.js';
import type { EngineEntry } from '../../../src/search/core/engine-base.js';
import { detectBrandCollision } from '../../../src/search/core/brand-collision.js';

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

describe('detectBrandCollision (sub-ticket 3.12)', () => {
  it('returns null when query is not a common noun', () => {
    expect(detectBrandCollision('next.js server actions', ['https://www.next.co.uk'])).toBeNull();
  });

  it('returns null when top-3 has no brand domain', () => {
    expect(detectBrandCollision('next', ['https://nextjs.org/docs'])).toBeNull();
  });

  it('detects brand collision when query is "next" and top-3 includes next.co.uk', () => {
    const w = detectBrandCollision('next', [
      'https://www.next.co.uk/women',
      'https://nextjs.org/docs',
    ]);
    expect(w).not.toBeNull();
    expect(w!.detected).toBe(true);
    expect(w!.brand_domains_in_top_3).toContain('www.next.co.uk');
    expect(w!.suggested_rewrites.length).toBeGreaterThan(0);
    expect(w!.suggested_rewrites[0]).toMatch(/Next\.js/);
  });

  it('handles boutique TLD too', () => {
    const w = detectBrandCollision('best', [
      'https://example.boutique/x',
    ]);
    expect(w).not.toBeNull();
    expect(w!.brand_domains_in_top_3[0]).toContain('example.boutique');
  });
});

describe('SearchOutput.brand_collision_warning (sub-ticket 3.12)', () => {
  it('emits warning when query collides with brand top-3', async () => {
    verticalState.general = [
      makeEntry('bing', [
        makeResult('bing', 'https://www.next.co.uk/women'),
        makeResult('bing', 'https://nextjs.org/docs'),
      ]),
    ];
    const provider = new CoreSearchProvider();
    const out = await provider.search(
      { query: 'next', include_content: false },
      { router: undefined as never, samplingServer: undefined as never, engines: [], backendStatus: undefined as never },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data.brand_collision_warning).toBeDefined();
    expect(out.data.brand_collision_warning!.detected).toBe(true);
  });

  it('omits warning when no brand collision detected', async () => {
    verticalState.general = [
      makeEntry('bing', [makeResult('bing', 'https://nextjs.org/docs')]),
    ];
    const provider = new CoreSearchProvider();
    const out = await provider.search(
      { query: 'next.js docs', include_content: false },
      { router: undefined as never, samplingServer: undefined as never, engines: [], backendStatus: undefined as never },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data.brand_collision_warning).toBeUndefined();
  });
});

// brand_collision_warning was blind to lexical collisions —
// queries that look like a popular dev/tech term but mean something else.
// One example pair is "useState" (React hook) ↔ generic prose.
// A normalized-Levenshtein / substring check against a small lexicon
// of high-traffic dev terms emits the warning whenever a 1-token query
// scores above the similarity threshold against any lexicon entry.
describe('brand_collision_warning lexical-similarity path', () => {
  it('emits a warning when the query is the popular React hook "useState"', async () => {
    verticalState.general = [
      makeEntry('bing', [makeResult('bing', 'https://example.com/a')]),
    ];
    const provider = new CoreSearchProvider();
    const out = await provider.search(
      { query: 'useState', include_content: false },
      { router: undefined as never, samplingServer: undefined as never, engines: [], backendStatus: undefined as never },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data.brand_collision_warning).toBeDefined();
    expect(out.data.brand_collision_warning!.detected).toBe(true);
    expect(out.data.brand_collision_warning!.suggested_rewrites.length).toBeGreaterThan(0);
  });

  it('does NOT warn on a unique, made-up term', async () => {
    verticalState.general = [
      makeEntry('bing', [makeResult('bing', 'https://example.com/a')]),
    ];
    const provider = new CoreSearchProvider();
    const out = await provider.search(
      { query: 'xqyzzqp1', include_content: false },
      { router: undefined as never, samplingServer: undefined as never, engines: [], backendStatus: undefined as never },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data.brand_collision_warning).toBeUndefined();
  });
});
