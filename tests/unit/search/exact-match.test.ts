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

const { runV1Search } = await import('../../../src/search/core/orchestrator.js');

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

describe('runV1Search — exact_match (sub-ticket 3.1)', () => {
  it('passes a quoted query to engines when exact_match=true', async () => {
    const captured: string[] = [];
    const engine: SearchEngine = {
      name: 'bing',
      search: vi.fn(async (q: string) => {
        captured.push(q);
        return [
          makeResult('bing', 'https://example.com/a', 'foo bar baz', 'sentence with foo bar in it'),
        ];
      }),
    };
    verticalState.general = [{ engine }];

    await runV1Search({ query: 'foo bar', exactMatch: true });

    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0]).toBe('"foo bar"');
  });

  it('does not quote the query when exact_match is omitted or false', async () => {
    const captured: string[] = [];
    const engine: SearchEngine = {
      name: 'bing',
      search: vi.fn(async (q: string) => {
        captured.push(q);
        return [
          makeResult('bing', 'https://example.com/a', 'foo bar', 'snippet foo bar'),
        ];
      }),
    };
    verticalState.general = [{ engine }];

    await runV1Search({ query: 'foo bar' });
    expect(captured[0]).toBe('foo bar');

    captured.length = 0;
    verticalState.general = [{ engine }];
    await runV1Search({ query: 'foo bar', exactMatch: false });
    expect(captured[0]).toBe('foo bar');
  });

  it('drops results whose title and snippet do not contain the unquoted query (case-insensitive)', async () => {
    const engine = makeEntry('bing', [
      makeResult('bing', 'https://example.com/match', 'Foo Bar Tutorial', 'Has foo bar in body'),
      makeResult('bing', 'https://example.com/title', 'About FOO BAR', 'Unrelated text'),
      makeResult('bing', 'https://example.com/snippet', 'Unrelated title', 'Talks about foo bar later'),
      makeResult('bing', 'https://example.com/miss', 'Something else', 'No phrase here'),
      makeResult('bing', 'https://example.com/partial', 'Foo only', 'Bar only'),
    ]);
    verticalState.general = [engine];

    const out = await runV1Search({ query: 'foo bar', exactMatch: true, maxResults: 10 });
    const urls = out.results.map((r) => r.url);
    expect(urls).toContain('https://example.com/match');
    expect(urls).toContain('https://example.com/title');
    expect(urls).toContain('https://example.com/snippet');
    expect(urls).not.toContain('https://example.com/miss');
    expect(urls).not.toContain('https://example.com/partial');
  });

  it('does not filter results when exact_match is false', async () => {
    const engine = makeEntry('bing', [
      makeResult('bing', 'https://example.com/a', 'Foo Bar', 'has foo bar'),
      makeResult('bing', 'https://example.com/b', 'Different', 'no match'),
    ]);
    verticalState.general = [engine];

    const out = await runV1Search({ query: 'foo bar', maxResults: 10 });
    expect(out.results.length).toBe(2);
  });
});
