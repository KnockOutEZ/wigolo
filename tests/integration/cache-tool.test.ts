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

  it('populates cache and queries via cache tool', () => {
    cacheContent(
      makeRaw('https://example.com/ts-guide'),
      makeExtraction({ title: 'TypeScript Guide', markdown: '# TypeScript\n\nLearn TypeScript.' }),
    );
    cacheContent(
      makeRaw('https://example.com/react'),
      makeExtraction({ title: 'React Tutorial', markdown: '# React\n\nLearn React hooks.' }),
    );

    const result = handleCache({ query: 'TypeScript' });

    expect(result.results).toHaveLength(1);
    expect(result.results![0].title).toBe('TypeScript Guide');
    expect(result.results![0].url).toBe('https://example.com/ts-guide');
    expect(result.results![0].markdown).toContain('Learn TypeScript');
  });

  it('filters by URL pattern', () => {
    cacheContent(makeRaw('https://docs.example.com/api'), makeExtraction({ title: 'API Docs' }));
    cacheContent(makeRaw('https://blog.example.com/post'), makeExtraction({ title: 'Blog Post' }));

    const result = handleCache({ url_pattern: '*docs.example.com*' });

    expect(result.results).toHaveLength(1);
    expect(result.results![0].title).toBe('API Docs');
  });

  it('returns stats', () => {
    cacheContent(makeRaw('https://example.com/a'), makeExtraction({ markdown: 'Content A' }));
    cacheContent(makeRaw('https://example.com/b'), makeExtraction({ markdown: 'Content B' }));

    const result = handleCache({ stats: true });

    expect(result.stats).toBeDefined();
    expect(result.stats!.total_urls).toBe(2);
    expect(result.stats!.total_size_mb).toBeGreaterThanOrEqual(0);
  });

  it('clears matching entries and returns count', () => {
    cacheContent(makeRaw('https://example.com/a'), makeExtraction({}));
    cacheContent(makeRaw('https://other.com/b'), makeExtraction({}));

    const result = handleCache({ clear: true, url_pattern: '*example.com*' });

    expect(result.cleared).toBe(1);

    const remaining = handleCache({});
    expect(remaining.results).toHaveLength(1);
    expect(remaining.results![0].url).toBe('https://other.com/b');
  });

  it('combines query + url_pattern', () => {
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

    const result = handleCache({ query: 'TypeScript', url_pattern: '*example.com*' });

    expect(result.results).toHaveLength(1);
    expect(result.results![0].title).toBe('TS');
  });
});
