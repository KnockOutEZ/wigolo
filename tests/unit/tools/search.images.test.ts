// Integration test at the MCP tool boundary for the
// images vertical.
//
// WHY: per memory `feedback_slice_brief_integration_surface`, shipping a
// module behind an MCP tool MUST include an integration test at the tool
// boundary, not just module-level unit coverage. Module-level shape is
// covered by the adapter tests in tests/unit/search/engines/; this asserts
// that `handleSearch` with `category: 'images'` actually:
//   1. STOPS returning `unsupported_category`.
//   2. Returns image-shaped results (image_url / source url / title).
//   3. Surfaces a `needs_key` warning when Brave's adapter is keyless.
//   4. The zero-key DDG path still produces results on its own.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  SearchEngine,
  SearchEngineOptions,
  RawSearchResult,
} from '../../../src/types.js';
import type { SmartRouter } from '../../../src/fetch/router.js';
import type { EngineEntry } from '../../../src/search/core/engine-base.js';

const verticalState: {
  general: EngineEntry[];
  news: EngineEntry[];
  code: EngineEntry[];
  docs: EngineEntry[];
  papers: EngineEntry[];
  images: EngineEntry[];
} = { general: [], news: [], code: [], docs: [], papers: [], images: [] };

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
vi.mock('../../../src/search/core/verticals/images.js', () => ({
  getImageEngines: () => verticalState.images,
  _resetImageEnginesForTest: () => {
    verticalState.images = [];
  },
}));

import { handleSearch } from '../../../src/tools/search.js';
import { _resetSearchProviderForTest } from '../../../src/providers/search-provider.js';
import { resetConfig } from '../../../src/config.js';
import { initDatabase, closeDatabase } from '../../../src/cache/db.js';

function makeImageEntry(name: string, results: RawSearchResult[]): EngineEntry {
  const engine: SearchEngine = {
    name,
    search: vi.fn(async (_q: string, _opts?: SearchEngineOptions) => results),
  };
  return { engine };
}

function makeFailingEntry(name: string, message: string): EngineEntry {
  const engine: SearchEngine = {
    name,
    search: vi.fn(async () => {
      throw new Error(message);
    }),
  };
  return { engine };
}

function imageResult(engineName: string, url: string, image: string, opts: { title?: string; thumb?: string; w?: number; h?: number } = {}): RawSearchResult {
  return {
    title: opts.title ?? 'image',
    url,
    snippet: 'src',
    relevance_score: 1,
    engine: engineName,
    image_url: image,
    ...(opts.thumb ? { thumbnail_url: opts.thumb } : {}),
    ...(opts.w !== undefined && opts.h !== undefined ? { width: opts.w, height: opts.h } : {}),
  };
}

const fakeRouter = {} as SmartRouter;

describe('handleSearch — category=images (S11a H7 integration)', () => {
  const origEnv = process.env;

  beforeEach(() => {
    // WHY: the suite default (tests/setup.ts) pins WIGOLO_SEARCH=searxng, and
    // getSearchProvider() resolves the backend through the cached getConfig().
    // Without resetConfig() the stale 'searxng' value selects the legacy
    // provider, which reaches for the cache DB and throws "Database not
    // initialized" before the core images vertical ever dispatches. Pin core +
    // reset config + init an in-memory DB so the H7 images assertions exercise
    // the core provider in isolation.
    process.env = {
      ...origEnv,
      WIGOLO_SEARCH: 'core',
      WIGOLO_RERANKER: 'none',
      VALIDATE_LINKS: 'false',
      LOG_LEVEL: 'error',
    };
    resetConfig();
    _resetSearchProviderForTest();
    initDatabase(':memory:');
    verticalState.general = [];
    verticalState.news = [];
    verticalState.code = [];
    verticalState.docs = [];
    verticalState.papers = [];
    verticalState.images = [];
  });

  afterEach(() => {
    closeDatabase();
    process.env = origEnv;
    resetConfig();
    _resetSearchProviderForTest();
  });

  it('no longer returns unsupported_category for category=images on core', async () => {
    verticalState.images = [
      makeImageEntry('ddg-image', [
        imageResult('ddg-image', 'https://example.com/cats', 'https://cdn.example.com/cat.jpg', {
          title: 'A cat',
          thumb: 'https://cdn.example.com/cat-thumb.jpg',
          w: 1200,
          h: 800,
        }),
      ]),
    ];
    const r = await handleSearch(
      { query: 'cats', category: 'images', include_content: false },
      [],
      fakeRouter,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.results.length).toBeGreaterThan(0);
    // Image-shaped: every result carries image_url and the source url. WHY:
    // before S11a, this exact assertion would never run because core threw
    // `unsupported_category` before any engine dispatch.
    for (const item of r.data.results) {
      expect(item.image_url).toBeDefined();
      expect(item.url).toBeDefined();
      expect(item.title).toBeDefined();
    }
    // Width + height carried through when the engine reports them.
    expect(r.data.results[0].width).toBe(1200);
    expect(r.data.results[0].height).toBe(800);
    expect(r.data.results[0].thumbnail_url).toBe('https://cdn.example.com/cat-thumb.jpg');
  });

  it('aggregates images[] at top level when include_images=true on a category=images call', async () => {
    verticalState.images = [
      makeImageEntry('ddg-image', [
        imageResult('ddg-image', 'https://a.example/p', 'https://cdn/a.jpg', { title: 'a' }),
        imageResult('ddg-image', 'https://b.example/p', 'https://cdn/b.jpg', { title: 'b' }),
      ]),
    ];
    const r = await handleSearch(
      {
        query: 'cats',
        category: 'images',
        include_images: true,
        include_content: false,
      },
      [],
      fakeRouter,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.images?.length).toBe(2);
    expect(r.data.images?.[0].source_url).toMatch(/example/);
    expect(r.data.images?.[0].url).toMatch(/cdn/);
  });

  it('still produces results when Brave Image fails (missing-key) and DDG succeeds', async () => {
    delete process.env.BRAVE_API_KEY;
    verticalState.images = [
      makeFailingEntry('brave-image', 'BRAVE_API_KEY not set'),
      makeImageEntry('ddg-image', [
        imageResult('ddg-image', 'https://example.com/p', 'https://cdn/x.jpg', { title: 'cat' }),
      ]),
    ];
    const r = await handleSearch(
      { query: 'cats', category: 'images', include_content: false },
      [],
      fakeRouter,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // DDG still surfaces its result.
    expect(r.data.results.length).toBeGreaterThan(0);
    // engine_warnings carries the brave-image needs_key warning so callers
    // see a clear remediation path.
    const warn = r.data.engine_warnings?.find((w) => w.engine === 'brave-image');
    expect(warn).toBeDefined();
    expect(warn!.code).toBe('needs_key');
    expect(warn!.hint).toMatch(/BRAVE_API_KEY/);
  });

  it('engine_telemetry on a category=images call lists the image engines', async () => {
    verticalState.images = [
      makeImageEntry('ddg-image', [
        imageResult('ddg-image', 'https://example.com/p', 'https://cdn/a.jpg'),
      ]),
    ];
    const r = await handleSearch(
      { query: 'cats', category: 'images', include_content: false },
      [],
      fakeRouter,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const names = (r.data.engine_telemetry ?? []).map((e) => e.name);
    expect(names).toContain('ddg-image');
  });
});
