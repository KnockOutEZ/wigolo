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

// include_domains must be a HARD filter, not a soft demotion-with-floor.
// A soft floor (applyDomainFilters demoting off-domain results when
// in-domain matches are below SOFT_INCLUDE_FLOOR=3) leaks
// off-domain results, sometimes ranked above on-domain.
describe('include_domains — hard filter (C8)', () => {
  it('drops ALL off-domain results when fewer than 3 matching', async () => {
    // Only 1 react.dev hit, 5 off-domain — soft floor today would keep
    // the off-domain results demoted. Hard filter must drop them all.
    verticalState.general = [
      makeEntry('bing', [
        makeResult('bing', 'https://react.dev/learn'),
        makeResult('bing', 'https://medium.com/a'),
        makeResult('bing', 'https://blog.example.com/x'),
        makeResult('bing', 'https://stackoverflow.com/q/1'),
        makeResult('bing', 'https://reddit.com/r/react'),
        makeResult('bing', 'https://news.ycombinator.com/x'),
      ]),
    ];

    const out = await runV1Search({
      query: 'react',
      includeDomains: ['react.dev'],
      maxResults: 10,
    });

    const hosts = out.results.map((r) => new URL(r.url).hostname);
    for (const h of hosts) {
      expect(h === 'react.dev' || h.endsWith('.react.dev')).toBe(true);
    }
    expect(hosts).toEqual(['react.dev']);
  });

  it('returns empty array when zero matching domains (no silent leak)', async () => {
    verticalState.general = [
      makeEntry('bing', [
        makeResult('bing', 'https://medium.com/a'),
        makeResult('bing', 'https://blog.example.com/x'),
      ]),
    ];

    const out = await runV1Search({
      query: 'react',
      includeDomains: ['react.dev'],
      maxResults: 10,
    });

    expect(out.results).toEqual([]);
  });

  it('subdomains match parent include domain (host-suffix match)', async () => {
    verticalState.general = [
      makeEntry('bing', [
        makeResult('bing', 'https://docs.react.dev/x'),
        makeResult('bing', 'https://blog.react.dev/y'),
        makeResult('bing', 'https://medium.com/x'),
      ]),
    ];

    const out = await runV1Search({
      query: 'react',
      includeDomains: ['react.dev'],
      maxResults: 10,
    });

    const hosts = out.results.map((r) => new URL(r.url).hostname);
    expect(hosts).toContain('docs.react.dev');
    expect(hosts).toContain('blog.react.dev');
    expect(hosts).not.toContain('medium.com');
  });

  it('does NOT match a different domain that contains the include name as suffix-only-without-dot', async () => {
    // notreact.dev should NOT match react.dev
    verticalState.general = [
      makeEntry('bing', [
        makeResult('bing', 'https://notreact.dev/x'),
        makeResult('bing', 'https://react.dev/y'),
      ]),
    ];

    const out = await runV1Search({
      query: 'react',
      includeDomains: ['react.dev'],
      maxResults: 10,
    });

    const hosts = out.results.map((r) => new URL(r.url).hostname);
    expect(hosts).not.toContain('notreact.dev');
    expect(hosts).toContain('react.dev');
  });

  it('exclude_domains regression: still hard-drops excluded hosts', async () => {
    // exclude_domains already works; ensure a refactor doesn't regress it.
    verticalState.general = [
      makeEntry('bing', [
        makeResult('bing', 'https://example.com/a'),
        makeResult('bing', 'https://spam.com/x'),
        makeResult('bing', 'https://spam.com/y'),
      ]),
    ];

    const out = await runV1Search({
      query: 'q',
      excludeDomains: ['spam.com'],
      maxResults: 10,
    });

    const hosts = out.results.map((r) => new URL(r.url).hostname);
    expect(hosts).not.toContain('spam.com');
    expect(hosts).toContain('example.com');
  });

  it('multiple include domains all act as a hard whitelist', async () => {
    verticalState.general = [
      makeEntry('bing', [
        makeResult('bing', 'https://react.dev/a'),
        makeResult('bing', 'https://nextjs.org/b'),
        makeResult('bing', 'https://vuejs.org/c'),
        makeResult('bing', 'https://medium.com/d'),
      ]),
    ];

    const out = await runV1Search({
      query: 'q',
      includeDomains: ['react.dev', 'nextjs.org'],
      maxResults: 10,
    });

    const hosts = out.results.map((r) => new URL(r.url).hostname).sort();
    expect(hosts).toEqual(['nextjs.org', 'react.dev']);
  });
});
