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
const { faviconUrlFor } = await import('../../../src/search/core/favicon.js');

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

describe('faviconUrlFor (sub-ticket 3.6)', () => {
  it('returns s2/favicons URL keyed by hostname', () => {
    expect(faviconUrlFor('https://example.com/path?q=1')).toContain('example.com');
    expect(faviconUrlFor('https://example.com/')).toContain('example.com');
  });

  it('returns undefined for unparseable URLs', () => {
    expect(faviconUrlFor('not-a-url')).toBeUndefined();
  });

  it('same host returns identical URL (caller-side caching by host)', () => {
    const a = faviconUrlFor('https://example.com/a');
    const b = faviconUrlFor('https://example.com/b');
    expect(a).toBe(b);
  });
});

describe('include_favicon on search output (sub-ticket 3.6)', () => {
  it('attaches favicon to each result when include_favicon=true', async () => {
    verticalState.general = [
      makeEntry('bing', [
        makeResult('bing', 'https://example.com/a'),
        makeResult('bing', 'https://other.com/b'),
      ]),
    ];
    const provider = new CoreSearchProvider();
    const out = await provider.search(
      { query: 'q', include_favicon: true, include_content: false },
      { router: undefined as never, samplingServer: undefined as never, engines: [], backendStatus: undefined as never },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const exampleResult = out.data.results.find((r) => r.url.includes('example.com'));
    const otherResult = out.data.results.find((r) => r.url.includes('other.com'));
    expect(exampleResult?.favicon).toBeDefined();
    expect(otherResult?.favicon).toBeDefined();
    expect(exampleResult?.favicon).toContain('example.com');
    expect(otherResult?.favicon).not.toBe(exampleResult?.favicon);
  });

  it('omits favicon when include_favicon is not set', async () => {
    verticalState.general = [
      makeEntry('bing', [makeResult('bing', 'https://example.com/a')]),
    ];
    const provider = new CoreSearchProvider();
    const out = await provider.search(
      { query: 'q', include_content: false },
      { router: undefined as never, samplingServer: undefined as never, engines: [], backendStatus: undefined as never },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data.results[0].favicon).toBeUndefined();
  });
});
