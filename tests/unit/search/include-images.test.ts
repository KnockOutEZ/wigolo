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
const { BraveEngine } = await import('../../../src/search/engines/brave.js');

function makeResult(
  engineName: string,
  url: string,
  imageUrl?: string,
  imageAlt?: string,
): RawSearchResult {
  return {
    title: 'T',
    url,
    snippet: 'S',
    relevance_score: 1,
    engine: engineName,
    ...(imageUrl ? { image_url: imageUrl } : {}),
    ...(imageAlt ? { image_alt: imageAlt } : {}),
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

describe('include_images (sub-ticket 3.4)', () => {
  it('aggregates images on output when include_images=true', async () => {
    verticalState.general = [
      makeEntry('bing', [
        makeResult('bing', 'https://example.com/a', 'https://cdn.example.com/a.jpg', 'alt-a'),
        makeResult('bing', 'https://example.com/b', 'https://cdn.example.com/b.png'),
        makeResult('bing', 'https://example.com/c'),
      ]),
    ];
    const provider = new CoreSearchProvider();
    const out = await provider.search(
      { query: 'q', include_images: true, include_content: false },
      { router: undefined as never, samplingServer: undefined as never, engines: [], backendStatus: undefined as never },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data.images).toBeDefined();
    expect(out.data.images?.length).toBe(2);
    const aImg = out.data.images?.find((i) => i.url.endsWith('a.jpg'));
    expect(aImg?.alt).toBe('alt-a');
    expect(aImg?.source_url).toBe('https://example.com/a');
    const bImg = out.data.images?.find((i) => i.url.endsWith('b.png'));
    expect(bImg?.alt).toBeUndefined();
  });

  it('omits images array when include_images is not set', async () => {
    verticalState.general = [
      makeEntry('bing', [makeResult('bing', 'https://example.com/a', 'https://cdn.example.com/a.jpg')]),
    ];
    const provider = new CoreSearchProvider();
    const out = await provider.search(
      { query: 'q', include_content: false },
      { router: undefined as never, samplingServer: undefined as never, engines: [], backendStatus: undefined as never },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data.images).toBeUndefined();
  });

  it('returns empty array when no results have image_url', async () => {
    verticalState.general = [
      makeEntry('bing', [
        makeResult('bing', 'https://example.com/a'),
        makeResult('bing', 'https://example.com/b'),
      ]),
    ];
    const provider = new CoreSearchProvider();
    const out = await provider.search(
      { query: 'q', include_images: true, include_content: false },
      { router: undefined as never, samplingServer: undefined as never, engines: [], backendStatus: undefined as never },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data.images).toEqual([]);
  });
});

describe('Brave engine — image_url extraction (sub-ticket 3.4)', () => {
  it('emits image_url from result.thumbnail.src when present', () => {
    const engine = new BraveEngine();
    const body = {
      web: {
        results: [
          {
            title: 'T',
            url: 'https://example.com/a',
            description: 'D',
            thumbnail: { src: 'https://cdn.example.com/a.jpg' },
          } as unknown,
        ],
      },
    } as Parameters<typeof engine.parseResults>[0];
    const out = engine.parseResults(body, 10);
    expect(out[0].image_url).toBe('https://cdn.example.com/a.jpg');
  });
});
