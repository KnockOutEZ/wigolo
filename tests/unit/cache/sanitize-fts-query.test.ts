import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase, closeDatabase } from '../../../src/cache/db.js';
import {
  sanitizeFtsQuery,
  cacheContent,
  searchCache,
  searchCacheFiltered,
} from '../../../src/cache/store.js';
import type { RawFetchResult, ExtractionResult } from '../../../src/types.js';

describe('sanitizeFtsQuery', () => {
  it('passes plain word tokens through unquoted', () => {
    expect(sanitizeFtsQuery('typescript narrowing')).toBe('typescript narrowing');
  });

  it('quotes tokens containing periods (version numbers)', () => {
    expect(sanitizeFtsQuery('TypeScript 5.4 narrowing')).toBe('TypeScript "5.4" narrowing');
  });

  it('quotes tokens with dashes', () => {
    expect(sanitizeFtsQuery('test-driven development')).toBe('"test-driven" development');
  });

  it('preserves already-quoted phrases', () => {
    expect(sanitizeFtsQuery('"react server" components')).toBe('"react server" components');
  });

  it('preserves FTS operators', () => {
    expect(sanitizeFtsQuery('foo AND bar')).toBe('foo AND bar');
    expect(sanitizeFtsQuery('foo OR bar')).toBe('foo OR bar');
    expect(sanitizeFtsQuery('NOT foo')).toBe('NOT foo');
  });

  it('preserves wildcard suffix on bare tokens', () => {
    expect(sanitizeFtsQuery('react*')).toBe('react*');
  });

  it('quotes URLs and slashes', () => {
    expect(sanitizeFtsQuery('https://example.com')).toBe('"https://example.com"');
  });

  it('handles empty input', () => {
    expect(sanitizeFtsQuery('')).toBe('');
    expect(sanitizeFtsQuery('   ')).toBe('');
  });
});

describe('cache searches with dotted version queries', () => {
  beforeEach(() => initDatabase(':memory:'));
  afterEach(() => closeDatabase());

  function makeRaw(url: string): RawFetchResult {
    return {
      url, finalUrl: url, html: '<html></html>', contentType: 'text/html',
      statusCode: 200, method: 'http', headers: {},
    };
  }
  function makeExtracted(title: string, markdown: string): ExtractionResult {
    return { title, markdown, metadata: {}, links: [], images: [], extractor: 'defuddle' };
  }

  it('searchCache does not throw on version-with-period queries', () => {
    cacheContent(makeRaw('https://example.com/ts'), makeExtracted('TypeScript 5.4', 'TypeScript 5.4 brings narrowing improvements'));
    expect(() => searchCache('TypeScript 5.4 narrowing')).not.toThrow();
  });

  it('searchCacheFiltered does not throw on version queries', () => {
    cacheContent(makeRaw('https://example.com/ts'), makeExtracted('TypeScript 5.4', 'release notes'));
    expect(() => searchCacheFiltered({ query: 'TypeScript 5.4' })).not.toThrow();
  });
});
