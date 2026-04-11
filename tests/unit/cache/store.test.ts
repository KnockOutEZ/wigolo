import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase, closeDatabase } from '../../../src/cache/db.js';
import {
  normalizeUrl,
  cacheContent,
  getCachedContent,
  isExpired,
  searchCache,
  cacheSearchResults,
  getCachedSearchResults,
  getCacheStats,
  searchCacheFiltered,
} from '../../../src/cache/store.js';
import type { RawFetchResult, ExtractionResult, CachedContent } from '../../../src/types.js';
import type { SearchResultItem } from '../../../src/types.js';

function makeRaw(url: string): RawFetchResult {
  return {
    url,
    finalUrl: url,
    html: '<html><body>hello world</body></html>',
    contentType: 'text/html',
    statusCode: 200,
    method: 'http',
    headers: {},
  };
}

function makeExtraction(overrides: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    title: 'Test Page',
    markdown: '# Hello\n\nThis is a test page with some content.',
    metadata: { description: 'A test page', author: 'Tester' },
    links: ['https://example.com/other'],
    images: ['https://example.com/img.png'],
    extractor: 'defuddle',
    ...overrides,
  };
}

describe('normalizeUrl', () => {
  it('strips utm_source param', () => {
    expect(normalizeUrl('https://example.com/page?utm_source=google')).toBe('https://example.com/page');
  });

  it('strips utm_medium param', () => {
    expect(normalizeUrl('https://example.com/page?utm_medium=email')).toBe('https://example.com/page');
  });

  it('strips utm_campaign param', () => {
    expect(normalizeUrl('https://example.com/page?utm_campaign=spring')).toBe('https://example.com/page');
  });

  it('strips utm_content param', () => {
    expect(normalizeUrl('https://example.com/page?utm_content=cta')).toBe('https://example.com/page');
  });

  it('strips utm_term param', () => {
    expect(normalizeUrl('https://example.com/page?utm_term=keyword')).toBe('https://example.com/page');
  });

  it('strips fbclid param', () => {
    expect(normalizeUrl('https://example.com/page?fbclid=abc123')).toBe('https://example.com/page');
  });

  it('strips multiple tracking params and preserves others', () => {
    const url = 'https://example.com/page?id=42&utm_source=twitter&fbclid=xyz';
    expect(normalizeUrl(url)).toBe('https://example.com/page?id=42');
  });

  it('removes www prefix', () => {
    expect(normalizeUrl('https://www.example.com/page')).toBe('https://example.com/page');
  });

  it('strips trailing slash from path', () => {
    expect(normalizeUrl('https://example.com/page/')).toBe('https://example.com/page');
  });

  it('does not strip slash from root path', () => {
    const result = normalizeUrl('https://example.com/');
    expect(result).toBe('https://example.com');
  });

  it('lowercases scheme and host', () => {
    expect(normalizeUrl('HTTPS://Example.COM/Page')).toBe('https://example.com/Page');
  });

  it('handles URL with no params cleanly', () => {
    expect(normalizeUrl('https://example.com/article')).toBe('https://example.com/article');
  });
});

describe('cacheContent + getCachedContent', () => {
  beforeEach(() => {
    initDatabase(':memory:');
  });

  afterEach(() => {
    closeDatabase();
  });

  it('inserts and retrieves content by exact URL', () => {
    const url = 'https://example.com/article';
    cacheContent(makeRaw(url), makeExtraction());
    const result = getCachedContent(url);
    expect(result).not.toBeNull();
    expect(result!.url).toBe(url);
    expect(result!.title).toBe('Test Page');
    expect(result!.markdown).toContain('Hello');
  });

  it('retrieves content by normalized URL (www vs non-www)', () => {
    const urlWithWww = 'https://www.example.com/article';
    cacheContent(makeRaw(urlWithWww), makeExtraction());
    const result = getCachedContent('https://example.com/article');
    expect(result).not.toBeNull();
    expect(result!.normalizedUrl).toBe('https://example.com/article');
  });

  it('retrieves content by URL with tracking params stripped', () => {
    const url = 'https://example.com/article';
    cacheContent(makeRaw(url), makeExtraction());
    const result = getCachedContent('https://example.com/article?utm_source=google');
    expect(result).not.toBeNull();
    expect(result!.url).toBe(url);
  });

  it('stores serialized metadata as JSON string', () => {
    const url = 'https://example.com/meta';
    cacheContent(makeRaw(url), makeExtraction());
    const result = getCachedContent(url);
    expect(result).not.toBeNull();
    expect(typeof result!.metadata).toBe('string');
    const parsed = JSON.parse(result!.metadata);
    expect(parsed.description).toBe('A test page');
  });

  it('stores serialized links as JSON string', () => {
    const url = 'https://example.com/links';
    cacheContent(makeRaw(url), makeExtraction());
    const result = getCachedContent(url);
    expect(result).not.toBeNull();
    expect(typeof result!.links).toBe('string');
    const parsed = JSON.parse(result!.links);
    expect(parsed).toContain('https://example.com/other');
  });

  it('stores serialized images as JSON string', () => {
    const url = 'https://example.com/images';
    cacheContent(makeRaw(url), makeExtraction());
    const result = getCachedContent(url);
    expect(result).not.toBeNull();
    expect(typeof result!.images).toBe('string');
    const parsed = JSON.parse(result!.images);
    expect(parsed).toContain('https://example.com/img.png');
  });

  it('stores content_hash as SHA-256 hex string', () => {
    const url = 'https://example.com/hash';
    cacheContent(makeRaw(url), makeExtraction());
    const result = getCachedContent(url);
    expect(result).not.toBeNull();
    expect(result!.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('stores fetchMethod from RawFetchResult', () => {
    const raw = makeRaw('https://example.com/method');
    raw.method = 'playwright';
    cacheContent(raw, makeExtraction());
    const result = getCachedContent('https://example.com/method');
    expect(result!.fetchMethod).toBe('playwright');
  });

  it('stores extractorUsed from ExtractionResult', () => {
    const url = 'https://example.com/extractor';
    cacheContent(makeRaw(url), makeExtraction({ extractor: 'readability' }));
    const result = getCachedContent(url);
    expect(result!.extractorUsed).toBe('readability');
  });

  it('returns null for unknown URL', () => {
    const result = getCachedContent('https://notcached.example.com/');
    expect(result).toBeNull();
  });

  it('replaces existing entry on re-insert (upsert by normalizedUrl)', () => {
    const url = 'https://example.com/replace';
    cacheContent(makeRaw(url), makeExtraction({ title: 'First' }));
    cacheContent(makeRaw(url), makeExtraction({ title: 'Second' }));
    const result = getCachedContent(url);
    expect(result!.title).toBe('Second');
  });

  it('stores expiresAt as ISO datetime string', () => {
    const url = 'https://example.com/expires';
    cacheContent(makeRaw(url), makeExtraction());
    const result = getCachedContent(url);
    expect(result!.expiresAt).not.toBeNull();
    expect(new Date(result!.expiresAt!).getTime()).toBeGreaterThan(Date.now());
  });
});

describe('isExpired', () => {
  beforeEach(() => {
    initDatabase(':memory:');
  });

  afterEach(() => {
    closeDatabase();
  });

  it('returns false for freshly cached content', () => {
    const url = 'https://example.com/fresh';
    cacheContent(makeRaw(url), makeExtraction());
    const result = getCachedContent(url)!;
    expect(isExpired(result)).toBe(false);
  });

  it('returns true for content with past expiresAt', () => {
    const expired: CachedContent = {
      id: 1,
      url: 'https://example.com',
      normalizedUrl: 'https://example.com',
      title: 'Old',
      markdown: '# Old',
      rawHtml: '<html></html>',
      metadata: '{}',
      links: '[]',
      images: '[]',
      fetchMethod: 'http',
      extractorUsed: 'defuddle',
      contentHash: 'abc',
      fetchedAt: new Date(Date.now() - 1000000).toISOString(),
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    };
    expect(isExpired(expired)).toBe(true);
  });

  it('returns false when expiresAt is null', () => {
    const noExpiry: CachedContent = {
      id: 1,
      url: 'https://example.com',
      normalizedUrl: 'https://example.com',
      title: 'NoExpiry',
      markdown: '# No Expiry',
      rawHtml: '<html></html>',
      metadata: '{}',
      links: '[]',
      images: '[]',
      fetchMethod: 'http',
      extractorUsed: 'defuddle',
      contentHash: 'abc',
      fetchedAt: new Date().toISOString(),
      expiresAt: null,
    };
    expect(isExpired(noExpiry)).toBe(false);
  });
});

describe('searchCache (FTS5)', () => {
  beforeEach(() => {
    initDatabase(':memory:');
  });

  afterEach(() => {
    closeDatabase();
  });

  it('finds cached content by keyword in title', () => {
    cacheContent(makeRaw('https://example.com/typescript'), makeExtraction({ title: 'TypeScript Guide' }));
    const results = searchCache('TypeScript');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].title).toBe('TypeScript Guide');
  });

  it('finds cached content by keyword in markdown', () => {
    cacheContent(
      makeRaw('https://example.com/rust'),
      makeExtraction({ title: 'Rust Intro', markdown: '# Rust\n\nOwnership and borrowing.' })
    );
    const results = searchCache('borrowing');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].url).toBe('https://example.com/rust');
  });

  it('returns empty array when no match', () => {
    cacheContent(makeRaw('https://example.com/go'), makeExtraction({ title: 'Go Language' }));
    const results = searchCache('xyzunmatchableterm99');
    expect(results).toEqual([]);
  });

  it('returns multiple results when multiple entries match', () => {
    cacheContent(makeRaw('https://example.com/a'), makeExtraction({ title: 'JavaScript basics' }));
    cacheContent(makeRaw('https://example.com/b'), makeExtraction({ title: 'Advanced JavaScript' }));
    const results = searchCache('JavaScript');
    expect(results.length).toBe(2);
  });

  it('FTS triggers fire after insert (search works immediately)', () => {
    cacheContent(makeRaw('https://example.com/trigger-test'), makeExtraction({ title: 'TriggerFired' }));
    const results = searchCache('TriggerFired');
    expect(results.length).toBe(1);
  });
});

describe('search result caching', () => {
  beforeEach(() => {
    initDatabase(':memory:');
  });

  afterEach(() => {
    closeDatabase();
  });

  it('caches and retrieves search results by query', () => {
    const results: SearchResultItem[] = [
      { title: 'React', url: 'https://react.dev', snippet: 'UI lib', relevance_score: 0.95 },
    ];

    cacheSearchResults('react tutorial', results, ['searxng']);
    const cached = getCachedSearchResults('react tutorial');

    expect(cached).not.toBeNull();
    expect(cached!.results).toHaveLength(1);
    expect(cached!.results[0].title).toBe('React');
    expect(cached!.engines_used).toContain('searxng');
  });

  it('returns null for non-existent query', () => {
    const cached = getCachedSearchResults('nonexistent query xyz 12345');
    expect(cached).toBeNull();
  });

  it('updates cache on re-search of same query', () => {
    const results1: SearchResultItem[] = [
      { title: 'Old', url: 'https://old.com', snippet: '', relevance_score: 0.5 },
    ];
    const results2: SearchResultItem[] = [
      { title: 'New', url: 'https://new.com', snippet: '', relevance_score: 0.9 },
    ];

    cacheSearchResults('update test', results1, ['a']);
    cacheSearchResults('update test', results2, ['b']);
    const cached = getCachedSearchResults('update test');

    expect(cached!.results[0].title).toBe('New');
    expect(cached!.engines_used).toContain('b');
  });
});

describe('getCacheStats', () => {
  beforeEach(() => {
    initDatabase(':memory:');
  });

  afterEach(() => {
    closeDatabase();
  });

  it('returns zeros for empty cache', () => {
    const stats = getCacheStats();
    expect(stats.total_urls).toBe(0);
    expect(stats.total_size_mb).toBe(0);
    expect(stats.oldest).toBe('');
    expect(stats.newest).toBe('');
  });

  it('returns correct counts after caching content', () => {
    cacheContent(makeRaw('https://example.com/a'), makeExtraction({ markdown: 'A content' }));
    cacheContent(makeRaw('https://example.com/b'), makeExtraction({ markdown: 'B content' }));

    const stats = getCacheStats();
    expect(stats.total_urls).toBe(2);
    expect(stats.total_size_mb).toBeGreaterThan(0);
    expect(stats.oldest).toBeTruthy();
    expect(stats.newest).toBeTruthy();
    expect(stats.oldest <= stats.newest).toBe(true);
  });
});

describe('searchCacheFiltered', () => {
  beforeEach(() => {
    initDatabase(':memory:');
    cacheContent(
      makeRaw('https://example.com/page1'),
      makeExtraction({ title: 'TypeScript Guide', markdown: '# TypeScript\n\nLearn TypeScript basics.' }),
    );
    cacheContent(
      makeRaw('https://docs.python.org/tutorial'),
      makeExtraction({ title: 'Python Tutorial', markdown: '# Python\n\nLearn Python programming.' }),
    );
    cacheContent(
      makeRaw('https://example.com/page2'),
      makeExtraction({ title: 'React Hooks', markdown: '# React Hooks\n\nUseState and useEffect.' }),
    );
  });

  afterEach(() => {
    closeDatabase();
  });

  it('returns all entries when no filters provided', () => {
    const results = searchCacheFiltered({});
    expect(results).toHaveLength(3);
  });

  it('filters by FTS5 query', () => {
    const results = searchCacheFiltered({ query: 'TypeScript' });
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('TypeScript Guide');
  });

  it('filters by URL glob pattern', () => {
    const results = searchCacheFiltered({ urlPattern: '*example.com*' });
    expect(results).toHaveLength(2);
  });

  it('filters by since date', () => {
    const results = searchCacheFiltered({ since: '2020-01-01' });
    expect(results).toHaveLength(3);

    const futureResults = searchCacheFiltered({ since: '2099-01-01' });
    expect(futureResults).toHaveLength(0);
  });

  it('combines query + url_pattern', () => {
    const results = searchCacheFiltered({ query: 'Learn', urlPattern: '*example.com*' });
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('TypeScript Guide');
  });

  it('combines all three filters', () => {
    const results = searchCacheFiltered({
      query: 'TypeScript',
      urlPattern: '*example.com*',
      since: '2020-01-01',
    });
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('TypeScript Guide');
  });
});
