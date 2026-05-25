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
const { resolveTimeRange } = await import('../../../src/search/core/time-range.js');

function makeResult(
  engineName: string,
  url: string,
  title: string,
  snippet: string,
  publishedDate?: string,
): RawSearchResult {
  return {
    title,
    url,
    snippet,
    relevance_score: 1,
    engine: engineName,
    ...(publishedDate ? { published_date: publishedDate } : {}),
  };
}

function makeEntry(
  name: string,
  results: RawSearchResult[],
  capture?: (opts: SearchEngineOptions | undefined) => void,
): EngineEntry {
  const engine: SearchEngine = {
    name,
    search: vi.fn(async (_q: string, opts?: SearchEngineOptions) => {
      capture?.(opts);
      return results;
    }),
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

const NOW = new Date('2026-05-25T12:00:00Z');
const DAY = 86_400_000;

describe('resolveTimeRange (sub-ticket 3.2)', () => {
  it('day -> fromDate = today - 1 day', () => {
    const r = resolveTimeRange('day', NOW);
    expect(r?.fromDate).toBe(new Date(NOW.getTime() - DAY).toISOString().slice(0, 10));
  });

  it('week -> fromDate = today - 7 days', () => {
    const r = resolveTimeRange('week', NOW);
    expect(r?.fromDate).toBe(new Date(NOW.getTime() - 7 * DAY).toISOString().slice(0, 10));
  });

  it('month -> fromDate = today - 30 days', () => {
    const r = resolveTimeRange('month', NOW);
    expect(r?.fromDate).toBe(new Date(NOW.getTime() - 30 * DAY).toISOString().slice(0, 10));
  });

  it('year -> fromDate = today - 365 days', () => {
    const r = resolveTimeRange('year', NOW);
    expect(r?.fromDate).toBe(new Date(NOW.getTime() - 365 * DAY).toISOString().slice(0, 10));
  });

  it('undefined -> undefined', () => {
    expect(resolveTimeRange(undefined, NOW)).toBeUndefined();
  });
});

describe('runV1Search — time_range (sub-ticket 3.2)', () => {
  it('passes resolved fromDate to engines when time_range=week', async () => {
    let captured: SearchEngineOptions | undefined;
    const engine = makeEntry(
      'bing',
      [makeResult('bing', 'https://example.com/a', 'Title', 'Snippet')],
      (opts) => {
        captured = opts;
      },
    );
    verticalState.general = [engine];

    await runV1Search({ query: 'react news', timeRange: 'week' });

    expect(captured?.fromDate).toBeDefined();
    expect(captured?.fromDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('time_range input overrides inferred date hint from query text', async () => {
    let captured: SearchEngineOptions | undefined;
    const engine = makeEntry(
      'bing',
      [makeResult('bing', 'https://example.com/a', 'Title', 'Snippet')],
      (opts) => {
        captured = opts;
      },
    );
    verticalState.general = [engine];

    // Query says "since 2020" (would yield 2020-01-01); time_range=day should
    // override and produce a much tighter range.
    await runV1Search({ query: 'react news since 2020', timeRange: 'day' });

    expect(captured?.fromDate).toBeDefined();
    expect(captured?.fromDate).not.toBe('2020-01-01');
  });

  it('post-filters results older than the resolved fromDate when published_date is known', async () => {
    const today = new Date();
    const dayAgo = new Date(today.getTime() - 2 * DAY).toISOString().slice(0, 10);
    const old = new Date(today.getTime() - 90 * DAY).toISOString().slice(0, 10);

    const engine = makeEntry('bing', [
      makeResult('bing', 'https://example.com/fresh', 'Fresh', 'Snippet', dayAgo),
      makeResult('bing', 'https://example.com/stale', 'Stale', 'Snippet', old),
      makeResult('bing', 'https://example.com/nodate', 'No Date', 'Snippet'),
    ]);
    verticalState.general = [engine];

    const out = await runV1Search({ query: 'news', timeRange: 'week', maxResults: 10 });
    const urls = out.results.map((r) => r.url);
    expect(urls).toContain('https://example.com/fresh');
    expect(urls).not.toContain('https://example.com/stale');
    // No-date results are kept conservatively.
    expect(urls).toContain('https://example.com/nodate');
  });

  it('does nothing when time_range is omitted', async () => {
    let captured: SearchEngineOptions | undefined;
    const engine = makeEntry(
      'bing',
      [makeResult('bing', 'https://example.com/a', 'Title', 'Snippet')],
      (opts) => {
        captured = opts;
      },
    );
    verticalState.general = [engine];

    await runV1Search({ query: 'react' });
    expect(captured?.fromDate).toBeUndefined();
  });
});
