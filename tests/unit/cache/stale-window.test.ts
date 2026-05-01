import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isCacheUsable,
  cacheSearchResults,
  getCachedSearchResults,
} from '../../../src/cache/store.js';
import { initDatabase, closeDatabase, getDatabase } from '../../../src/cache/db.js';
import type { CachedContent } from '../../../src/types.js';

function row(expiresAt: string | null): CachedContent {
  return {
    id: 1,
    url: 'u',
    normalizedUrl: 'u',
    title: '',
    markdown: '',
    rawHtml: '',
    metadata: '{}',
    links: '[]',
    images: '[]',
    fetchMethod: 'http',
    extractorUsed: 'defuddle',
    contentHash: 'x',
    fetchedAt: 'now',
    expiresAt,
  };
}

describe('isCacheUsable', () => {
  it('treats null expiresAt as fresh forever', () => {
    expect(isCacheUsable(row(null))).toEqual({ usable: true, stale: false });
  });

  it('returns fresh when expiresAt is in the future', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(isCacheUsable(row(future))).toEqual({ usable: true, stale: false });
  });

  it('returns reject by default when expired', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(isCacheUsable(row(past))).toEqual({ usable: false, stale: false });
  });

  it('returns stale when expired but within staleMaxSeconds', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(isCacheUsable(row(past), { staleMaxSeconds: 3600 })).toEqual({
      usable: true,
      stale: true,
    });
  });

  it('rejects when expired beyond staleMaxSeconds', () => {
    const past = new Date(Date.now() - 4_000_000).toISOString();
    expect(isCacheUsable(row(past), { staleMaxSeconds: 3600 })).toEqual({
      usable: false,
      stale: false,
    });
  });
});

describe('getCachedSearchResults stale window', () => {
  beforeEach(() => {
    initDatabase(':memory:');
  });
  afterEach(() => {
    closeDatabase();
  });

  it('returns null when expired and no staleMaxSeconds', () => {
    cacheSearchResults(
      'q',
      [{ title: 't', url: 'https://u.example', snippet: 's', relevance_score: 1 }],
      ['e'],
    );
    getDatabase()
      .prepare(`UPDATE search_cache SET expires_at = datetime('now', '-1 hour')`)
      .run();
    expect(getCachedSearchResults('q')).toBeNull();
  });

  it('returns stale row when within staleMaxSeconds window', () => {
    cacheSearchResults(
      'q',
      [{ title: 't', url: 'https://u.example', snippet: 's', relevance_score: 1 }],
      ['e'],
    );
    getDatabase()
      .prepare(`UPDATE search_cache SET expires_at = datetime('now', '-1 hour')`)
      .run();
    const got = getCachedSearchResults('q', { staleMaxSeconds: 24 * 3600 });
    expect(got).not.toBeNull();
    expect(got!.stale).toBe(true);
    expect(got!.searched_at).toBeTruthy();
  });

  it('rejects beyond staleMaxSeconds', () => {
    cacheSearchResults(
      'q',
      [{ title: 't', url: 'https://u.example', snippet: 's', relevance_score: 1 }],
      ['e'],
    );
    getDatabase()
      .prepare(`UPDATE search_cache SET expires_at = datetime('now', '-30 hours')`)
      .run();
    expect(getCachedSearchResults('q', { staleMaxSeconds: 24 * 3600 })).toBeNull();
  });

  it('returns fresh row without stale flag when not expired', () => {
    cacheSearchResults(
      'q',
      [{ title: 't', url: 'https://u.example', snippet: 's', relevance_score: 1 }],
      ['e'],
    );
    const got = getCachedSearchResults('q');
    expect(got).not.toBeNull();
    expect(got!.stale).toBeFalsy();
  });
});
