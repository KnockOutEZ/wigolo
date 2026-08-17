import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initDatabase, closeDatabase, getDatabase } from '../../../src/cache/db.js';
import { cacheContent, clearCacheEntries } from '../../../src/cache/store.js';
import { SqliteVecStore, deleteVectorsByExternalId } from '../../../src/cache/sqlite-vec-store.js';
import type { RawFetchResult, ExtractionResult } from '../../../src/types.js';

/**
 * A cached page produces three artifacts: crawl output (transient), the
 * url_cache row (TTL + shell-stale refetch), and an embedding. The embedding is
 * the most durable of the three and had the least protection — nothing in
 * production ever deleted one. Clearing the cache is the operator's remediation
 * lever, so it has to reach the vector too, or the clear is a half-clear that
 * leaves a searchable vector pointing at content that no longer exists.
 */

function raw(url: string): RawFetchResult {
  return {
    url,
    finalUrl: url,
    html: '<html><body>hello</body></html>',
    contentType: 'text/html',
    statusCode: 200,
    method: 'http',
    headers: {},
  };
}

function extraction(markdown: string): ExtractionResult {
  return {
    title: 'Page',
    markdown,
    metadata: {},
    links: [],
    images: [],
    extractor: 'defuddle',
  };
}

/** Store a 384-dim vector under `id` through the production store. */
async function embed(id: string, seed: number): Promise<void> {
  const store = new SqliteVecStore(getDatabase());
  const vector = new Float32Array(384);
  vector[seed % 384] = 1;
  await store.upsert([{ id, vector, metadata: { url: id, contentHash: '', modelId: 'test' } }]);
}

function vecCount(): number {
  return (getDatabase().prepare('SELECT COUNT(*) AS c FROM vec_id_map').get() as { c: number }).c;
}

function urlCount(): number {
  return (getDatabase().prepare('SELECT COUNT(*) AS c FROM url_cache').get() as { c: number }).c;
}

describe('clearCacheEntries evicts the vectors derived from the cleared rows', () => {
  beforeEach(() => {
    initDatabase(':memory:');
  });

  afterEach(() => {
    closeDatabase();
  });

  it('removes the vector for a cleared row', async () => {
    cacheContent(raw('https://walled.example/page'), extraction('challenge interstitial boilerplate'));
    await embed('https://walled.example/page', 1);

    expect(urlCount()).toBe(1);
    expect(vecCount()).toBe(1);

    const removed = clearCacheEntries({ urlPattern: '*walled.example*' });

    expect(removed).toBe(1);
    expect(urlCount()).toBe(0);
    expect(vecCount()).toBe(0);
  });

  it('leaves vectors for rows the filter did not match', async () => {
    // The other direction: an eviction that took everything would pass the test
    // above. A clear must be as narrow as its filter.
    cacheContent(raw('https://walled.example/page'), extraction('challenge interstitial boilerplate'));
    cacheContent(raw('https://good.example/article'), extraction('a real article about vector indexes'));
    await embed('https://walled.example/page', 1);
    await embed('https://good.example/article', 2);
    expect(vecCount()).toBe(2);

    clearCacheEntries({ urlPattern: '*walled.example*' });

    expect(vecCount()).toBe(1);
    const survivor = getDatabase()
      .prepare('SELECT external_id FROM vec_id_map')
      .get() as { external_id: string };
    expect(survivor.external_id).toBe('https://good.example/article');
  });

  it('evicts vectors keyed on the raw url as well as the normalized one', async () => {
    // embedAndStore keys on the normalized url; the crawl index and background
    // queue key on the raw one. Evicting only one form would strand the other.
    const rawUrl = 'https://www.walled.example/page?utm_source=x';
    cacheContent(raw(rawUrl), extraction('challenge interstitial boilerplate'));
    await embed(rawUrl, 1);
    await embed('https://walled.example/page', 2);
    expect(vecCount()).toBe(2);

    clearCacheEntries({});

    expect(vecCount()).toBe(0);
  });

  it('drops the metadata row with the vector, so no orphan can be re-hydrated', async () => {
    cacheContent(raw('https://walled.example/page'), extraction('challenge interstitial boilerplate'));
    await embed('https://walled.example/page', 1);

    clearCacheEntries({});

    const meta = (getDatabase()
      .prepare('SELECT COUNT(*) AS c FROM vec_metadata')
      .get() as { c: number }).c;
    expect(meta).toBe(0);
  });

  it('clears successfully when the vector tables are absent', () => {
    // Migration 001 is skipped on platforms without the native vector
    // extension. A cache clear must not throw there.
    closeDatabase();
    const db = new Database(':memory:');
    db.exec('CREATE TABLE url_cache (id INTEGER PRIMARY KEY, url TEXT, normalized_url TEXT)');
    db.prepare('INSERT INTO url_cache (url, normalized_url) VALUES (?, ?)').run('https://a/', 'https://a/');
    expect(deleteVectorsByExternalId(db, ['https://a/'])).toBe(0);
    db.close();
    initDatabase(':memory:');
  });
});
