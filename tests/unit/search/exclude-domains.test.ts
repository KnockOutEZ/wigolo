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

describe('runV1Search — exclude_domains subdomain handling (sub-ticket 3.3)', () => {
  it('strips exact host match', async () => {
    verticalState.general = [
      makeEntry('bing', [
        makeResult('bing', 'https://example.com/a'),
        makeResult('bing', 'https://keep.com/a'),
      ]),
    ];
    const out = await runV1Search({
      query: 'q',
      excludeDomains: ['example.com'],
    });
    const hosts = out.results.map((r) => new URL(r.url).hostname);
    expect(hosts).not.toContain('example.com');
    expect(hosts).toContain('keep.com');
  });

  it('strips subdomain when parent domain is excluded', async () => {
    verticalState.general = [
      makeEntry('bing', [
        makeResult('bing', 'https://www.example.com/a'),
        makeResult('bing', 'https://blog.example.com/a'),
        makeResult('bing', 'https://deep.nested.example.com/a'),
        makeResult('bing', 'https://keep.com/a'),
      ]),
    ];
    const out = await runV1Search({
      query: 'q',
      excludeDomains: ['example.com'],
    });
    const hosts = out.results.map((r) => new URL(r.url).hostname);
    expect(hosts).toEqual(['keep.com']);
  });

  it('matches case-insensitively', async () => {
    verticalState.general = [
      makeEntry('bing', [
        makeResult('bing', 'https://Example.COM/a'),
        makeResult('bing', 'https://keep.com/a'),
      ]),
    ];
    const out = await runV1Search({
      query: 'q',
      excludeDomains: ['EXAMPLE.com'],
    });
    const hosts = out.results.map((r) => new URL(r.url).hostname);
    expect(hosts).toEqual(['keep.com']);
  });

  it('tolerates leading dot in entries', async () => {
    verticalState.general = [
      makeEntry('bing', [
        makeResult('bing', 'https://blog.example.com/a'),
        makeResult('bing', 'https://keep.com/a'),
      ]),
    ];
    const out = await runV1Search({
      query: 'q',
      excludeDomains: ['.example.com'],
    });
    const hosts = out.results.map((r) => new URL(r.url).hostname);
    expect(hosts).toEqual(['keep.com']);
  });

  it('does NOT strip a different domain that contains the excluded name as suffix-only-without-dot', async () => {
    // notexample.com should NOT match example.com (the parent boundary is a dot).
    verticalState.general = [
      makeEntry('bing', [
        makeResult('bing', 'https://notexample.com/a'),
        makeResult('bing', 'https://example.com/a'),
      ]),
    ];
    const out = await runV1Search({
      query: 'q',
      excludeDomains: ['example.com'],
    });
    const hosts = out.results.map((r) => new URL(r.url).hostname);
    expect(hosts).toContain('notexample.com');
    expect(hosts).not.toContain('example.com');
  });

  it('handles multiple excluded domains', async () => {
    verticalState.general = [
      makeEntry('bing', [
        makeResult('bing', 'https://a.com/x'),
        makeResult('bing', 'https://b.com/x'),
        makeResult('bing', 'https://c.com/x'),
        makeResult('bing', 'https://blog.b.com/x'),
      ]),
    ];
    const out = await runV1Search({
      query: 'q',
      excludeDomains: ['a.com', 'b.com'],
    });
    const hosts = out.results.map((r) => new URL(r.url).hostname);
    expect(hosts).toEqual(['c.com']);
  });
});
