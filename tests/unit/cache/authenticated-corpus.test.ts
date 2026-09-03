import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  getAuthenticatedCorpusStats,
  purgeAuthenticatedCorpus,
} from '../../../src/cache/index.js';
import type {
  AuthenticatedCorpusPurgeResult,
  AuthenticatedCorpusStats,
} from '../../../src/cache/index.js';
import { closeDatabase, getDatabase, initDatabase } from '../../../src/cache/db.js';
import { cacheContent } from '../../../src/cache/store.js';
import { SqliteVecStore } from '../../../src/cache/sqlite-vec-store.js';
import { resetConfig } from '../../../src/config.js';
import type { ExtractionResult, RawFetchResult } from '../../../src/types.js';

function raw(url: string, html: string, authenticated: boolean): RawFetchResult {
  return {
    url,
    finalUrl: url,
    html,
    contentType: 'text/html',
    statusCode: 200,
    method: 'browser',
    headers: {},
    authApplied: authenticated || undefined,
  } as RawFetchResult;
}

function extraction(markdown: string): ExtractionResult {
  return {
    markdown,
    title: 'Page',
    metadata: {},
    links: [],
    images: [],
    extractor: 'readability',
  } as ExtractionResult;
}

function write(url: string, markdown: string, html: string, authenticated = false): void {
  cacheContent(raw(url, html, authenticated), extraction(markdown));
}

function vector(first: number): Float32Array {
  const value = new Float32Array(384);
  value[0] = first;
  return value;
}

function setFetchedAt(table: 'url_cache' | 'url_versions', markdown: string, fetchedAt: string): void {
  getDatabase().prepare(`UPDATE ${table} SET fetched_at = ? WHERE markdown = ?`).run(fetchedAt, markdown);
}

function count(table: 'url_cache' | 'url_versions' | 'vec_id_map', authenticated?: boolean): number {
  const predicate = authenticated === undefined ? '' : ' WHERE origin_authenticated = ?';
  const params = authenticated === undefined ? [] : [authenticated ? 1 : 0];
  return (getDatabase().prepare(`SELECT COUNT(*) AS n FROM ${table}${predicate}`).get(...params) as { n: number }).n;
}

beforeEach(() => {
  resetConfig();
  initDatabase(':memory:');
});

afterEach(() => {
  closeDatabase();
  resetConfig();
});

describe('authenticated corpus privacy surface', () => {
  it('returns a zero/null summary for an empty corpus', () => {
    const expected: AuthenticatedCorpusStats = {
      currentRows: 0,
      versionRows: 0,
      bodyBytes: 0,
      oldestFetchedAt: null,
      newestFetchedAt: null,
    };
    expect(getAuthenticatedCorpusStats()).toEqual(expected);
  });

  it('counts only known-authenticated bodies, in UTF-8 bytes, across both stores', () => {
    const privateMarkdown = 'privé 🔒';
    const privateHtml = '<p>privé 🔒</p>';
    write('https://app.example/private', privateMarkdown, privateHtml, true);
    write('https://app.example/public', 'public', '<p>public</p>');

    setFetchedAt('url_cache', privateMarkdown, '2026-01-03 04:05:06');
    setFetchedAt('url_versions', privateMarkdown, '2026-01-02 03:04:05');

    expect(getAuthenticatedCorpusStats()).toEqual({
      currentRows: 1,
      versionRows: 1,
      bodyBytes:
        Buffer.byteLength(privateMarkdown, 'utf8') * 2
        + Buffer.byteLength(privateHtml, 'utf8'),
      oldestFetchedAt: '2026-01-02 03:04:05',
      newestFetchedAt: '2026-01-03 04:05:06',
    });
  });

  it('treats a legacy/default-zero marker as unknown, never authenticated', () => {
    const db = getDatabase();
    db.prepare(`
      INSERT INTO url_cache (url, normalized_url, markdown, raw_html, content_hash, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      'https://legacy.example/page',
      'https://legacy.example/page',
      'legacy',
      '<p>legacy</p>',
      createHash('sha256').update('legacy').digest('hex'),
      '2025-01-01 00:00:00',
    );
    db.prepare(`
      INSERT INTO url_versions
        (normalized_url, content_hash, markdown, fetched_at, byte_len)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      'https://legacy.example/page',
      'legacy-version',
      'legacy version',
      '2024-01-01 00:00:00',
      Buffer.byteLength('legacy version', 'utf8'),
    );

    expect(getAuthenticatedCorpusStats()).toEqual({
      currentRows: 0,
      versionRows: 0,
      bodyBytes: 0,
      oldestFetchedAt: null,
      newestFetchedAt: null,
    });
  });
});

describe('purgeAuthenticatedCorpus', () => {
  it('purges authenticated versions only by default, leaving the live row, FTS, and vector intact', async () => {
    const url = 'https://private.example/default';
    const token = 'versionsonlysecret';
    write(url, token, `<p>${token}</p>`, true);
    const vectors = new SqliteVecStore(getDatabase());
    await vectors.upsert([
      { id: url, vector: vector(1), metadata: { url, contentHash: '', modelId: 'test' } },
    ]);

    expect(purgeAuthenticatedCorpus()).toEqual({
      currentRows: 0,
      versionRows: 1,
      vectorRows: 0,
    });
    expect(count('url_cache', true)).toBe(1);
    expect(count('url_versions', true)).toBe(0);
    expect(count('vec_id_map')).toBe(1);
    expect(await vectors.search(vector(1), 1)).toEqual([
      expect.objectContaining({ id: url }),
    ]);
    const ftsRows = getDatabase()
      .prepare(`SELECT COUNT(*) AS n FROM url_cache_fts WHERE url_cache_fts MATCH ?`)
      .get(token) as { n: number };
    expect(ftsRows.n).toBe(1);
  });

  it('removes authenticated live bodies only with includeLiveRows, with exact counts', async () => {
    const privateCurrentUrl = 'https://mixed.example/account';
    const anonymousCurrentUrl = 'https://mixed.example/news';
    const publicUrl = 'https://public.example/page';

    // Same URL, anonymous history then an authenticated current body. The purge
    // must retain the anonymous historical bytes even though its live URL goes.
    write(privateCurrentUrl, 'anonymous account shell', '<p>anon shell</p>');
    write(privateCurrentUrl, 'authenticatedaccountsecret', '<p>authenticatedaccountsecret</p>', true);

    // Same URL, authenticated history then an anonymous current body. The live
    // row/vector survives while only the private historical body is removed.
    write(anonymousCurrentUrl, 'private news', '<p>private news</p>', true);
    write(anonymousCurrentUrl, 'public news', '<p>public news</p>');
    write(publicUrl, 'always public', '<p>always public</p>');

    const vectors = new SqliteVecStore(getDatabase());
    await vectors.upsert([
      { id: privateCurrentUrl, vector: vector(1), metadata: { url: privateCurrentUrl, contentHash: '', modelId: 'test' } },
      { id: anonymousCurrentUrl, vector: vector(2), metadata: { url: anonymousCurrentUrl, contentHash: '', modelId: 'test' } },
      { id: publicUrl, vector: vector(3), metadata: { url: publicUrl, contentHash: '', modelId: 'test' } },
    ]);

    const anonymousCacheBefore = getDatabase()
      .prepare('SELECT * FROM url_cache WHERE origin_authenticated = 0 ORDER BY normalized_url')
      .all();
    const anonymousVersionsBefore = getDatabase()
      .prepare('SELECT * FROM url_versions WHERE origin_authenticated = 0 ORDER BY normalized_url, id')
      .all();

    // Per-body, not per-URL: the authenticated current body counts in both
    // stores, while the authenticated history under an anonymous current row
    // contributes only one version.
    expect(getAuthenticatedCorpusStats()).toEqual({
      currentRows: 1,
      versionRows: 2,
      bodyBytes:
        Buffer.byteLength('authenticatedaccountsecret', 'utf8') * 2
        + Buffer.byteLength('<p>authenticatedaccountsecret</p>', 'utf8')
        + Buffer.byteLength('private news', 'utf8'),
      oldestFetchedAt: expect.any(String),
      newestFetchedAt: expect.any(String),
    });

    const expected: AuthenticatedCorpusPurgeResult = {
      currentRows: 1,
      versionRows: 2,
      vectorRows: 1,
    };
    expect(purgeAuthenticatedCorpus({ includeLiveRows: true })).toEqual(expected);

    expect(count('url_cache')).toBe(2);
    expect(count('url_cache', true)).toBe(0);
    expect(count('url_versions', true)).toBe(0);
    expect(count('url_versions', false)).toBe(3);
    expect(
      getDatabase().prepare('SELECT * FROM url_cache WHERE origin_authenticated = 0 ORDER BY normalized_url').all(),
    ).toEqual(anonymousCacheBefore);
    expect(
      getDatabase().prepare('SELECT * FROM url_versions WHERE origin_authenticated = 0 ORDER BY normalized_url, id').all(),
    ).toEqual(anonymousVersionsBefore);

    const anonymousBodies = getDatabase()
      .prepare('SELECT markdown FROM url_versions ORDER BY markdown')
      .all() as Array<{ markdown: string }>;
    expect(anonymousBodies.map((row) => row.markdown)).toEqual([
      'always public',
      'anonymous account shell',
      'public news',
    ]);

    const liveBodies = getDatabase()
      .prepare('SELECT markdown FROM url_cache ORDER BY markdown')
      .all() as Array<{ markdown: string }>;
    expect(liveBodies.map((row) => row.markdown)).toEqual(['always public', 'public news']);

    const vectorIds = getDatabase()
      .prepare('SELECT external_id FROM vec_id_map ORDER BY external_id')
      .all() as Array<{ external_id: string }>;
    expect(vectorIds.map((row) => row.external_id)).toEqual([anonymousCurrentUrl, publicUrl]);

    const privateFtsRows = getDatabase()
      .prepare("SELECT COUNT(*) AS n FROM url_cache_fts WHERE url_cache_fts MATCH 'authenticatedaccountsecret'")
      .get() as { n: number };
    expect(privateFtsRows.n).toBe(0);
    expect(purgeAuthenticatedCorpus({ includeLiveRows: true })).toEqual({
      currentRows: 0,
      versionRows: 0,
      vectorRows: 0,
    });
  });

  it('rolls back live rows and vector eviction when any purge step fails', async () => {
    const url = 'https://private.example/account';
    const token = 'rollbackaccountsecret';
    write(url, token, `<p>${token}</p>`, true);
    const vectors = new SqliteVecStore(getDatabase());
    await vectors.upsert([
      { id: url, vector: vector(1), metadata: { url, contentHash: '', modelId: 'test' } },
    ]);
    expect(await vectors.search(vector(1), 1)).toEqual([
      expect.objectContaining({ id: url }),
    ]);
    getDatabase().exec(`
      CREATE TRIGGER force_authenticated_purge_failure
      BEFORE DELETE ON url_versions
      WHEN old.origin_authenticated = 1
      BEGIN
        SELECT RAISE(ABORT, 'forced purge failure');
      END;
    `);

    expect(() => purgeAuthenticatedCorpus({ includeLiveRows: true })).toThrow(/forced purge failure/);
    expect(count('url_cache', true)).toBe(1);
    expect(count('url_versions', true)).toBe(1);
    expect(count('vec_id_map')).toBe(1);
    expect(await vectors.search(vector(1), 1)).toEqual([
      expect.objectContaining({ id: url }),
    ]);
    const ftsRows = getDatabase()
      .prepare(`SELECT COUNT(*) AS n FROM url_cache_fts WHERE url_cache_fts MATCH ?`)
      .get(token) as { n: number };
    expect(ftsRows.n).toBe(1);
  });
});
