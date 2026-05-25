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
const { runV1Search } = await import('../../../src/search/core/orchestrator.js');

function makeResult(engineName: string, url: string, title?: string, snippet?: string): RawSearchResult {
  return {
    title: title ?? 'T',
    url,
    snippet: snippet ?? 'S',
    relevance_score: 1,
    engine: engineName,
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

describe('evidence_score (sub-ticket 3.8)', () => {
  it('orchestrator emits evidence_score with all components on every result', async () => {
    verticalState.general = [
      makeEntry('bing', [makeResult('bing', 'https://nextjs.org/docs', 'Next.js docs', 'docs about server actions')]),
    ];
    const out = await runV1Search({ query: 'next.js docs' });
    expect(out.results.length).toBeGreaterThan(0);
    const r = out.results[0];
    expect(r.evidence_score).toBeDefined();
    expect(r.evidence_score!.final).toBeGreaterThanOrEqual(0);
    expect(r.evidence_score!.components).toMatchObject({
      base_rrf: expect.any(Number),
      domain_quality: expect.any(Number),
      lexical_alignment: expect.any(Number),
      recency_boost: expect.any(Number),
      engine_consensus: expect.any(Number),
      context_cosine: expect.any(Number),
    });
    expect(typeof r.evidence_score!.explanation).toBe('string');
    expect(r.evidence_score!.explanation.length).toBeGreaterThan(0);
  });

  it('engine_consensus increases with multiple engines surfacing the same URL', async () => {
    verticalState.general = [
      makeEntry('bing', [makeResult('bing', 'https://nextjs.org/docs')]),
      makeEntry('ddg', [makeResult('ddg', 'https://nextjs.org/docs')]),
      makeEntry('brave', [makeResult('brave', 'https://other.com')]),
    ];
    const out = await runV1Search({ query: 'next.js docs' });
    const next = out.results.find((r) => r.url === 'https://nextjs.org/docs');
    const other = out.results.find((r) => r.url === 'https://other.com');
    expect(next?.evidence_score?.components.engine_consensus).toBeGreaterThanOrEqual(2);
    expect(other?.evidence_score?.components.engine_consensus).toBe(1);
  });

  it('SearchResultItem on core-provider output carries evidence_score', async () => {
    verticalState.general = [
      makeEntry('bing', [makeResult('bing', 'https://example.com/x', 'example', 'an example page')]),
    ];
    const provider = new CoreSearchProvider();
    const out = await provider.search(
      { query: 'example', include_content: false },
      { router: undefined as never, samplingServer: undefined as never, engines: [], backendStatus: undefined as never },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data.results[0].evidence_score).toBeDefined();
    expect(out.data.results[0].evidence_score!.final).toBeGreaterThanOrEqual(0);
  });
});
