import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { initDatabase, closeDatabase, getDatabase } from '../../../src/cache/db.js';
import { applyMigrations, _resetMigrationGuard } from '../../../src/cache/migrations/runner.js';
import {
  getDomainClearance,
  recordDomainClearance,
  clearDomainClearance,
  recordBackoff,
  getBackoff,
} from '../../../src/cache/store.js';

const NEW_COLS = [
  'cf_clearance',
  'clearance_ua',
  'clearance_tier',
  'clearance_expires_at',
  'backoff_until',
  'last_403_at',
];

describe('migration 008 — anti-bot clearance columns', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    _resetMigrationGuard();
    dir = mkdtempSync(join(tmpdir(), 'wigolo-antibot-'));
    dbPath = join(dir, 'cache.db');
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('adds the six clearance columns to domain_routing on a fresh DB', () => {
    const db = new Database(dbPath);
    applyMigrations(db, { vecLoaded: false });

    const cols = (db.prepare("PRAGMA table_info('domain_routing')").all() as Array<{ name: string }>)
      .map((c) => c.name);
    for (const col of NEW_COLS) expect(cols).toContain(col);

    const applied = (db.prepare('SELECT name FROM schema_migrations').all() as Array<{ name: string }>)
      .map((r) => r.name);
    expect(applied).toContain('008-antibot-clearance');
    db.close();
  });

  it('is idempotent — running twice does not error or duplicate columns', () => {
    const db = new Database(dbPath);
    applyMigrations(db, { vecLoaded: false });
    _resetMigrationGuard();
    expect(() => applyMigrations(db, { vecLoaded: false })).not.toThrow();

    const cols = (db.prepare("PRAGMA table_info('domain_routing')").all() as Array<{ name: string }>)
      .map((c) => c.name);
    for (const col of NEW_COLS) {
      // Each new column appears exactly once (no duplicate ALTER on re-run).
      expect(cols.filter((c) => c === col)).toHaveLength(1);
    }
    const rows = (db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }).n;
    const rows2 = (() => {
      _resetMigrationGuard();
      applyMigrations(db, { vecLoaded: false });
      return (db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }).n;
    })();
    expect(rows2).toBe(rows);
    db.close();
  });

  it('is idempotent against a domain_routing that already has the columns', () => {
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE domain_routing (
        domain TEXT PRIMARY KEY,
        prefer_playwright INTEGER DEFAULT 0,
        http_failures INTEGER DEFAULT 0,
        last_updated TEXT,
        prefer_tls_impersonation INTEGER DEFAULT 0,
        tls_success_count INTEGER DEFAULT 0,
        cf_clearance TEXT,
        clearance_ua TEXT,
        clearance_tier TEXT,
        clearance_expires_at TEXT,
        backoff_until TEXT,
        last_403_at TEXT
      );
    `);
    expect(() => applyMigrations(db, { vecLoaded: false })).not.toThrow();
    db.close();
  });
});

describe('migration 010 — clearance route-identity column', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    _resetMigrationGuard();
    dir = mkdtempSync(join(tmpdir(), 'wigolo-route-'));
    dbPath = join(dir, 'cache.db');
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('adds the solved_route column to domain_routing on a fresh DB', () => {
    const db = new Database(dbPath);
    applyMigrations(db, { vecLoaded: false });

    const cols = (db.prepare("PRAGMA table_info('domain_routing')").all() as Array<{ name: string }>)
      .map((c) => c.name);
    expect(cols).toContain('solved_route');

    const applied = (db.prepare('SELECT name FROM schema_migrations').all() as Array<{ name: string }>)
      .map((r) => r.name);
    expect(applied).toContain('010-clearance-route');
    db.close();
  });

  it('is idempotent — running twice does not error or duplicate the column', () => {
    const db = new Database(dbPath);
    applyMigrations(db, { vecLoaded: false });
    _resetMigrationGuard();
    expect(() => applyMigrations(db, { vecLoaded: false })).not.toThrow();

    const cols = (db.prepare("PRAGMA table_info('domain_routing')").all() as Array<{ name: string }>)
      .map((c) => c.name);
    expect(cols.filter((c) => c === 'solved_route')).toHaveLength(1);
    db.close();
  });

  it('is idempotent against a domain_routing that already has solved_route', () => {
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE domain_routing (
        domain TEXT PRIMARY KEY,
        prefer_playwright INTEGER DEFAULT 0,
        http_failures INTEGER DEFAULT 0,
        last_updated TEXT,
        cf_clearance TEXT,
        clearance_ua TEXT,
        clearance_tier TEXT,
        clearance_expires_at TEXT,
        solved_route TEXT
      );
    `);
    expect(() => applyMigrations(db, { vecLoaded: false })).not.toThrow();
    db.close();
  });

  it('a legacy row with a NULL solved_route reads back as direct via the store', () => {
    const db = new Database(dbPath);
    applyMigrations(db, { vecLoaded: false });
    // A pre-010 clearance row (route left NULL by the migration ALTER default).
    db.prepare(
      `INSERT INTO domain_routing (domain, prefer_playwright, http_failures, cf_clearance, clearance_ua, clearance_tier, clearance_expires_at)
       VALUES ('legacy.test', 0, 0, 'cf_clearance=old', 'ua', 'browser', '2026-08-01T00:00:00.000Z')`,
    ).run();
    const row = db.prepare(
      "SELECT solved_route FROM domain_routing WHERE domain = 'legacy.test'",
    ).get() as { solved_route: string | null };
    expect(row.solved_route).toBeNull();
    db.close();
  });
});

describe('store — domain clearance + backoff round-trips', () => {
  beforeEach(() => { initDatabase(':memory:'); });
  afterEach(() => { closeDatabase(); });

  it('recordDomainClearance → getDomainClearance round-trips cookie/ua/tier/expiresAt', () => {
    recordDomainClearance('protected.test', {
      cookie: 'cf_clearance=abc123',
      ua: 'Mozilla/5.0 (test)',
      tier: 'tls',
      expiresAt: '2026-08-01T00:00:00.000Z',
    });
    const got = getDomainClearance('protected.test');
    expect(got).not.toBeNull();
    expect(got!.cookie).toBe('cf_clearance=abc123');
    expect(got!.ua).toBe('Mozilla/5.0 (test)');
    expect(got!.tier).toBe('tls');
    expect(got!.expiresAt).toBe('2026-08-01T00:00:00.000Z');
  });

  it('round-trips the solved egress route (solvedRoute) when recorded', () => {
    recordDomainClearance('routed.test', {
      cookie: 'cf_clearance=r',
      ua: 'ua',
      tier: 'browser',
      expiresAt: '2026-08-01T00:00:00.000Z',
      solvedRoute: 'http://proxy:8080',
    });
    expect(getDomainClearance('routed.test')!.solvedRoute).toBe('http://proxy:8080');
  });

  it('a clearance recorded without a route reads back as direct (legacy surrogate)', () => {
    recordDomainClearance('noroute.test', {
      cookie: 'cf_clearance=n',
      ua: 'ua',
      tier: 'browser',
      expiresAt: '2026-08-01T00:00:00.000Z',
    });
    expect(getDomainClearance('noroute.test')!.solvedRoute).toBe('direct');
  });

  it('getDomainClearance returns null for an unknown host', () => {
    expect(getDomainClearance('never-seen.test')).toBeNull();
  });

  it('keys on the RAW hostname (does not collapse sub-domains to eTLD+1)', () => {
    recordDomainClearance('a.example.co.uk', { cookie: 'c1', ua: 'ua1', tier: 'http', expiresAt: 'e1' });
    recordDomainClearance('b.example.co.uk', { cookie: 'c2', ua: 'ua2', tier: 'http', expiresAt: 'e2' });
    expect(getDomainClearance('a.example.co.uk')!.cookie).toBe('c1');
    expect(getDomainClearance('b.example.co.uk')!.cookie).toBe('c2');
  });

  it('reads back an expired clearance (caller decides freshness, store does not filter)', () => {
    recordDomainClearance('stale.test', {
      cookie: 'old', ua: 'ua', tier: 'browser',
      expiresAt: '2000-01-01T00:00:00.000Z',
    });
    const got = getDomainClearance('stale.test');
    expect(got).not.toBeNull();
    expect(got!.expiresAt).toBe('2000-01-01T00:00:00.000Z');
  });

  it('clearDomainClearance wipes the clearance fields', () => {
    recordDomainClearance('drop.test', { cookie: 'c', ua: 'u', tier: 'tls', expiresAt: 'e' });
    clearDomainClearance('drop.test');
    expect(getDomainClearance('drop.test')).toBeNull();
  });

  it('recordBackoff → getBackoff round-trips the until timestamp', () => {
    const until = Date.now() + 60_000;
    recordBackoff('rate-limited.test', until);
    expect(getBackoff('rate-limited.test')).toBe(until);
  });

  it('getBackoff returns null when no backoff is recorded', () => {
    expect(getBackoff('fresh.test')).toBeNull();
  });
});

describe('db hardening — 0600 file mode', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wigolo-dbmode-'));
  });

  afterEach(() => {
    closeDatabase();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // POSIX mode bits only — Windows has no 0o600 concept (files report 0o666),
  // and the runtime chmod is a correct no-op there.
  it.skipIf(process.platform === 'win32')('chmods the DB file to 0600 on init (cf_clearance is a session-bearing token)', () => {
    const dbPath = join(dir, 'cache.db');
    initDatabase(dbPath);
    const mode = statSync(dbPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('chmods the -wal sidecar to 0600 after a write', () => {
    const dbPath = join(dir, 'cache.db');
    initDatabase(dbPath);
    const db = getDatabase();
    // Force a WAL write so the -wal sidecar materialises.
    db.exec("INSERT INTO domain_routing (domain, prefer_playwright, http_failures) VALUES ('walcheck.test', 0, 0)");
    recordBackoff('walcheck.test', Date.now() + 1000);

    // POSIX-only assertion: Windows reports 0o666 and the chmod is a no-op there.
    if (process.platform !== 'win32') {
      const walMode = statSync(`${dbPath}-wal`).mode & 0o777;
      expect(walMode).toBe(0o600);
    }
  });
});
