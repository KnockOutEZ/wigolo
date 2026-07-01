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

// exact_match must not drop a URL just because one engine's title/snippet
// happens to omit the phrase. For example: "useState hook" — every engine
// returns the right page but one engine's snippet is sanitized and lacks the
// phrase. Post-dedup filtering on the (collapsed) higher-scored copy then
// discards the URL even though another contributing copy contains the phrase.
describe('exact_match — pre-dedup awareness (C7)', () => {
  it('keeps a URL when ANY contributing engine has the phrase in title or snippet', async () => {
    // Engine A is dispatched first but its snippet/title for the URL lacks the
    // phrase. Engine B (dispatched second) returns the same URL WITH the phrase.
    // Today, fusion keeps engine A's variant (first-seen wins for urlToResult)
    // and the post-dedup exact-match filter drops the URL even though engine B
    // matched. We need the orchestrator to be aware that ANY contributing
    // engine's title+snippet matched.
    const engineA = makeEntry('engine-a', [
      makeResult(
        'engine-a',
        'https://react.dev/reference/react/useState',
        'React Reference',
        'Sanitised snippet without the phrase here.',
      ),
    ]);
    const engineB = makeEntry('engine-b', [
      makeResult(
        'engine-b',
        'https://react.dev/reference/react/useState',
        'useState hook reference',
        'Snippet that mentions useState hook explicitly.',
      ),
    ]);
    verticalState.general = [engineA, engineB];

    const out = await runV1Search({
      query: 'useState hook',
      exactMatch: true,
      maxResults: 10,
    });

    const urls = out.results.map((r) => r.url);
    expect(urls).toContain('https://react.dev/reference/react/useState');
  });

  it('does not drop a result when one engine has the phrase only in the title', async () => {
    // Title-only match must survive even if snippet is irrelevant.
    const engine = makeEntry('engine-a', [
      makeResult(
        'engine-a',
        'https://example.com/useState',
        'useState hook tutorial',
        'Article body excerpt that talks about something else entirely.',
      ),
      makeResult(
        'engine-a',
        'https://example.com/other',
        'Different topic',
        'No phrase here.',
      ),
    ]);
    verticalState.general = [engine];

    const out = await runV1Search({
      query: 'useState hook',
      exactMatch: true,
      maxResults: 10,
    });

    const urls = out.results.map((r) => r.url);
    expect(urls).toContain('https://example.com/useState');
    expect(urls).not.toContain('https://example.com/other');
  });

  it('regression: common phrase that previously dropped to 0 returns >0 hits when any engine matched', async () => {
    // Every engine returns the page but the merged variant in
    // post-dedup happens to be the "no phrase" one. Expectation: >=1 result.
    // Dispatched-first engine has a sanitised snippet without the phrase; the
    // SECOND engine has a snippet containing the phrase. Without pre-dedup
    // awareness, the URL gets dropped because urlToResult keeps the first-seen
    // variant.
    const noisyEngine = makeEntry('noisy', [
      makeResult(
        'noisy',
        'https://stackoverflow.com/q/123',
        'Question about React',
        'Trimmed snippet — no phrase visible.',
      ),
    ]);
    const authoritative = makeEntry('authoritative', [
      makeResult(
        'authoritative',
        'https://stackoverflow.com/q/123',
        'Q: useState hook crashes?',
        'Long-form snippet that quotes the useState hook directly.',
      ),
    ]);
    verticalState.general = [noisyEngine, authoritative];

    const out = await runV1Search({
      query: 'useState hook',
      exactMatch: true,
      maxResults: 10,
    });

    expect(out.results.length).toBeGreaterThan(0);
  });
});
