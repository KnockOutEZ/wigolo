import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  SearchEngine,
  SearchEngineOptions,
  RawSearchResult,
} from '../../../../src/types.js';
import type { EngineEntry } from '../../../../src/search/core/engine-base.js';

const verticalState: {
  general: EngineEntry[];
  news: EngineEntry[];
  code: EngineEntry[];
  docs: EngineEntry[];
  papers: EngineEntry[];
} = { general: [], news: [], code: [], docs: [], papers: [] };

vi.mock('../../../../src/search/core/verticals/general.js', () => ({
  getGeneralEngines: () => verticalState.general,
  _resetGeneralEnginesForTest: () => {
    verticalState.general = [];
  },
}));
vi.mock('../../../../src/search/core/verticals/news.js', () => ({
  getNewsEngines: () => verticalState.news,
  _resetNewsEnginesForTest: () => {
    verticalState.news = [];
  },
}));
vi.mock('../../../../src/search/core/verticals/code.js', () => ({
  getCodeEngines: () => verticalState.code,
  _resetCodeEnginesForTest: () => {
    verticalState.code = [];
  },
}));
vi.mock('../../../../src/search/core/verticals/docs.js', () => ({
  getDocsEngines: () => verticalState.docs,
  _resetDocsEnginesForTest: () => {
    verticalState.docs = [];
  },
}));
vi.mock('../../../../src/search/core/verticals/papers.js', () => ({
  getPapersEngines: () => verticalState.papers,
  _resetPapersEnginesForTest: () => {
    verticalState.papers = [];
  },
}));

const { runV1Search } = await import('../../../../src/search/core/orchestrator.js');

function makeEntry(
  name: string,
  results: RawSearchResult[],
  opts: { secondary?: boolean; weight?: number } = {},
): EngineEntry {
  const engine: SearchEngine = {
    name,
    search: vi.fn(async (_q: string, _opts?: SearchEngineOptions) => results),
  };
  return {
    engine,
    weight: opts.weight,
    ...(opts.secondary ? { secondary: true } : {}),
  };
}

function makeResult(
  engineName: string,
  url: string,
  title: string,
  snippet: string,
): RawSearchResult {
  return { title, url, snippet, relevance_score: 1, engine: engineName };
}

beforeEach(() => {
  verticalState.general = [];
  verticalState.news = [];
  verticalState.code = [];
  verticalState.docs = [];
  verticalState.papers = [];
});

describe('runV1Search — secondary-engine demotion (sub-ticket 2.2)', () => {
  it('demotes a secondary-only result below a primary result when both have low alignment', async () => {
    // Same weight + same alignment + same domain-quality; only difference is
    // the secondary flag. Without the secondary mechanism, both would tie on
    // the 2.1 ranker. With it, the secondary result drops behind.
    verticalState.code = [
      makeEntry(
        'primary-eng',
        [
          makeResult(
            'primary-eng',
            'https://primary.example.com/page',
            'Primary doc',
            'General content explaining frameworks.',
          ),
        ],
        { weight: 1.0 },
      ),
      makeEntry(
        'secondary-eng',
        [
          makeResult(
            'secondary-eng',
            'https://secondary.example.com/page',
            'Secondary doc',
            'Generic landing page material.',
          ),
        ],
        { weight: 1.0, secondary: true },
      ),
    ];

    const out = await runV1Search({
      query: 'pgvector hnsw ef_search tuning',
      category: 'code',
    });

    const primaryIdx = out.results.findIndex((r) => r.url.includes('primary.example.com'));
    const secondaryIdx = out.results.findIndex((r) => r.url.includes('secondary.example.com'));
    expect(primaryIdx).toBeGreaterThanOrEqual(0);
    expect(secondaryIdx).toBeGreaterThanOrEqual(0);
    expect(primaryIdx).toBeLessThan(secondaryIdx);

    // The secondary penalty should be visibly larger than a no-penalty
    // version: the secondary result's normalised score should be well under
    // half of the primary's.
    const primaryScore = out.results[primaryIdx].relevance_score;
    const secondaryScore = out.results[secondaryIdx].relevance_score;
    expect(secondaryScore).toBeLessThan(primaryScore * 0.5);
  });

  it('does NOT demote a secondary result when lexical alignment is high', async () => {
    verticalState.code = [
      makeEntry(
        'primary-eng',
        [
          makeResult(
            'primary-eng',
            'https://primary.example.com/different',
            'Primary doc',
            'Unrelated content.',
          ),
        ],
        { weight: 1.0 },
      ),
      makeEntry(
        'secondary-eng',
        [
          makeResult(
            'secondary-eng',
            'https://secondary.example.com/match',
            'HTML search element semantics landmark',
            'Reference for the HTML search element semantics and landmark roles.',
          ),
        ],
        { weight: 1.0, secondary: true },
      ),
    ];

    const out = await runV1Search({
      query: 'html search element semantics landmark',
      category: 'code',
    });

    const primaryIdx = out.results.findIndex((r) => r.url.includes('primary.example.com'));
    const secondaryIdx = out.results.findIndex((r) => r.url.includes('secondary.example.com'));
    expect(secondaryIdx).toBeGreaterThanOrEqual(0);
    // High-alignment secondary should beat low-alignment primary.
    expect(secondaryIdx).toBeLessThan(primaryIdx === -1 ? Infinity : primaryIdx);
  });

  it('does NOT demote a URL contributed by BOTH a primary and a secondary engine', async () => {
    const sharedUrl = 'https://docs.example.com/page';
    verticalState.code = [
      makeEntry(
        'primary-eng',
        [
          makeResult('primary-eng', sharedUrl, 'Doc page', 'unrelated snippet text'),
        ],
        { weight: 1.0 },
      ),
      makeEntry(
        'secondary-eng',
        [
          makeResult('secondary-eng', sharedUrl, 'Doc page', 'unrelated snippet text'),
        ],
        { weight: 1.0, secondary: true },
      ),
      makeEntry(
        'primary-eng-2',
        [
          makeResult(
            'primary-eng-2',
            'https://other.example.com/other',
            'Other doc',
            'unrelated snippet text',
          ),
        ],
        { weight: 1.0 },
      ),
    ];

    const out = await runV1Search({
      query: 'pgvector hnsw',
      category: 'code',
    });

    const sharedIdx = out.results.findIndex((r) => r.url === sharedUrl);
    const otherIdx = out.results.findIndex((r) => r.url === 'https://other.example.com/other');
    expect(sharedIdx).toBeGreaterThanOrEqual(0);
    expect(otherIdx).toBeGreaterThanOrEqual(0);
    // Shared URL got two contributions (one primary, one secondary), so
    // its base RRF score is higher than the other URL with one primary
    // contribution. Secondary demotion must not fire here.
    expect(sharedIdx).toBeLessThan(otherIdx);
  });

  it('yields secondary general-web results for a docs query when MDN + DevDocs return nothing', async () => {
    // Docs pool = MDN + DevDocs (both empty here) + secondary general-web
    // engines. WHY: MDN/DevDocs do not index every docs subject; the secondary
    // web signal is what keeps a docs query from starving to zero.
    verticalState.docs = [
      makeEntry('mdn', [], { weight: 1.2 }),
      makeEntry('devdocs', [], { weight: 0.8 }),
      makeEntry(
        'bing',
        [
          makeResult(
            'bing',
            'https://caddyserver.com/docs/reverse-proxy',
            'Caddy reverse proxy configuration',
            'How to configure a reverse proxy in Caddy server documentation.',
          ),
        ],
        { weight: 0.7, secondary: true },
      ),
    ];

    const out = await runV1Search({
      query: 'how to configure reverse proxy',
      category: 'docs',
    });

    const webIdx = out.results.findIndex((r) => r.url.includes('caddyserver.com'));
    expect(webIdx).toBeGreaterThanOrEqual(0);
  });

  it('does NOT let a low-alignment secondary web result outrank a real MDN hit in the docs pool', async () => {
    verticalState.docs = [
      makeEntry(
        'mdn',
        [
          makeResult(
            'mdn',
            'https://developer.mozilla.org/en-US/docs/Web/API/fetch',
            'javascript fetch api reference global function',
            'The fetch() method starts the process of fetching a resource from the network.',
          ),
        ],
        { weight: 1.2 },
      ),
      makeEntry(
        'bing',
        [
          // Snippet shares SOME query tokens ("fetch", "api") so the result is
          // not filtered out entirely by the relevance threshold — this forces
          // the assertion to prove ordering, not survival.
          makeResult(
            'bing',
            'https://random-blog.example.com/post',
            'A fetch api opinion piece',
            'Loose blog musings that mention fetch and api once each in passing.',
          ),
        ],
        { weight: 0.7, secondary: true },
      ),
    ];

    const out = await runV1Search({
      query: 'javascript fetch api reference',
      category: 'docs',
    });

    const mdnIdx = out.results.findIndex((r) => r.url.includes('developer.mozilla.org'));
    const webIdx = out.results.findIndex((r) => r.url.includes('random-blog.example.com'));
    // Both must be present — otherwise the ordering assertion passes trivially
    // because the web result was dropped rather than demoted.
    expect(mdnIdx).toBeGreaterThanOrEqual(0);
    expect(webIdx).toBeGreaterThanOrEqual(0);
    expect(mdnIdx).toBeLessThan(webIdx);
  });

  it('keeps a real MDN HTML-element page out of the top result for a database code query', async () => {
    verticalState.code = [
      makeEntry(
        'stackoverflow',
        [
          makeResult(
            'stackoverflow',
            'https://stackoverflow.com/q/12345',
            'Tuning pgvector HNSW ef_search for recall',
            'How to choose ef_search for an HNSW index in pgvector.',
          ),
        ],
        { weight: 1.0 },
      ),
      makeEntry(
        'mdn',
        [
          makeResult(
            'mdn',
            'https://developer.mozilla.org/en-US/docs/Web/HTML/Element/search',
            'HTML <search> element',
            'The <search> element represents a search section in HTML.',
          ),
        ],
        { weight: 0.3, secondary: true },
      ),
    ];

    const out = await runV1Search({
      query: 'pgvector HNSW ef_search tuning',
      category: 'code',
    });

    expect(out.results[0]?.url).toBe('https://stackoverflow.com/q/12345');
    const mdnIdx = out.results.findIndex((r) => r.url.includes('developer.mozilla.org'));
    if (mdnIdx !== -1) {
      expect(mdnIdx).toBeGreaterThan(0);
    }
  });
});
