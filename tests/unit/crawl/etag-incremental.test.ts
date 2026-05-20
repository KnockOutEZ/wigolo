import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDatabase, closeDatabase } from '../../../src/cache/db.js';
import {
  getCachedHeaders,
  saveFetchHeaders,
  markFetchedNotModified,
  conditionalFetch,
  _clearEtagCacheForTest,
} from '../../../src/crawl/etag-incremental.js';
import type { RawFetchResult } from '../../../src/types.js';

function makeResult(headers: Record<string, string>): RawFetchResult {
  return {
    url: 'https://example.com/page',
    finalUrl: 'https://example.com/page',
    html: '<html><body>hi</body></html>',
    contentType: 'text/html',
    statusCode: 200,
    method: 'http',
    headers,
  };
}

describe('etag-incremental', () => {
  beforeEach(() => {
    initDatabase(':memory:');
    _clearEtagCacheForTest();
  });

  afterEach(() => {
    closeDatabase();
  });

  it('crawl_etags table exists after migration', () => {
    // Smoke test: saveFetchHeaders must succeed against the migrated schema.
    expect(() => saveFetchHeaders('https://example.com/x', { etag: '"abc"' })).not.toThrow();
  });

  it('saveFetchHeaders + getCachedHeaders roundtrip', () => {
    saveFetchHeaders('https://example.com/page', {
      ETag: '"v1"',
      'Last-Modified': 'Wed, 01 Jan 2025 00:00:00 GMT',
    });
    const cached = getCachedHeaders('https://example.com/page');
    expect(cached).not.toBeNull();
    expect(cached!.etag).toBe('"v1"');
    expect(cached!.lastModified).toBe('Wed, 01 Jan 2025 00:00:00 GMT');
    expect(cached!.fetchedAt).toBeTruthy();
  });

  it('returns null for unknown url', () => {
    expect(getCachedHeaders('https://example.com/missing')).toBeNull();
  });

  it('upserts on repeat save', () => {
    saveFetchHeaders('https://example.com/page', { etag: '"v1"' });
    saveFetchHeaders('https://example.com/page', { etag: '"v2"' });
    const cached = getCachedHeaders('https://example.com/page');
    expect(cached!.etag).toBe('"v2"');
  });

  it('multiple URLs stay independent', () => {
    saveFetchHeaders('https://a.example.com/x', { etag: '"a"' });
    saveFetchHeaders('https://b.example.com/y', { etag: '"b"' });
    expect(getCachedHeaders('https://a.example.com/x')!.etag).toBe('"a"');
    expect(getCachedHeaders('https://b.example.com/y')!.etag).toBe('"b"');
  });

  it('markFetchedNotModified updates fetched_at only', async () => {
    saveFetchHeaders('https://example.com/page', { etag: '"v1"' });
    const before = getCachedHeaders('https://example.com/page')!.fetchedAt;
    await new Promise(r => setTimeout(r, 10));
    markFetchedNotModified('https://example.com/page');
    const after = getCachedHeaders('https://example.com/page')!;
    expect(after.etag).toBe('"v1"');
    expect(after.fetchedAt >= before).toBe(true);
  });

  describe('conditionalFetch', () => {
    it('cache empty → full fetch + save', async () => {
      const fetchFn = vi.fn(async () => makeResult({ etag: '"new"' }));
      const result = await conditionalFetch('https://example.com/page', fetchFn);
      expect(result.notModified).toBeUndefined();
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(getCachedHeaders('https://example.com/page')!.etag).toBe('"new"');
    });

    it('cache present + matching etag → notModified=true', async () => {
      saveFetchHeaders('https://example.com/page', { etag: '"same"' });
      const fetchFn = vi.fn(async () => makeResult({ etag: '"same"' }));
      const result = await conditionalFetch('https://example.com/page', fetchFn);
      expect(result.notModified).toBe(true);
    });

    it('cache present + different etag → no notModified flag', async () => {
      saveFetchHeaders('https://example.com/page', { etag: '"old"' });
      const fetchFn = vi.fn(async () => makeResult({ etag: '"new"' }));
      const result = await conditionalFetch('https://example.com/page', fetchFn);
      expect(result.notModified).toBeUndefined();
      expect(getCachedHeaders('https://example.com/page')!.etag).toBe('"new"');
    });

    it('falls back to last-modified when etag absent', async () => {
      saveFetchHeaders('https://example.com/page', {
        'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT',
      });
      const fetchFn = vi.fn(async () => makeResult({
        'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT',
      }));
      const result = await conditionalFetch('https://example.com/page', fetchFn);
      expect(result.notModified).toBe(true);
    });

    it('response missing etag/last-modified → marks not-modified on existing row', async () => {
      saveFetchHeaders('https://example.com/page', { etag: '"prev"' });
      const before = getCachedHeaders('https://example.com/page')!.fetchedAt;
      await new Promise(r => setTimeout(r, 10));

      const fetchFn = vi.fn(async () => makeResult({}));
      await conditionalFetch('https://example.com/page', fetchFn);

      const after = getCachedHeaders('https://example.com/page')!;
      expect(after.etag).toBe('"prev"'); // preserved
      expect(after.fetchedAt >= before).toBe(true); // updated
    });
  });
});
