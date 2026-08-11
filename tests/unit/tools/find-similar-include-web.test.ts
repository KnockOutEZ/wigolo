import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SearchEngine, RawFetchResult, ExtractionResult } from '../../../src/types.js';
import type { SmartRouter } from '../../../src/fetch/router.js';
import { resetConfig } from '../../../src/config.js';
import { initDatabase, closeDatabase } from '../../../src/cache/db.js';
import { cacheContent } from '../../../src/cache/store.js';

/**
 * P4c — `include_web` is the caller's "do not touch the live web" switch.
 *
 * handleFindSimilar runs a cold-start seed: when a `url` seed lands on a domain
 * with fewer than 5 cached pages it fires the search tool to warm the cache
 * first. That seed never consulted `include_web`, so `include_web: false`
 * (a) made live engine calls and (b) wrote the fetched pages into url_cache,
 * where they came straight back out of the FTS5 lane tagged `source: 'cache'`.
 * A caller who asked for local-only received live-web pages laundered as cache
 * hits — a false provenance claim, not merely wasted work.
 *
 * These assertions sit on the search-tool seam rather than on a mock engine.
 * The engine array is only honoured by the legacy backend; under the default
 * `core` backend the search tool uses its own direct engines, so an engine spy
 * silently stops recording and the test passes for the wrong reason. Spying on
 * `handleSearch` is the seam the seed actually crosses.
 */

const searchSpy = vi.fn().mockResolvedValue({ ok: true, data: { results: [] } });
vi.mock('../../../src/tools/search.js', () => ({
  handleSearch: (...args: unknown[]) => searchSpy(...args),
}));

const extractMock = vi.fn().mockResolvedValue({
  title: 'Mock',
  markdown: '# Mock\n\nContent about hooks and state.',
  metadata: {},
  links: [],
  images: [],
  extractor: 'defuddle' as const,
});
vi.mock('../../../src/providers/extract-provider.js', () => ({
  getExtractProvider: vi.fn(async () => ({ name: 'v1' as const, extract: extractMock })),
  _resetExtractProviderForTest: vi.fn(),
}));

const { handleFindSimilar } = await import('../../../src/tools/find-similar.js');

function seedCache(url: string, title: string, markdown: string): void {
  const raw: RawFetchResult = {
    url,
    finalUrl: url,
    html: `<html><body><h1>${title}</h1><p>${markdown}</p></body></html>`,
    contentType: 'text/html',
    statusCode: 200,
    method: 'http',
    headers: {},
  };
  const extraction: ExtractionResult = {
    title, markdown, metadata: {}, links: [], images: [], extractor: 'defuddle',
  };
  cacheContent(raw, extraction);
}

describe('find_similar include_web governs the live-web seed', () => {
  const originalEnv = process.env;
  const engines: SearchEngine[] = [{ name: 'mock', search: vi.fn().mockResolvedValue([]) }];
  const routerFetch = vi.fn();
  const router = { fetch: routerFetch } as unknown as SmartRouter;

  beforeEach(() => {
    process.env = { ...originalEnv, VALIDATE_LINKS: 'false', LOG_LEVEL: 'error' };
    resetConfig();
    initDatabase(':memory:');
    vi.clearAllMocks();
    searchSpy.mockResolvedValue({ ok: true, data: { results: [] } });
    routerFetch.mockResolvedValue({
      url: 'https://web-fetched.example.net/page',
      finalUrl: 'https://web-fetched.example.net/page',
      html: '<html><body><h1>T</h1><p>Content about hooks and state.</p></body></html>',
      contentType: 'text/html',
      statusCode: 200,
      method: 'http' as const,
      headers: {},
    });
  });

  afterEach(() => {
    closeDatabase();
    process.env = originalEnv;
    resetConfig();
  });

  it('does not run the cold-start web seed for a url seed when include_web is false', async () => {
    const r = await handleFindSimilar(
      { url: 'https://cold.example.org/some/page', include_web: false },
      engines,
      router,
    );

    expect(r.ok).toBe(true);
    expect(searchSpy).not.toHaveBeenCalled();
  });

  it('does not report cache_seeded when include_web is false', async () => {
    // cache_seeded is the response field that tells a caller "we warmed the
    // cache from the live web during this call". Reporting it under
    // include_web: false would be the same false provenance claim, one layer up.
    const r = await handleFindSimilar(
      { url: 'https://cold.example.org/some/page', include_web: false },
      engines,
      router,
    );

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.cache_seeded).toBeUndefined();
  });

  it('still runs the cold-start web seed when include_web is true', async () => {
    // Control. A guard that suppressed seeding for everybody would satisfy both
    // assertions above while quietly deleting cold-start warming for the
    // default path, which is the overwhelming majority of calls.
    //
    // Asserted via cache_seeded rather than the spy: findSimilar's own web
    // fallback calls the same handleSearch, so a bare call count cannot tell
    // the two call sites apart. cache_seeded is set by the seed and nothing else.
    const r = await handleFindSimilar(
      { url: 'https://cold.example.org/some/page', include_web: true },
      engines,
      router,
    );

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.cache_seeded).toBe(true);
  });

  it('still runs the cold-start web seed when include_web is omitted', async () => {
    // include_web defaults to true; the guard must key off an explicit false,
    // not off `!input.include_web`, or every default caller loses seeding.
    const r = await handleFindSimilar(
      { url: 'https://cold.example.org/some/page' },
      engines,
      router,
    );

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.cache_seeded).toBe(true);
  });

  it('leaves a warm domain unseeded even when include_web is true', async () => {
    // The seed is already gated on a thin domain (<5 cached pages). This pins
    // that the include_web guard is additive to that condition rather than a
    // replacement for it — a rewrite that keyed only on include_web would start
    // re-seeding every warm domain on every call.
    for (let i = 0; i < 6; i++) {
      seedCache(`https://warm.example.org/p${i}`, `Page ${i}`, `# Page ${i}\n\nHooks and **state**.`);
    }

    const r = await handleFindSimilar(
      { url: 'https://warm.example.org/p0', include_web: true },
      engines,
      router,
    );

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.cache_seeded).toBeUndefined();
  });
});
