/**
 * K9 — the authenticated-origin marker, at both layers that were missing it.
 *
 * `url_cache` had no such column at all, and `url_versions.origin_authenticated` shipped with the table
 * and had **no writer** — two layers of one defect, the shape a packaged-app blocker took earlier in this
 * program. Both are closed here.
 *
 * WHY IT COULD NOT BE DEFERRED: the marker **cannot be backfilled.** Nothing on disk records how a row
 * already present was fetched, so every day without the column adds permanently-unlabelled rows. A
 * corpus-informed ranker over cached pages is the first feature that makes the distinction matter, which
 * is why this lands before that slice rather than after it.
 *
 * THE PROPERTY THAT MATTERS MOST, and the one a per-URL reading would get wrong: **the marker describes
 * the BODY, not the URL.**
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyMigrations, _resetMigrationGuard } from '../../../src/cache/migrations/runner.js';
import { initDatabase, closeDatabase, getDatabase } from '../../../src/cache/db.js';
import { cacheContent } from '../../../src/cache/store.js';
import { resetConfig } from '../../../src/config.js';
import type { RawFetchResult, ExtractionResult } from '../../../src/types.js';

let dir: string;
const ORIG_ENV = process.env;

function raw(over: Partial<RawFetchResult> = {}): RawFetchResult {
  return {
    url: 'https://app.example.com/orders',
    finalUrl: 'https://app.example.com/orders',
    html: '<html><body><main>Orders</main></body></html>',
    contentType: 'text/html',
    statusCode: 200,
    method: 'browser',
    headers: {},
    ...over,
  } as RawFetchResult;
}

function extraction(markdown = 'Orders'): ExtractionResult {
  return {
    markdown,
    title: 'Orders',
    metadata: {},
    links: [],
    images: [],
    extractor: 'readability',
  } as ExtractionResult;
}

function cacheRow(): { origin_authenticated: number; markdown: string } {
  return getDatabase()
    .prepare('SELECT origin_authenticated, markdown FROM url_cache WHERE url = ?')
    .get('https://app.example.com/orders') as { origin_authenticated: number; markdown: string };
}

function versionRows(): Array<{ origin_authenticated: number; markdown: string }> {
  return getDatabase()
    .prepare('SELECT origin_authenticated, markdown FROM url_versions ORDER BY id ASC')
    .all() as Array<{ origin_authenticated: number; markdown: string }>;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wg-authmark-'));
  process.env = { ...ORIG_ENV, LOG_LEVEL: 'error', WIGOLO_DATA_DIR: dir };
  resetConfig();
  initDatabase(join(dir, 'wigolo.db'));
});

afterEach(() => {
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
  process.env = ORIG_ENV;
  resetConfig();
});

describe('migration 015 — the column arrives on an existing url_cache', () => {
  it('adds origin_authenticated to a url_cache that predates it', () => {
    _resetMigrationGuard();
    const db = new Database(':memory:');
    // The pre-015 shape: url_cache exists, without the marker.
    db.exec(`CREATE TABLE url_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT UNIQUE NOT NULL,
      normalized_url TEXT NOT NULL, fetched_at TEXT NOT NULL
    );`);
    applyMigrations(db, { vecLoaded: false });
    const cols = (db.prepare("PRAGMA table_info('url_cache')").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('origin_authenticated');
    const applied = (db.prepare('SELECT name FROM schema_migrations').all() as Array<{ name: string }>).map((r) => r.name);
    expect(applied).toContain('015-url-cache-origin-authenticated');
    db.close();
  });

  it('is idempotent against a url_cache that already carries the column', () => {
    _resetMigrationGuard();
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE url_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT UNIQUE NOT NULL,
      normalized_url TEXT NOT NULL, fetched_at TEXT NOT NULL,
      origin_authenticated INTEGER NOT NULL DEFAULT 0
    );`);
    expect(() => applyMigrations(db, { vecLoaded: false })).not.toThrow();
    db.close();
  });

  it('is a no-op on a bare runner DB with no url_cache at all', () => {
    // The runner-only harness never creates url_cache. A postStep that ALTERed unconditionally would
    // abort the whole pass on that harness.
    _resetMigrationGuard();
    const db = new Database(':memory:');
    expect(() => applyMigrations(db, { vecLoaded: false })).not.toThrow();
    const applied = (db.prepare('SELECT name FROM schema_migrations').all() as Array<{ name: string }>).map((r) => r.name);
    expect(applied).toContain('015-url-cache-origin-authenticated');
    db.close();
  });

  it('defaults existing rows to 0, which is a claim about KNOWLEDGE not about the fetch', () => {
    // Nothing on disk records how an already-present row was fetched, so 0 here means "not known to be
    // authenticated". That is exactly why the marker cannot be backfilled, and why it had to ship before
    // a ranker that would read it as fact.
    _resetMigrationGuard();
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE url_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT UNIQUE NOT NULL,
      normalized_url TEXT NOT NULL, fetched_at TEXT NOT NULL
    );`);
    db.prepare('INSERT INTO url_cache (url, normalized_url, fetched_at) VALUES (?, ?, ?)')
      .run('https://old.example.com/x', 'https://old.example.com/x', '2026-01-01 00:00:00');
    applyMigrations(db, { vecLoaded: false });
    const row = db.prepare('SELECT origin_authenticated FROM url_cache').get() as { origin_authenticated: number };
    expect(row.origin_authenticated).toBe(0);
    db.close();
  });
});

describe('cacheContent — the marker follows what the fetch APPLIED', () => {
  it('marks 1 when authenticated session material was applied', () => {
    cacheContent(raw({ authApplied: true }), extraction());
    expect(cacheRow().origin_authenticated).toBe(1);
  });

  it('marks 0 for an ordinary anonymous fetch', () => {
    cacheContent(raw(), extraction());
    expect(cacheRow().origin_authenticated).toBe(0);
  });

  it('marks 0 when auth was REQUESTED but no session was applied', () => {
    // The distinction the marker exists for. `use_auth: true` with nothing stored yields an empty option
    // set and an anonymous fetch; the router reports `authApplied` only when material was actually
    // applied, so a request alone cannot produce a label.
    cacheContent(raw({ authApplied: undefined }), extraction());
    expect(cacheRow().origin_authenticated).toBe(0);
  });

  it('cannot mark on the REQUEST, structurally — it is never handed one', () => {
    // A behavioural test alone would pass against a version that read a request flag it happened not to
    // be given. This pins the reason it cannot: the function's inputs contain no such flag.
    const src = readFileSync('src/cache/store.ts', 'utf-8');
    // Bounded by the NEXT export rather than a character count: the first version of this test used a
    // 3000-char window and stopped short of the line it was asserting, so it failed while the code was
    // correct. A magic slice length is a fixture that rots the moment the function grows.
    const start = src.indexOf('export function cacheContent');
    const next = src.indexOf('\nexport ', start + 1);
    const fn = src.slice(start, next === -1 ? undefined : next);
    expect(fn).toMatch(/result\.authApplied/);
    expect(fn).not.toMatch(/use_auth|useAuth/);
  });
});

describe('the marker belongs to the BODY, not the URL', () => {
  it('reads 0 on the current row after an authenticated page is re-fetched anonymously', () => {
    // `INSERT OR REPLACE` means the row describes the body it now holds. Reporting 1 here would claim the
    // stored body is authenticated when it is the public one.
    cacheContent(raw({ authApplied: true }), extraction('private orders'));
    expect(cacheRow().origin_authenticated).toBe(1);
    cacheContent(raw(), extraction('public teaser'));
    const row = cacheRow();
    expect(row.markdown).toBe('public teaser');
    expect(row.origin_authenticated).toBe(0);
  });

  it('KEEPS the authenticated body marked in the version history after that re-fetch', () => {
    // The half a per-URL marker would lose. The authenticated body is still retained, so it must still be
    // labelled — otherwise a later corpus pass reads a private body as public.
    cacheContent(raw({ authApplied: true }), extraction('private orders'));
    cacheContent(raw(), extraction('public teaser'));
    const versions = versionRows();
    expect(versions).toHaveLength(2);
    const priv = versions.find((v) => v.markdown === 'private orders');
    const pub = versions.find((v) => v.markdown === 'public teaser');
    expect(priv?.origin_authenticated).toBe(1);
    expect(pub?.origin_authenticated).toBe(0);
  });

  it('gives the version row the SAME value as the cache row, from one derivation', () => {
    // Deriving it twice is how the two would come to disagree.
    cacheContent(raw({ authApplied: true }), extraction('one body'));
    expect(cacheRow().origin_authenticated).toBe(1);
    expect(versionRows()[0]?.origin_authenticated).toBe(1);
  });
});
