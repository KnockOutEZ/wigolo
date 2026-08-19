import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initDatabase, closeDatabase, getDatabase } from '../../../src/cache/db.js';
import { cacheContent, clearCacheEntries, normalizeUrl } from '../../../src/cache/store.js';
import { applyMigrations } from '../../../src/cache/migrations/runner.js';
import { resetConfig } from '../../../src/config.js';
import type { RawFetchResult, ExtractionResult } from '../../../src/types.js';

/**
 * S14-1 — the corpus version store (`url_versions`).
 *
 * These encode WHY the time axis exists: today `url_cache` is INSERT OR REPLACE,
 * so every re-fetch destroys the body it replaces and no past state of any page
 * is recoverable by any path. `url_versions` is the append-on-change side table
 * that keeps the older bodies WITHOUT changing `url_cache`'s one-row-per-URL hot
 * path contract (D-S14-1).
 *
 * Retention is tested by FORCING growth, never by observing that a bound did not
 * happen to bind — N clean runs prove nothing about a bound. The program has
 * twice paid a 45 GB disk bill for an unbounded writer, so the bounds are gates
 * (G-S14-1b), not implementation detail.
 */

const URL = 'https://example.com/versioned';
const NORMALIZED = normalizeUrl(URL);

const ENV_KEYS = [
  'WIGOLO_CORPUS_MAX_VERSIONS_PER_URL',
  'WIGOLO_CORPUS_MAX_VERSION_BYTES',
  'WIGOLO_CORPUS_VERSION_MAX_AGE_DAYS',
];

function makeRaw(url: string): RawFetchResult {
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

function makeExtraction(markdown: string, overrides: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    title: 'Versioned Page',
    markdown,
    metadata: {},
    links: [],
    images: [],
    extractor: 'defuddle',
    ...overrides,
  };
}

function write(markdown: string, url = URL): void {
  cacheContent(makeRaw(url), makeExtraction(markdown));
}

function versionsFor(url = NORMALIZED): Array<{
  id: number;
  markdown: string;
  content_hash: string;
  byte_len: number;
  fetched_at: string;
  title: string | null;
  http_status: number | null;
  origin_authenticated: number;
}> {
  return getDatabase()
    .prepare('SELECT * FROM url_versions WHERE normalized_url = ? ORDER BY id ASC')
    .all(url) as never;
}

function totalBytes(): number {
  const row = getDatabase()
    .prepare('SELECT COALESCE(SUM(byte_len), 0) AS total FROM url_versions')
    .get() as { total: number };
  return row.total;
}

function setBounds(bounds: { versions?: number; bytes?: number; ageDays?: number }): void {
  if (bounds.versions !== undefined) {
    process.env.WIGOLO_CORPUS_MAX_VERSIONS_PER_URL = String(bounds.versions);
  }
  if (bounds.bytes !== undefined) {
    process.env.WIGOLO_CORPUS_MAX_VERSION_BYTES = String(bounds.bytes);
  }
  if (bounds.ageDays !== undefined) {
    process.env.WIGOLO_CORPUS_VERSION_MAX_AGE_DAYS = String(bounds.ageDays);
  }
  resetConfig();
}

describe('url_versions — migration 013', () => {
  afterEach(() => {
    closeDatabase();
  });

  it('creates the table on a fresh database', () => {
    initDatabase(':memory:');
    const cols = getDatabase().pragma('table_info(url_versions)') as Array<{ name: string; notnull: number }>;
    const names = cols.map(c => c.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'id',
        'normalized_url',
        'content_hash',
        'markdown',
        'title',
        'http_status',
        'fetched_at',
        'byte_len',
        'origin_authenticated',
      ]),
    );
  });

  it('runs forward on a database that already has every earlier migration applied', () => {
    // The real upgrade path: an install that ran 001..012, then receives 013.
    // A bare Database (no initDatabase) is the runner-only harness the other
    // migration tests use, so this also proves 013 does not depend on url_cache.
    const db = new Database(':memory:');
    applyMigrations(db, { vecLoaded: false });
    db.prepare('DELETE FROM schema_migrations WHERE name = ?').run('013-url-versions');
    db.exec('DROP TABLE IF EXISTS url_versions');

    applyMigrations(db, { vecLoaded: false });

    const cols = db.pragma('table_info(url_versions)') as Array<{ name: string }>;
    expect(cols.length).toBeGreaterThan(0);
    db.close();
  });

  it('is idempotent — a second pass over an already-migrated database is a no-op', () => {
    const db = new Database(':memory:');
    applyMigrations(db, { vecLoaded: false });
    expect(() => applyMigrations(db, { vecLoaded: false })).not.toThrow();
    db.close();
  });

  it('rejects a duplicate (normalized_url, content_hash) pair', () => {
    initDatabase(':memory:');
    const db = getDatabase();
    const insert = db.prepare(`
      INSERT INTO url_versions (normalized_url, content_hash, markdown, title, http_status, fetched_at, byte_len)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run(NORMALIZED, 'hash-a', 'body', 'T', 200, '2026-08-18 00:00:00', 4);
    expect(() => insert.run(NORMALIZED, 'hash-a', 'body', 'T', 200, '2026-08-18 00:00:01', 4)).toThrow(
      /UNIQUE constraint failed/,
    );
    db.close();
  });
});

describe('url_versions — append on change (G-S14-1a)', () => {
  beforeEach(() => {
    initDatabase(':memory:');
    resetConfig();
  });

  afterEach(() => {
    closeDatabase();
    for (const key of ENV_KEYS) delete process.env[key];
    resetConfig();
  });

  it('retains the ORIGINAL body byte-identically after the content mutates, and leaves url_cache at one row', () => {
    // All three clauses of G-S14-1a. The third is what proves S14-1 did not
    // change the hot path's contract: a history table that quietly turned
    // url_cache into an append log would break every current-page reader.
    const original = '# Original\n\nThe body as it stood at t1. é—trailing space \n';
    write(original);
    write('# Mutated\n\nCompletely different body at t2.');

    const rows = versionsFor();
    expect(rows).toHaveLength(2);
    expect(rows[0].markdown).toBe(original);

    const cacheRows = getDatabase()
      .prepare('SELECT COUNT(*) AS n FROM url_cache WHERE normalized_url = ?')
      .get(NORMALIZED) as { n: number };
    expect(cacheRows.n).toBe(1);
  });

  it('does NOT append when an unchanged page is re-fetched', () => {
    // A page fetched 200 times unchanged must cost ONE row. The dedup key makes
    // that structural rather than a caller's discipline (D-S14-1).
    const body = '# Stable\n\nUnchanged across every fetch.';
    for (let i = 0; i < 5; i++) write(body);
    expect(versionsFor()).toHaveLength(1);
  });

  it('records the first fetch of a URL as version 1', () => {
    write('# First');
    const rows = versionsFor();
    expect(rows).toHaveLength(1);
    expect(rows[0].markdown).toBe('# First');
  });

  it('records byte_len as the UTF-8 byte length of the markdown, not its character count', () => {
    // byte_len drives the disk bound. Counting characters would under-count
    // multi-byte content and let the byte bound overshoot on non-ASCII pages.
    const body = 'ééé';
    write(body);
    const rows = versionsFor();
    expect(rows[0].byte_len).toBe(Buffer.byteLength(body, 'utf8'));
    expect(rows[0].byte_len).not.toBe(body.length);
  });

  it('carries title and http_status onto the version row', () => {
    write('# With metadata');
    const rows = versionsFor();
    expect(rows[0].title).toBe('Versioned Page');
    expect(rows[0].http_status).toBe(200);
  });

  it('defaults origin_authenticated to 0 — no caller marks it in S14-1', () => {
    write('# Anonymous');
    expect(versionsFor()[0].origin_authenticated).toBe(0);
  });

  it('keeps per-URL histories separate', () => {
    write('# A1', 'https://a.example.com/p');
    write('# A2', 'https://a.example.com/p');
    write('# B1', 'https://b.example.com/p');
    expect(versionsFor(normalizeUrl('https://a.example.com/p'))).toHaveLength(2);
    expect(versionsFor(normalizeUrl('https://b.example.com/p'))).toHaveLength(1);
  });
});

describe('url_versions — retention under forced growth (G-S14-1b)', () => {
  beforeEach(() => {
    initDatabase(':memory:');
    resetConfig();
  });

  afterEach(() => {
    closeDatabase();
    for (const key of ENV_KEYS) delete process.env[key];
    resetConfig();
  });

  it('holds exactly the 3 most recent of 50 distinct versions when the per-URL count bound is 3', () => {
    setBounds({ versions: 3 });
    for (let i = 0; i < 50; i++) write(`# Version ${i}`);

    const rows = versionsFor();
    expect(rows).toHaveLength(3);
    expect(rows.map(r => r.markdown)).toEqual(['# Version 47', '# Version 48', '# Version 49']);
  });

  it('holds total byte_len at or under the byte bound after EVERY write, not only at the end', () => {
    // "After every write" is the clause that matters: a bound checked once at
    // the end can be satisfied by a sweep that let the table balloon in between.
    setBounds({ bytes: 10 * 1024, versions: 1000 });
    const chunk = 'x'.repeat(2048);
    let written = 0;
    for (let i = 0; i < 512; i++) {
      write(`${i}:${chunk}`);
      written += 2048;
      expect(totalBytes()).toBeLessThanOrEqual(10 * 1024);
    }
    expect(written).toBeGreaterThanOrEqual(1024 * 1024);
    expect(versionsFor().length).toBeGreaterThan(0);
  });

  it('retains NOTHING rather than overshooting when a single version alone exceeds the byte bound', () => {
    setBounds({ bytes: 1024, versions: 1000 });
    write('y'.repeat(4096));
    expect(totalBytes()).toBeLessThanOrEqual(1024);
    expect(versionsFor()).toHaveLength(0);
  });

  it('evicts versions older than the age bound', () => {
    setBounds({ ageDays: 30 });
    const db = getDatabase();
    db.prepare(`
      INSERT INTO url_versions (normalized_url, content_hash, markdown, title, http_status, fetched_at, byte_len)
      VALUES (?, ?, ?, ?, ?, datetime('now', '-90 days'), ?)
    `).run(NORMALIZED, 'ancient', '# Ancient', 'T', 200, 9);

    write('# Fresh');

    const rows = versionsFor();
    expect(rows.map(r => r.content_hash)).not.toContain('ancient');
    expect(rows.map(r => r.markdown)).toEqual(['# Fresh']);
  });

  it('applies the age bound across URLs, not only the one being written', () => {
    setBounds({ ageDays: 30 });
    const db = getDatabase();
    db.prepare(`
      INSERT INTO url_versions (normalized_url, content_hash, markdown, title, http_status, fetched_at, byte_len)
      VALUES (?, ?, ?, ?, ?, datetime('now', '-90 days'), ?)
    `).run(normalizeUrl('https://other.example.com/p'), 'ancient-other', '# Old', 'T', 200, 6);

    write('# Fresh');

    const remaining = db.prepare('SELECT COUNT(*) AS n FROM url_versions WHERE content_hash = ?').get('ancient-other') as { n: number };
    expect(remaining.n).toBe(0);
  });

  it('binds on whichever of the three bounds binds first, in combination', () => {
    // Count bound 5, byte bound 3 KB, versions of 2 KB each -> the BYTE bound
    // wins and only 1 survives, even though the count bound would allow 5.
    setBounds({ versions: 5, bytes: 3 * 1024, ageDays: 180 });
    for (let i = 0; i < 10; i++) write(`${i}:${'z'.repeat(2048)}`);
    const rows = versionsFor();
    expect(rows.length).toBeLessThanOrEqual(1);
    expect(totalBytes()).toBeLessThanOrEqual(3 * 1024);
  });

  it('applies the per-URL count bound per URL, not across the whole table', () => {
    setBounds({ versions: 2 });
    for (let i = 0; i < 5; i++) write(`# A${i}`, 'https://a.example.com/p');
    for (let i = 0; i < 5; i++) write(`# B${i}`, 'https://b.example.com/p');
    expect(versionsFor(normalizeUrl('https://a.example.com/p'))).toHaveLength(2);
    expect(versionsFor(normalizeUrl('https://b.example.com/p'))).toHaveLength(2);
  });
});

describe('url_versions — disabling is not purging', () => {
  beforeEach(() => {
    initDatabase(':memory:');
    resetConfig();
  });

  afterEach(() => {
    closeDatabase();
    for (const key of ENV_KEYS) delete process.env[key];
    resetConfig();
  });

  it('stops appending but deletes nothing when the count bound is 0', () => {
    write('# Kept 1');
    write('# Kept 2');
    expect(versionsFor()).toHaveLength(2);

    setBounds({ versions: 0 });
    write('# Would be 3');

    const rows = versionsFor();
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.markdown)).toEqual(['# Kept 1', '# Kept 2']);
  });

  it('stops appending but deletes nothing when the byte bound is 0', () => {
    write('# Kept 1');
    setBounds({ bytes: 0 });
    write('# Would be 2');
    expect(versionsFor()).toHaveLength(1);
  });

  it('stops appending but deletes nothing when the age bound is 0', () => {
    write('# Kept 1');
    setBounds({ ageDays: 0 });
    write('# Would be 2');
    expect(versionsFor()).toHaveLength(1);
  });

  it('still writes url_cache normally while the time axis is disabled', () => {
    setBounds({ versions: 0 });
    write('# Live body');
    const row = getDatabase()
      .prepare('SELECT markdown FROM url_cache WHERE normalized_url = ?')
      .get(NORMALIZED) as { markdown: string };
    expect(row.markdown).toBe('# Live body');
  });
});

describe('url_versions — user-initiated clear removes history too', () => {
  beforeEach(() => {
    initDatabase(':memory:');
    resetConfig();
  });

  afterEach(() => {
    closeDatabase();
    for (const key of ENV_KEYS) delete process.env[key];
    resetConfig();
  });

  it('drops a cleared URL\'s versions — "delete this from my machine" must reach the history', () => {
    write('# V1');
    write('# V2');
    expect(versionsFor()).toHaveLength(2);

    clearCacheEntries({ urlPattern: 'https://example.com/*' });

    expect(versionsFor()).toHaveLength(0);
  });

  it('leaves other URLs\' versions untouched when clearing one URL', () => {
    write('# A1', 'https://a.example.com/p');
    write('# B1', 'https://b.example.com/p');

    clearCacheEntries({ urlPattern: 'https://a.example.com/*' });

    expect(versionsFor(normalizeUrl('https://a.example.com/p'))).toHaveLength(0);
    expect(versionsFor(normalizeUrl('https://b.example.com/p'))).toHaveLength(1);
  });
});
