import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { readCacheStats } from '../../../../src/cli/tui/status-cache.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'wigolo-status-cache-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('readCacheStats', () => {
  it('returns { pages: 0, bytes: 0 } when the DB file does not exist', () => {
    const result = readCacheStats(tmpDir);
    expect(result.pages).toBe(0);
    expect(result.bytes).toBe(0);
  });

  it('returns page count + file size for a real DB', () => {
    const dbPath = join(tmpDir, 'cache.db');
    const db = new Database(dbPath);
    db.exec('CREATE TABLE url_cache (id INTEGER PRIMARY KEY, url TEXT)');
    db.prepare('INSERT INTO url_cache (url) VALUES (?)').run('https://a.test');
    db.prepare('INSERT INTO url_cache (url) VALUES (?)').run('https://b.test');
    db.prepare('INSERT INTO url_cache (url) VALUES (?)').run('https://c.test');
    db.close();

    const result = readCacheStats(tmpDir);
    expect(result.pages).toBe(3);
    expect(result.bytes).toBeGreaterThan(0);
  });

  it('returns { pages: 0 } when the url_cache table is absent', () => {
    const dbPath = join(tmpDir, 'cache.db');
    const db = new Database(dbPath);
    db.exec('CREATE TABLE something_else (id INTEGER)');
    db.close();

    const result = readCacheStats(tmpDir);
    expect(result.pages).toBe(0);
    expect(result.bytes).toBeGreaterThan(0);
  });

  it('handles an unreadable db file gracefully', () => {
    mkdirSync(join(tmpDir, 'cache.db'));

    const result = readCacheStats(tmpDir);
    expect(result.pages).toBe(0);
    expect(result.bytes).toBe(0);
  });
});
