import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase, closeDatabase } from '../../src/cache/db.js';
import { cacheContent } from '../../src/cache/store.js';
import { handleCache } from '../../src/tools/cache.js';
import { resetConfig } from '../../src/config.js';
import type { RawFetchResult, ExtractionResult } from '../../src/types.js';

function makeRaw(url: string): RawFetchResult {
  return {
    url,
    finalUrl: url,
    html: '<html><body>content</body></html>',
    contentType: 'text/html',
    statusCode: 200,
    method: 'http',
    headers: {},
  };
}

function makeExtraction(overrides: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    title: 'Test Page',
    markdown: '# Test\n\nSome test content.',
    metadata: {},
    links: [],
    images: [],
    extractor: 'defuddle',
    ...overrides,
  };
}

describe('cache tool integration', () => {
  beforeEach(() => {
    resetConfig();
    initDatabase(':memory:');
  });

  afterEach(() => {
    closeDatabase();
    resetConfig();
  });

  it('populates cache and queries via cache tool', async () => {
    cacheContent(
      makeRaw('https://example.com/ts-guide'),
      makeExtraction({ title: 'TypeScript Guide', markdown: '# TypeScript\n\nLearn TypeScript.' }),
    );
    cacheContent(
      makeRaw('https://example.com/react'),
      makeExtraction({ title: 'React Tutorial', markdown: '# React\n\nLearn React hooks.' }),
    );

    const result = await handleCache({ query: 'TypeScript' });

    expect(result.results).toHaveLength(1);
    expect(result.results![0].title).toBe('TypeScript Guide');
    expect(result.results![0].url).toBe('https://example.com/ts-guide');
    expect(result.results![0].markdown).toContain('Learn TypeScript');
  });

  it('filters by URL pattern', async () => {
    cacheContent(makeRaw('https://docs.example.com/api'), makeExtraction({ title: 'API Docs' }));
    cacheContent(makeRaw('https://blog.example.com/post'), makeExtraction({ title: 'Blog Post' }));

    const result = await handleCache({ url_pattern: '*docs.example.com*' });

    expect(result.results).toHaveLength(1);
    expect(result.results![0].title).toBe('API Docs');
  });

  it('returns stats', async () => {
    cacheContent(makeRaw('https://example.com/a'), makeExtraction({ markdown: 'Content A' }));
    cacheContent(makeRaw('https://example.com/b'), makeExtraction({ markdown: 'Content B' }));

    const result = await handleCache({ stats: true });

    expect(result.stats).toBeDefined();
    expect(result.stats!.total_urls).toBe(2);
    expect(result.stats!.total_size_mb).toBeGreaterThanOrEqual(0);
  });

  // The tool-boundary version of the cached_at <-> newest
  // equality. A caller who runs `cache stats` immediately after a
  // `cache search` must see `stats.newest` matching the fetched_at of the
  // search-row hit. Pre-fix these read from different time sources and
  // could disagree.
  it('stats.newest matches fetched_at of the most recent cache search result (M19)', async () => {
    cacheContent(makeRaw('https://example.com/m19'), makeExtraction({ title: 'M19', markdown: 'Hello world content for M19' }));
    const searchR = await handleCache({ query: 'M19' });
    expect(searchR.results).toHaveLength(1);
    const fetchedAtFromSearch = searchR.results![0].fetched_at;
    expect(fetchedAtFromSearch).toBeTruthy();

    const statsR = await handleCache({ stats: true });
    expect(statsR.stats?.newest).toBe(fetchedAtFromSearch);
  });

  it('clears matching entries and returns count', async () => {
    cacheContent(makeRaw('https://example.com/a'), makeExtraction({}));
    cacheContent(makeRaw('https://other.com/b'), makeExtraction({}));

    const result = await handleCache({ clear: true, url_pattern: '*example.com*' });

    expect(result.cleared).toBe(1);

    const remaining = await handleCache({});
    expect(remaining.results).toHaveLength(1);
    expect(remaining.results![0].url).toBe('https://other.com/b');
  });

  it('combines query + url_pattern', async () => {
    cacheContent(
      makeRaw('https://example.com/ts'),
      makeExtraction({ title: 'TS', markdown: 'TypeScript guide' }),
    );
    cacheContent(
      makeRaw('https://other.com/ts'),
      makeExtraction({ title: 'Other TS', markdown: 'TypeScript other' }),
    );
    cacheContent(
      makeRaw('https://example.com/py'),
      makeExtraction({ title: 'Python', markdown: 'Python guide' }),
    );

    const result = await handleCache({ query: 'TypeScript', url_pattern: '*example.com*' });

    expect(result.results).toHaveLength(1);
    expect(result.results![0].title).toBe('TS');
  });
});
