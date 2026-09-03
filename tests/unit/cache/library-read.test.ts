import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, getDatabase, initDatabase } from '../../../src/cache/db.js';
import {
  cacheContent,
  countCacheFiltered,
  listLibraryPages,
} from '../../../src/cache/store.js';
import type { ExtractionResult, RawFetchResult } from '../../../src/types.js';

function seed(url: string, title: string, markdown = title): void {
  const raw: RawFetchResult = {
    url,
    finalUrl: url,
    html: `<main>${markdown}</main>`,
    contentType: 'text/html',
    statusCode: 200,
    method: 'http',
    headers: {},
  };
  const extraction: ExtractionResult = {
    title,
    markdown,
    metadata: {},
    links: [],
    images: [],
    extractor: 'defuddle',
  };
  cacheContent(raw, extraction);
}

function retime(url: string, fetchedAt: string): void {
  getDatabase()
    .prepare('UPDATE url_cache SET fetched_at = ? WHERE normalized_url = ?')
    .run(fetchedAt, url);
}

describe('listLibraryPages', () => {
  beforeEach(() => initDatabase(':memory:'));
  afterEach(() => closeDatabase());

  it('uses a snapshot keyset cursor so interleaved writes do not duplicate or omit rows', () => {
    for (const [path, day] of [['a', '01'], ['b', '02'], ['c', '03'], ['d', '04']] as const) {
      const url = `https://example.com/${path}`;
      seed(url, path.toUpperCase());
      retime(url, `2026-08-${day} 12:00:00`);
    }

    const first = listLibraryPages({ sort: 'recency', limit: 2 });
    expect(first.rows.map((row) => row.normalized_url)).toEqual([
      'https://example.com/d',
      'https://example.com/c',
    ]);
    expect(first.total).toBe(4);
    expect(first.next_cursor).toEqual(expect.any(String));

    // Lands INSIDE the window the second page still has to read, so a keyset
    // cursor alone would surface it and push a real row off the last page. Only
    // the snapshot watermark can exclude it.
    seed('https://example.com/new', 'NEW');
    retime('https://example.com/new', '2026-08-02 12:00:00');

    const second = listLibraryPages({
      sort: 'recency',
      limit: 2,
      cursor: first.next_cursor ?? undefined,
    });
    expect(second.rows.map((row) => row.normalized_url)).toEqual([
      'https://example.com/b',
      'https://example.com/a',
    ]);
    expect(second.total).toBe(4);
    expect(second.next_cursor).toBeNull();
  });

  it('combines exact host, inclusive time range, and FTS facets with a true total', () => {
    seed('https://www.example.com/inside', 'Inside', 'alpha library result');
    seed('https://blog.example.com/outside', 'Subdomain', 'alpha library result');
    seed('https://example.com/too-old', 'Old', 'alpha library result');
    seed('https://example.com/no-match', 'Other', 'different words');
    retime('https://example.com/inside', '2026-08-02 00:00:00');
    retime('https://blog.example.com/outside', '2026-08-02 00:00:00');
    retime('https://example.com/too-old', '2026-08-01 23:59:59');
    retime('https://example.com/no-match', '2026-08-02 00:00:00');

    const filter = {
      query: 'alpha',
      domain: 'www.example.com',
      from: '2026-08-02 00:00:00',
      to: '2026-08-02 00:00:00',
    };
    const page = listLibraryPages(filter);

    expect(page.rows).toMatchObject([
      {
        normalized_url: 'https://example.com/inside',
        host: 'example.com',
        fetched_at: '2026-08-02 00:00:00',
      },
    ]);
    expect(page.total).toBe(1);
    expect(countCacheFiltered(filter)).toBe(page.total);
  });

  it('refuses a cursor whose filters or sort no longer match the request', () => {
    seed('https://example.com/a', 'A');
    seed('https://example.com/b', 'B');
    const first = listLibraryPages({ domain: 'example.com', limit: 1 });
    const cursor = first.next_cursor ?? '';
    expect(cursor).not.toBe('');

    // Same page size, different filter set: the snapshot and keyset in the
    // cursor describe a view the caller is no longer asking for, so replaying
    // it would silently page through the wrong result set.
    expect(() => listLibraryPages({ limit: 1, cursor })).toThrow(/does not match/);
    expect(() => listLibraryPages({ domain: 'other.example', limit: 1, cursor }))
      .toThrow(/does not match/);
    expect(() => listLibraryPages({ domain: 'example.com', limit: 1, cursor: 'not-a-cursor' }))
      .toThrow(/invalid library cursor/);
  });

  it('orders query results by relevance and paginates equal scores by row id', () => {
    seed('https://example.com/one', 'One', 'needle needle needle');
    seed('https://example.com/two', 'Two', 'needle');
    seed('https://example.com/three', 'Three', 'needle');

    const first = listLibraryPages({ query: 'needle', sort: 'relevance', limit: 1 });
    expect(first.rows[0]?.normalized_url).toBe('https://example.com/one');
    const second = listLibraryPages({
      query: 'needle',
      sort: 'relevance',
      limit: 2,
      cursor: first.next_cursor ?? undefined,
    });
    expect(second.rows.map((row) => row.normalized_url).sort()).toEqual([
      'https://example.com/three',
      'https://example.com/two',
    ]);
  });
});
