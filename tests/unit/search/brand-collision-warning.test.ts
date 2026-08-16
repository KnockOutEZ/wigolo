import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  SearchEngine,
  SearchEngineOptions,
  RawSearchResult,
} from '../../../src/types.js';
import type { EngineEntry } from '../../../src/search/core/engine-base.js';
import { detectBrandCollision, detectEntityCollision } from '../../../src/search/core/brand-collision.js';

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

// The subject check reads result TITLES, so collision fixtures must carry the
// real ones — a placeholder title would make every result read as off-subject.
function titled(url: string, title: string): RawSearchResult {
  return { title, url, snippet: 'S', relevance_score: 1, engine: 'bing' };
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

// Entity-collision detector (item 3, v2). A proper-noun-head + generic-tail
// query (e.g. "Phoenix framework deployment") is ambiguous — the head names an
// entity that clashes with an everyday word. The warning must anchor the
// disambiguation on the entity head so the caller can re-query it verbatim.
describe('detectEntityCollision (brand-collision v2)', () => {
  it('fires on a proper-noun head + generic tail and quotes the entity head verbatim', () => {
    const w = detectEntityCollision('Phoenix framework deployment');
    expect(w).not.toBeNull();
    expect(w!.detected).toBe(true);
    // The rewrite must carry the proper-noun head verbatim so the caller can
    // anchor a follow-up query on the entity.
    expect(w!.suggested_rewrites.length).toBeGreaterThan(0);
    expect(w!.suggested_rewrites.some((r) => r.includes('Phoenix'))).toBe(true);
  });

  it('quotes the CONTIGUOUS multi-token entity head (e.g. "Comet ML") in the rewrite', () => {
    // A capitalized head immediately followed by an all-caps token (ML/AI/DB)
    // is part of the entity name — quoting only "Comet" would split the brand.
    const w = detectEntityCollision('Comet ML experiment tracking');
    expect(w).not.toBeNull();
    expect(w!.suggested_rewrites.some((r) => r.includes('"Comet ML"'))).toBe(true);
  });

  it('returns null on a pure technical query with no generic tail', () => {
    expect(detectEntityCollision('pgvector hnsw ef_search tuning')).toBeNull();
  });

  // BLOCKER I2 — sentence-frame leads must NOT read as entity heads. An
  // interrogative/article/imperative-verb first token is not a brand, even
  // though it is capitalized and a generic-tail noun follows.
  it('does NOT fire on an interrogative lead ("How to deploy Rails")', () => {
    expect(detectEntityCollision('How to deploy Rails')).toBeNull();
  });

  it('does NOT fire on an imperative-verb lead ("Configure nginx reverse proxy")', () => {
    expect(detectEntityCollision('Configure nginx reverse proxy')).toBeNull();
  });

  it('does NOT fire on an imperative-verb lead ("Deploy app to kubernetes")', () => {
    expect(detectEntityCollision('Deploy app to kubernetes')).toBeNull();
  });

  it('does NOT fire on a superlative/article lead ("Best framework for api development")', () => {
    expect(detectEntityCollision('Best framework for api development')).toBeNull();
  });

  it('does NOT fire on an interrogative lead ("When to use a cache")', () => {
    expect(detectEntityCollision('When to use a cache')).toBeNull();
  });

  it('still fires on a genuine capitalized brand head (Stripe)', () => {
    const w = detectEntityCollision('Stripe payment api');
    expect(w).not.toBeNull();
    expect(w!.suggested_rewrites.some((r) => r.includes('Stripe'))).toBe(true);
  });
});

// The entity path fires on a CASING heuristic — a capitalized head plus a
// generic category word — with no reference to what came back. That inverts the
// signal: a distinctive coinage like "DuckDB" or "ArchiveBox" is exactly the
// name whose own project site owns every top slot, so it drew a warning while
// genuinely poisoned result sets drew none. When the results are known they
// decide, and a single result belonging to the entity silences the warning.
describe('detectEntityCollision — the result set overrides the name heuristic', () => {
  it('stays silent when the top results ARE the entity ("DuckDB docs" -> duckdb.org)', () => {
    expect(
      detectEntityCollision('DuckDB docs', [
        { url: 'https://duckdb.org/docs/stable/', title: 'DuckDB Documentation' },
        { url: 'https://duckdb.org/', title: 'DuckDB' },
        { url: 'https://github.com/duckdb/duckdb', title: 'GitHub - duckdb/duckdb' },
      ]),
    ).toBeNull();
  });

  it('stays silent for "ArchiveBox setup" when the project site answers', () => {
    expect(
      detectEntityCollision('ArchiveBox setup', [
        { url: 'https://archivebox.io/', title: 'ArchiveBox' },
        { url: 'https://github.com/ArchiveBox/ArchiveBox', title: 'GitHub - ArchiveBox/ArchiveBox' },
        { url: 'https://docs.archivebox.io/en/latest/', title: 'ArchiveBox Documentation' },
      ]),
    ).toBeNull();
  });

  it('still fires when no result belongs to the entity head', () => {
    const w = detectEntityCollision('Phoenix framework deployment', [
      { url: 'https://example.com/phoenix-a', title: 'Unrelated page' },
      { url: 'https://other.example/b', title: 'Another unrelated page' },
    ]);
    expect(w).not.toBeNull();
    expect(w!.detected).toBe(true);
  });

  it('still fires when the caller supplies no results — the query-only hedge is unchanged', () => {
    expect(detectEntityCollision('Phoenix framework deployment')).not.toBeNull();
  });
});

// End-to-end through the provider: the two directions of the inversion.
describe('SearchOutput.brand_collision_warning — result-set collision, not name distinctiveness', () => {
  it('warns on "ArchiveBox" when every top result is about a different archive', async () => {
    verticalState.general = [
      makeEntry('bing', [
        titled('https://en.wikipedia.org/wiki/Archive_of_Our_Own', 'Archive of Our Own'),
        titled('https://en.wikipedia.org/wiki/Archives_of_American_Art', 'Archives of American Art'),
        titled('https://en.wikipedia.org/wiki/Archive_of_Folk_Culture', 'Archive of Folk Culture'),
      ]),
    ];
    const provider = new CoreSearchProvider();
    const out = await provider.search(
      { query: 'ArchiveBox', include_content: false },
      { router: undefined as never, samplingServer: undefined as never, engines: [], backendStatus: undefined as never },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data.brand_collision_warning).toBeDefined();
    expect(out.data.brand_collision_warning!.brand_domains_in_top_3).toContain('en.wikipedia.org');
  });

  it('does NOT warn on "DuckDB docs" — every top result is the project itself', async () => {
    verticalState.general = [
      makeEntry('bing', [
        titled('https://duckdb.org/docs/stable/', 'DuckDB Documentation'),
        titled('https://duckdb.org/', 'DuckDB'),
        titled('https://github.com/duckdb/duckdb', 'GitHub - duckdb/duckdb'),
      ]),
    ];
    const provider = new CoreSearchProvider();
    const out = await provider.search(
      { query: 'DuckDB docs', include_content: false },
      { router: undefined as never, samplingServer: undefined as never, engines: [], backendStatus: undefined as never },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data.brand_collision_warning).toBeUndefined();
  });

  it('does NOT warn on "ArchiveBox" when the project site answers', async () => {
    verticalState.general = [
      makeEntry('bing', [
        titled('https://archivebox.io/', 'ArchiveBox'),
        titled('https://github.com/ArchiveBox/ArchiveBox', 'GitHub - ArchiveBox/ArchiveBox'),
        titled('https://docs.archivebox.io/en/latest/', 'ArchiveBox Documentation'),
      ]),
    ];
    const provider = new CoreSearchProvider();
    const out = await provider.search(
      { query: 'ArchiveBox', include_content: false },
      { router: undefined as never, samplingServer: undefined as never, engines: [], backendStatus: undefined as never },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data.brand_collision_warning).toBeUndefined();
  });

  // The subject check is the widest net, so it must run BELOW the lexical
  // dev-term check. For a look-alike like "useState" the results are correct
  // and the QUERY is the ambiguous part; if the subject check answered first it
  // would replace a usable hook rewrite with a claim that nothing in the top-3
  // is about useState — while react.dev sits at rank 1.
  it('keeps the dev-term rewrite for "useState" instead of shadowing it with a subject verdict', async () => {
    verticalState.general = [
      makeEntry('bing', [
        titled('https://react.dev/reference/react/useState', 'useState – React'),
        titled('https://www.geeksforgeeks.org/reactjs/reactjs-usestate-hook/', 'React useState Hook - GeeksforGeeks'),
        titled('https://www.geeksforgeeks.org/reactjs/what-is-usestate-in-react/', 'What is useState () in React - GeeksforGeeks'),
      ]),
    ];
    const provider = new CoreSearchProvider();
    const out = await provider.search(
      { query: 'useState', include_content: false },
      { router: undefined as never, samplingServer: undefined as never, engines: [], backendStatus: undefined as never },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const warning = out.data.brand_collision_warning;
    expect(warning).toBeDefined();
    expect(warning!.suggested_rewrites).toContain('usestate React hook');
    expect(warning!.reason).toContain('popular dev term');
  });
});

// Dual-dispatch: when the entity collision fires, core-provider must run the
// entity-qualified rewrite CONCURRENTLY and record it in queries_executed so
// the extra dispatch is auditable. WHY: the caller needs to see that wigolo
// hedged the ambiguous query with an entity-anchored variant.
describe('SearchOutput — entity-collision dual-dispatch is auditable', () => {
  it('emits a brand_collision_warning and records the entity-qualified rewrite in queries_executed', async () => {
    verticalState.general = [
      makeEntry('bing', [
        makeResult('bing', 'https://example.com/phoenix-a'),
        makeResult('bing', 'https://example.com/phoenix-b'),
        makeResult('bing', 'https://example.com/phoenix-c'),
      ]),
    ];
    const provider = new CoreSearchProvider();
    const out = await provider.search(
      { query: 'Phoenix framework deployment', include_content: false },
      { router: undefined as never, samplingServer: undefined as never, engines: [], backendStatus: undefined as never },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data.brand_collision_warning).toBeDefined();
    expect(out.data.brand_collision_warning!.detected).toBe(true);
    expect(out.data.queries_executed).toBeDefined();
    // The original query plus the entity-qualified rewrite must both appear.
    expect(out.data.queries_executed).toContain('Phoenix framework deployment');
    expect(
      out.data.queries_executed!.some((q) => q.includes('Phoenix') && q !== 'Phoenix framework deployment'),
    ).toBe(true);
  });

  // BLOCKER I1 — the dual-dispatch must be gated on the SAME collision
  // predicate as the warning. An ordinary query that merely has a capitalized
  // head but no collision (no generic tail) must NOT pay a second dispatch nor
  // pollute queries_executed with an entity variant, and must NOT warn.
  it('does NOT add an entity variant for a capitalized-head query with no generic tail', async () => {
    verticalState.general = [
      makeEntry('bing', [makeResult('bing', 'https://example.com/a')]),
    ];
    const provider = new CoreSearchProvider();
    const out = await provider.search(
      { query: 'React hooks useEffect cleanup', include_content: false },
      { router: undefined as never, samplingServer: undefined as never, engines: [], backendStatus: undefined as never },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data.brand_collision_warning).toBeUndefined();
    // No quoted-entity variant added; only the original (plus any rare-term
    // variant, which is not entity-quoted).
    expect(
      (out.data.queries_executed ?? []).some((q) => q.includes('"React"')),
    ).toBe(false);
  });

  it('does NOT add an entity variant nor warn for a plain proper-noun-lead prose query', async () => {
    verticalState.general = [
      makeEntry('bing', [makeResult('bing', 'https://example.com/a')]),
    ];
    const provider = new CoreSearchProvider();
    const out = await provider.search(
      { query: 'Amazon rainforest deforestation', include_content: false },
      { router: undefined as never, samplingServer: undefined as never, engines: [], backendStatus: undefined as never },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data.brand_collision_warning).toBeUndefined();
    expect(
      (out.data.queries_executed ?? []).some((q) => q.includes('"Amazon"')),
    ).toBe(false);
  });

  it('does NOT add an entity variant nor warn for a sentence-lead question', async () => {
    verticalState.general = [
      makeEntry('bing', [makeResult('bing', 'https://example.com/a')]),
    ];
    const provider = new CoreSearchProvider();
    const out = await provider.search(
      { query: 'How to deploy Rails', include_content: false },
      { router: undefined as never, samplingServer: undefined as never, engines: [], backendStatus: undefined as never },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data.brand_collision_warning).toBeUndefined();
    expect(
      (out.data.queries_executed ?? []).some((q) => q.startsWith('"')),
    ).toBe(false);
  });
});
