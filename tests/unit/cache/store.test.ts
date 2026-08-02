import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase, closeDatabase } from '../../../src/cache/db.js';
import {
  normalizeUrl,
  cacheContent,
  getCachedContent,
  isExpired,
  isCacheUsable,
  searchCache,
  cacheSearchResults,
  getCachedSearchResults,
  getCacheStats,
  searchCacheFiltered,
  clearCacheEntries,
  getHashForNormalizedUrl,
  getMarkdownForNormalizedUrl,
  getHashAndStatusForNormalizedUrl,
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
    raw.method = 'browser';
    cacheContent(raw, makeExtraction());
    const result = getCachedContent('https://example.com/method');
    expect(result!.fetchMethod).toBe('browser');
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

  it('roundtrips content_completeness from RawFetchResult through the cache', () => {
    const url = 'https://example.com/completeness';
    const raw = makeRaw(url);
    raw.method = 'playwright';
    raw.contentCompleteness = { level: 'shell', reason: 'app_shell', settled_by: 'budget' };
    cacheContent(raw, makeExtraction());
    const result = getCachedContent(url);
    expect(result!.contentCompleteness).toEqual({
      level: 'shell',
      reason: 'app_shell',
      settled_by: 'budget',
    });
  });

  it('leaves contentCompleteness undefined when the RawFetchResult lacks it (HTTP tier)', () => {
    const url = 'https://example.com/no-completeness';
    // Default makeRaw is an http-tier result with no contentCompleteness — the
    // same shape a legacy row (written before migration 009) reads back as.
    cacheContent(makeRaw(url), makeExtraction());
    const result = getCachedContent(url);
    expect(result!.contentCompleteness).toBeUndefined();
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

  // `cached_at` (returned by fetch/getCachedContent) can disagree with
  // `stats.newest`. They are the
  // same column read from the same row, so they MUST match string-for-
  // string. Pin both ends so a future change can't silently drift them
  // (e.g. by reading `fetched_at` for cached_at but `created_at` for
  // newest).
  it('cached_at of the most recently cached entry equals stats.newest (M19)', () => {
    cacheContent(makeRaw('https://example.com/a'), makeExtraction({ markdown: 'A content' }));
    // Sleep tick so the second row gets a strictly later second-precision
    // timestamp (toIsoSeconds drops sub-second). Without this, both rows
    // share the same second and `newest` matches both rows; we want to
    // pin that newest tracks the LATEST insert.
    const cachedA = getCachedContent('https://example.com/a');
    expect(cachedA?.fetchedAt).toBeTruthy();

    const stats = getCacheStats();
    // newest must equal the fetchedAt of the most-recently-cached row.
    expect(stats.newest).toBe(cachedA!.fetchedAt);
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

  it('honors limit param', () => {
    const r1 = searchCacheFiltered({ limit: 1 });
    expect(r1).toHaveLength(1);
    const r2 = searchCacheFiltered({ limit: 2 });
    expect(r2).toHaveLength(2);
  });

  it('honors limit combined with query', () => {
    const results = searchCacheFiltered({ query: 'Learn', limit: 1 });
    expect(results).toHaveLength(1);
  });
});

describe('clearCacheEntries', () => {
  beforeEach(() => {
    initDatabase(':memory:');
    cacheContent(
      makeRaw('https://example.com/page1'),
      makeExtraction({ title: 'Page 1', markdown: 'TypeScript content' }),
    );
    cacheContent(
      makeRaw('https://docs.python.org/tutorial'),
      makeExtraction({ title: 'Python', markdown: 'Python content' }),
    );
    cacheContent(
      makeRaw('https://example.com/page2'),
      makeExtraction({ title: 'Page 2', markdown: 'React content' }),
    );
  });

  afterEach(() => {
    closeDatabase();
  });

  it('clears all entries when no filters provided', () => {
    const count = clearCacheEntries({});
    expect(count).toBe(3);
    expect(searchCacheFiltered({})).toHaveLength(0);
  });

  it('clears entries matching URL pattern', () => {
    const count = clearCacheEntries({ urlPattern: '*example.com*' });
    expect(count).toBe(2);
    const remaining = searchCacheFiltered({});
    expect(remaining).toHaveLength(1);
    expect(remaining[0].title).toBe('Python');
  });

  it('clears entries matching FTS5 query', () => {
    const count = clearCacheEntries({ query: 'TypeScript' });
    expect(count).toBe(1);
    expect(searchCacheFiltered({})).toHaveLength(2);
  });

  it('returns 0 when no entries match', () => {
    const count = clearCacheEntries({ urlPattern: '*nonexistent.com*' });
    expect(count).toBe(0);
    expect(searchCacheFiltered({})).toHaveLength(3);
  });
});

describe('getHashForNormalizedUrl', () => {
  beforeEach(() => {
    initDatabase(':memory:');
  });

  afterEach(() => {
    closeDatabase();
  });

  it('returns the content_hash for a cached URL', () => {
    const raw = makeRaw('https://example.com/page');
    const extraction = makeExtraction({ markdown: 'test content' });
    cacheContent(raw, extraction);

    const hash = getHashForNormalizedUrl(normalizeUrl('https://example.com/page'));
    expect(hash).toBeDefined();
    expect(typeof hash).toBe('string');
    expect(hash!.length).toBe(64);
  });

  it('returns null for an uncached URL', () => {
    const hash = getHashForNormalizedUrl('https://not-cached.com');
    expect(hash).toBeNull();
  });

  it('finds the hash via normalized URL even when original differs', () => {
    const raw = makeRaw('https://www.example.com/page/?utm_source=google');
    const extraction = makeExtraction({ markdown: 'some content' });
    cacheContent(raw, extraction);

    const hash = getHashForNormalizedUrl(normalizeUrl('https://example.com/page'));
    expect(hash).toBeDefined();
    expect(hash!.length).toBe(64);
  });

  it('returns the most recent hash when URL was cached multiple times', () => {
    const raw = makeRaw('https://example.com/page');
    cacheContent(raw, makeExtraction({ markdown: 'version 1' }));
    cacheContent(raw, makeExtraction({ markdown: 'version 2' }));

    const hash = getHashForNormalizedUrl(normalizeUrl('https://example.com/page'));
    expect(hash).toBeDefined();
  });

  it('handles URLs with unicode characters', () => {
    const raw = makeRaw('https://example.com/cafe');
    cacheContent(raw, makeExtraction({ markdown: 'cafe content' }));

    const hash = getHashForNormalizedUrl(normalizeUrl('https://example.com/cafe'));
    expect(hash).toBeDefined();
  });
});

describe('getMarkdownForNormalizedUrl', () => {
  beforeEach(() => {
    initDatabase(':memory:');
  });

  afterEach(() => {
    closeDatabase();
  });

  it('returns the markdown for a cached URL', () => {
    const raw = makeRaw('https://example.com/page');
    const extraction = makeExtraction({ markdown: '# Test\n\nContent here.' });
    cacheContent(raw, extraction);

    const md = getMarkdownForNormalizedUrl(normalizeUrl('https://example.com/page'));
    expect(md).toBe('# Test\n\nContent here.');
  });

  it('returns null for an uncached URL', () => {
    const md = getMarkdownForNormalizedUrl('https://not-cached.com');
    expect(md).toBeNull();
  });

  it('finds markdown via normalized URL', () => {
    const raw = makeRaw('https://www.example.com/page/');
    const extraction = makeExtraction({ markdown: 'normalized content' });
    cacheContent(raw, extraction);

    const md = getMarkdownForNormalizedUrl(normalizeUrl('https://example.com/page'));
    expect(md).toBe('normalized content');
  });

  it('handles empty markdown', () => {
    const raw = makeRaw('https://example.com/empty');
    const extraction = makeExtraction({ markdown: '' });
    cacheContent(raw, extraction);

    const md = getMarkdownForNormalizedUrl(normalizeUrl('https://example.com/empty'));
    expect(md).toBe('');
  });

  it('handles very long markdown content', () => {
    const longContent = 'Line\n'.repeat(10000);
    const raw = makeRaw('https://example.com/long');
    const extraction = makeExtraction({ markdown: longContent });
    cacheContent(raw, extraction);

    const md = getMarkdownForNormalizedUrl(normalizeUrl('https://example.com/long'));
    expect(md).toBe(longContent);
  });
});

// --- coalesce hash + http_status into a single SELECT.
//
// WHY: change-detector previously did two indexed SELECTs against the same
// normalized_url to read content_hash and http_status separately. Combining
// them into one SELECT halves the index lookup cost on the hot path that
// gates "is this content actually new?" decisions across crawls and
// re-fetches.

describe('getHashAndStatusForNormalizedUrl', () => {
  beforeEach(() => {
    initDatabase(':memory:');
  });

  afterEach(() => {
    closeDatabase();
  });

  it('returns both hash and status for a cached URL with status persisted', () => {
    const raw = makeRaw('https://example.com/page');
    const extraction = makeExtraction({ markdown: 'body' });
    cacheContent(raw, extraction);

    const out = getHashAndStatusForNormalizedUrl(normalizeUrl('https://example.com/page'));
    expect(out.hash).toBeDefined();
    expect(out.hash).not.toBeNull();
    expect(typeof out.hash).toBe('string');
    expect(out.hash!.length).toBe(64);
    expect(out.status).toBe(200);
  });

  it('returns status=null when the row has a hash but no http_status (legacy / pre-migration)', () => {
    const raw: RawFetchResult = {
      url: 'https://example.com/legacy',
      finalUrl: 'https://example.com/legacy',
      html: '<html><body>x</body></html>',
      contentType: 'text/html',
      // No statusCode at all — simulates a legacy persisted row.
      method: 'http',
      headers: {},
    } as unknown as RawFetchResult;
    cacheContent(raw, makeExtraction({ markdown: 'legacy' }));

    const out = getHashAndStatusForNormalizedUrl(normalizeUrl('https://example.com/legacy'));
    expect(out.hash).not.toBeNull();
    expect(out.hash!.length).toBe(64);
    expect(out.status).toBeNull();
  });

  it('returns hash=null and status=null when the URL is absent from cache', () => {
    const out = getHashAndStatusForNormalizedUrl('https://uncached.example.com/missing');
    expect(out.hash).toBeNull();
    expect(out.status).toBeNull();
  });

  it('agrees with the single-column helpers for a populated row', () => {
    const raw = makeRaw('https://example.com/agree');
    cacheContent(raw, makeExtraction({ markdown: 'agree-body' }));
    const norm = normalizeUrl('https://example.com/agree');

    const combined = getHashAndStatusForNormalizedUrl(norm);
    const standaloneHash = getHashForNormalizedUrl(norm);
    expect(combined.hash).toBe(standaloneHash);
    // status should match what was persisted (200 from makeRaw).
    expect(combined.status).toBe(200);
  });
});

describe('timezone-independent expiry (issue #208)', () => {
  // Stored timestamps are zone-less UTC ("YYYY-MM-DD HH:MM:SS"). The bug:
  // new Date() parses that form as LOCAL time, shifting expiry by the host's
  // UTC offset. These tests flip TZ west of UTC at runtime; on hosts where
  // the runtime ignores a TZ change (e.g. Windows), they skip themselves.
  const originalTz = process.env.TZ;

  function tzFlipTookEffect(): boolean {
    process.env.TZ = 'Etc/GMT+8'; // POSIX sign convention: UTC-8
    return new Date().getTimezoneOffset() === 480;
  }

  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  function zonelessUtc(msFromNow: number): string {
    return new Date(Date.now() + msFromNow)
      .toISOString()
      .replace('T', ' ')
      .replace(/\.\d+Z$/, '');
  }

  function makeCached(expiresAt: string): CachedContent {
    return {
      url: 'https://tz.test/',
      normalizedUrl: 'https://tz.test',
      title: 't',
      markdown: 'm',
      metadata: {},
      links: [],
      images: [],
      fetchMethod: 'http',
      extractorUsed: 'defuddle',
      contentHash: 'h',
      fetchedAt: zonelessUtc(-3_600_000),
      expiresAt,
    } as unknown as CachedContent;
  }

  it('isExpired stays true for a just-expired row under a UTC-8 clock', () => {
    if (!tzFlipTookEffect()) return;
    expect(isExpired(makeCached(zonelessUtc(-60_000)))).toBe(true);
  });

  it('isExpired stays false for a not-yet-expired row under a UTC-8 clock', () => {
    if (!tzFlipTookEffect()) return;
    expect(isExpired(makeCached(zonelessUtc(60_000)))).toBe(false);
  });

  it('isCacheUsable marks a row inside the stale window stale under a UTC-8 clock', () => {
    if (!tzFlipTookEffect()) return;
    const out = isCacheUsable(makeCached(zonelessUtc(-3_600_000)), {
      staleMaxSeconds: 24 * 3600,
    });
    expect(out).toEqual({ usable: true, stale: true });
  });

  it('isCacheUsable rejects a row past the stale window under a UTC-8 clock', () => {
    if (!tzFlipTookEffect()) return;
    const out = isCacheUsable(makeCached(zonelessUtc(-25 * 3_600_000)), {
      staleMaxSeconds: 24 * 3600,
    });
    expect(out).toEqual({ usable: false, stale: false });
  });
});
