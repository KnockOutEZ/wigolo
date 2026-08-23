import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, chmodSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { applyMigrations, MIGRATIONS, _resetMigrationGuard } from '../../../src/cache/migrations/runner.js';
import { openMigrationTestDb } from '../../helpers/migration-test-db.js';

describe('applyMigrations', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    _resetMigrationGuard();
    dir = mkdtempSync(join(tmpdir(), 'wigolo-mig-'));
    dbPath = join(dir, 'cache.db');
  });

  afterEach(() => {
    try { chmodSync(dir, 0o700); } catch { /* ignore */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('applies all non-vec migrations on a writable empty DB', () => {
    const db = openMigrationTestDb(dbPath);
    applyMigrations(db, { vecLoaded: false });

    const applied = (db.prepare('SELECT name FROM schema_migrations ORDER BY name').all() as Array<{ name: string }>)
      .map(r => r.name);

    expect(applied).toContain('002-feed-items');
    expect(applied).toContain('003-crawl-etags');
    expect(applied).toContain('004-watch-jobs');
    expect(applied).toContain('005-tls-routing');
    expect(applied).not.toContain('001-sqlite-vec'); // requiresVec, skipped

    // domain_routing now carries the TLS-impersonation columns.
    const drCols = db.prepare("PRAGMA table_info('domain_routing')").all() as Array<{ name: string }>;
    const drNames = drCols.map((c) => c.name).sort();
    expect(drNames).toContain('prefer_tls_impersonation');
    expect(drNames).toContain('tls_success_count');

    // Watch-jobs table must exist with the documented schema — downstream
    // tools count on these columns being present on day 1.
    const cols = db.prepare("PRAGMA table_info('watch_jobs')").all() as Array<{ name: string }>;
    const colNames = cols.map(c => c.name).sort();
    expect(colNames).toEqual([
      'created_at',
      'id',
      'interval_seconds',
      'last_check_at',
      'last_content_hash',
      'notification',
      'selector',
      'status',
      'url',
    ]);
    db.close();
  });

  it('is idempotent — second call on the same DB does not re-run', () => {
    const db = openMigrationTestDb(dbPath);
    applyMigrations(db, { vecLoaded: false });
    const firstCount = (db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }).n;

    applyMigrations(db, { vecLoaded: false });
    const secondCount = (db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }).n;

    expect(secondCount).toBe(firstCount);
    db.close();
  });

  it('on read-only DB, warns once and stops without throwing', () => {
    // Seed a writable empty DB then reopen read-only.
    const seed = openMigrationTestDb(dbPath);
    seed.close();

    const ro = new Database(dbPath, { readonly: true });
    expect(() => applyMigrations(ro, { vecLoaded: false })).not.toThrow();
    ro.close();
  });

  it('after one read-only call, subsequent applyMigrations calls are no-ops in the same process', () => {
    const seed = openMigrationTestDb(dbPath);
    seed.close();

    const ro = new Database(dbPath, { readonly: true });
    applyMigrations(ro, { vecLoaded: false });
    ro.close();

    // Even a fresh writable DB handle should be skipped because the guard tripped.
    const other = mkdtempSync(join(tmpdir(), 'wigolo-mig-other-'));
    const otherDb = openMigrationTestDb(join(other, 'cache.db'));
    applyMigrations(otherDb, { vecLoaded: false });
    // No schema_migrations table since the guard short-circuited.
    const hasTable = otherDb
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
      .get();
    expect(hasTable).toBeUndefined();
    otherDb.close();
    rmSync(other, { recursive: true, force: true });
  });

  it('migration 005 is idempotent against a domain_routing that already has the columns', () => {
    // Simulate a hand-patched install: domain_routing already has the new columns.
    const db = openMigrationTestDb(dbPath);
    db.exec(`
      CREATE TABLE domain_routing (
        domain TEXT PRIMARY KEY,
        prefer_playwright INTEGER DEFAULT 0,
        http_failures INTEGER DEFAULT 0,
        last_updated TEXT,
        prefer_tls_impersonation INTEGER DEFAULT 0,
        tls_success_count INTEGER DEFAULT 0
      );
    `);

    expect(() => applyMigrations(db, { vecLoaded: false })).not.toThrow();
    const applied = (db.prepare('SELECT name FROM schema_migrations').all() as Array<{ name: string }>)
      .map((r) => r.name);
    expect(applied).toContain('005-tls-routing');
    db.close();
  });

  it('migration 007 drops a pre-existing lightpanda_routing table (SP1)', () => {
    // Simulate a pre-SP1 DB that still has the routing telemetry table.
    const db = openMigrationTestDb(dbPath);
    db.exec('CREATE TABLE lightpanda_routing (domain TEXT PRIMARY KEY);');
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='lightpanda_routing'").all(),
    ).toHaveLength(1);

    applyMigrations(db, { vecLoaded: false });

    // After migration the table must be gone, and the migration recorded.
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='lightpanda_routing'").all(),
    ).toHaveLength(0);
    const applied = (db.prepare('SELECT name FROM schema_migrations').all() as Array<{ name: string }>)
      .map((r) => r.name);
    expect(applied).toContain('007-drop-lp-routing');
    db.close();
  });

  it('migration 007 is a no-op on a fresh DB without lightpanda_routing (SP1)', () => {
    // Fresh DB never had the table; migration must apply cleanly without error.
    const db = openMigrationTestDb(dbPath);
    expect(() => applyMigrations(db, { vecLoaded: false })).not.toThrow();
    const applied = (db.prepare('SELECT name FROM schema_migrations').all() as Array<{ name: string }>)
      .map((r) => r.name);
    expect(applied).toContain('007-drop-lp-routing');
    db.close();
  });

  it('_resetMigrationGuard clears the read-only flag for the next test', () => {
    const seed = openMigrationTestDb(dbPath);
    seed.close();

    const ro = new Database(dbPath, { readonly: true });
    applyMigrations(ro, { vecLoaded: false });
    ro.close();

    _resetMigrationGuard();

    const fresh = mkdtempSync(join(tmpdir(), 'wigolo-mig-fresh-'));
    const writable = openMigrationTestDb(join(fresh, 'cache.db'));
    applyMigrations(writable, { vecLoaded: false });
    const applied = (writable.prepare('SELECT name FROM schema_migrations').all() as Array<{ name: string }>);
    expect(applied.length).toBeGreaterThan(0);
    writable.close();
    rmSync(fresh, { recursive: true, force: true });
  });

  it('migration 009 adds content_completeness columns to an existing url_cache', () => {
    // url_cache is created inline by initDatabase(), not by the runner — mirror
    // that here so the 009 postStep's table_info guard has a table to ALTER.
    const db = openMigrationTestDb(dbPath);
    db.exec(`
      CREATE TABLE url_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT UNIQUE NOT NULL,
        normalized_url TEXT NOT NULL,
        fetched_at TEXT NOT NULL
      );
    `);

    applyMigrations(db, { vecLoaded: false });

    const applied = (db.prepare('SELECT name FROM schema_migrations').all() as Array<{ name: string }>)
      .map((r) => r.name);
    expect(applied).toContain('009-content-completeness');

    const cols = (db.prepare("PRAGMA table_info('url_cache')").all() as Array<{ name: string }>)
      .map((c) => c.name);
    expect(cols).toContain('content_completeness_level');
    expect(cols).toContain('content_completeness_reason');
    expect(cols).toContain('content_completeness_settled_by');
    db.close();
  });

  it('migration 009 is idempotent against a url_cache that already has the columns', () => {
    // Hand-patched install: the completeness columns already exist.
    const db = openMigrationTestDb(dbPath);
    db.exec(`
      CREATE TABLE url_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT UNIQUE NOT NULL,
        normalized_url TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        content_completeness_level TEXT,
        content_completeness_reason TEXT,
        content_completeness_settled_by TEXT
      );
    `);
    expect(() => applyMigrations(db, { vecLoaded: false })).not.toThrow();
    const applied = (db.prepare('SELECT name FROM schema_migrations').all() as Array<{ name: string }>)
      .map((r) => r.name);
    expect(applied).toContain('009-content-completeness');
    db.close();
  });

  it('migration 009 is a no-op on a bare runner DB with no url_cache table', () => {
    // The runner-only harness never creates url_cache; the guarded postStep
    // must apply cleanly (recorded, no throw) rather than ALTER a missing table.
    const db = openMigrationTestDb(dbPath);
    expect(() => applyMigrations(db, { vecLoaded: false })).not.toThrow();
    const applied = (db.prepare('SELECT name FROM schema_migrations').all() as Array<{ name: string }>)
      .map((r) => r.name);
    expect(applied).toContain('009-content-completeness');
    db.close();
  });

  // Why: the real upgrade path. Every other 012 test builds the index on an
  // EMPTY url_cache, and "it worked on an empty table" is exactly the claim
  // that holds until someone upgrades a populated cache. CREATE INDEX on a
  // populated table walks every existing row, and a throw here would abort the
  // whole migration pass — not just this migration.
  it('migration 012 indexes a url_cache that already holds rows, and indexes them', () => {
    const db = openMigrationTestDb(dbPath);
    db.exec(`
      CREATE TABLE url_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT UNIQUE NOT NULL,
        normalized_url TEXT NOT NULL,
        content_hash TEXT,
        fetched_at TEXT NOT NULL
      );
    `);
    const insert = db.prepare(
      'INSERT INTO url_cache (url, normalized_url, content_hash, fetched_at) VALUES (?, ?, ?, ?)',
    );
    // ONE transaction for the whole fixture, not one per row. What this test
    // asserts is that the index build walks 52 rows that are ALREADY THERE —
    // the number of transactions used to put them there carries none of that
    // meaning. Left unbatched, each `insert.run` is its own durable commit, so
    // the fixture alone cost 52 of the body's 66 commits, and a synchronous
    // body costs (commits x per-commit file-op latency) with no chance to
    // yield. On a volume where that latency is ~300ms — a loaded Windows
    // runner writing rollback journals into %TEMP% — 66 commits crosses the
    // 20s ceiling while this file's other tests, which commit ~15 times each,
    // stay under it. Batching puts this test in the same commit-count class as
    // the siblings that have never timed out.
    db.transaction(() => {
      for (let i = 0; i < 50; i++) {
        insert.run(`https://example.com/${i}`, `https://example.com/${i}`, `hash-${i}`, '2026-01-01');
      }
      // A pre-existing NULL hash must not break the index build either.
      insert.run('https://example.com/legacy', 'https://example.com/legacy', null, '2026-01-01');
      // And a pre-existing DUPLICATE hash must not either — the index is
      // deliberately non-unique because two URLs can serve identical markdown.
      insert.run('https://example.com/dupe', 'https://example.com/dupe', 'hash-7', '2026-01-01');
    })();

    expect(() => applyMigrations(db, { vecLoaded: false })).not.toThrow();

    const applied = (db.prepare('SELECT name FROM schema_migrations').all() as Array<{ name: string }>)
      .map((r) => r.name);
    expect(applied).toContain('012-url-cache-content-hash-index');

    // The index exists AND covers the rows that predate it — a build that
    // silently skipped existing rows would leave the lookup returning nothing.
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?")
      .all('idx_url_cache_content_hash');
    expect(idx).toHaveLength(1);

    const hit = db.prepare('SELECT url FROM url_cache WHERE content_hash = ? ORDER BY id ASC LIMIT 1')
      .get('hash-42') as { url: string } | undefined;
    expect(hit?.url).toBe('https://example.com/42');

    // The duplicate resolves to the first-inserted row, not the later one.
    const dupe = db.prepare('SELECT url FROM url_cache WHERE content_hash = ? ORDER BY id ASC LIMIT 1')
      .get('hash-7') as { url: string } | undefined;
    expect(dupe?.url).toBe('https://example.com/7');

    db.close();
  });

  it('migration 012 is idempotent on a DB that already has the index', () => {
    const db = openMigrationTestDb(dbPath);
    db.exec(`
      CREATE TABLE url_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT UNIQUE NOT NULL,
        normalized_url TEXT NOT NULL,
        content_hash TEXT,
        fetched_at TEXT NOT NULL
      );
      CREATE INDEX idx_url_cache_content_hash ON url_cache(content_hash);
    `);
    expect(() => applyMigrations(db, { vecLoaded: false })).not.toThrow();
    const applied = (db.prepare('SELECT name FROM schema_migrations').all() as Array<{ name: string }>)
      .map((r) => r.name);
    expect(applied).toContain('012-url-cache-content-hash-index');
    db.close();
  });

  // Why: the guard bug this slice shipped a fix for. CREATE INDEX throws on a
  // url_cache WITHOUT content_hash, and a throw aborts the ENTIRE pass — it
  // took migration 009's assertions down with it. The failure mode is not
  // local to the migration that fails, so the guard checks the COLUMN.
  it('migration 012 no-ops on a url_cache lacking content_hash without aborting the pass', () => {
    const db = openMigrationTestDb(dbPath);
    db.exec(`
      CREATE TABLE url_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT UNIQUE NOT NULL,
        normalized_url TEXT NOT NULL,
        fetched_at TEXT NOT NULL
      );
    `);
    expect(() => applyMigrations(db, { vecLoaded: false })).not.toThrow();

    const applied = (db.prepare('SELECT name FROM schema_migrations').all() as Array<{ name: string }>)
      .map((r) => r.name);
    expect(applied).toContain('012-url-cache-content-hash-index');
    // The migrations that share the pass must still have applied — that is the
    // cross-migration blast radius the column guard closes.
    expect(applied).toContain('009-content-completeness');
    expect(applied).toContain('011-tool-audit');
    db.close();
  });
});

const NAME_017 = '017-studio-run-cost';
const COST_COLUMNS = ['cost_browser_actions', 'cost_tokens_in', 'cost_tokens_out', 'cost_spend_usd'];

function columnsOf(db: Database.Database, table: string): Set<string> {
  return new Set((db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name));
}

function indexNames(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name = ?").all(table) as Array<{ name: string }>)
      .map((r) => r.name),
  );
}

/**
 * A database sitting at the schema every migration BEFORE 017 leaves behind — the same replay the
 * runner does, in the same order, with the same bookkeeping. This is what an existing user's file
 * looks like the moment before it is upgraded, and the only way the backfill assertions below can
 * be about pre-existing rows rather than rows the new code wrote.
 */
function seedThrough016(db: Database.Database): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  for (const m of MIGRATIONS) {
    if (m.name === NAME_017 || m.requiresVec) continue;
    db.transaction(() => {
      db.exec(m.sql);
      m.postStep?.(db);
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(m.name, 1);
    })();
  }
}

describe('017-studio-run-cost', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    _resetMigrationGuard();
    dir = mkdtempSync(join(tmpdir(), 'wigolo-mig-017-'));
    dbPath = join(dir, 'cache.db');
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('is registered exactly once, under a name no earlier migration already used', () => {
    const names = MIGRATIONS.map((m) => m.name);
    expect(names.filter((n) => n === NAME_017)).toHaveLength(1);
    expect(new Set(names).size).toBe(names.length);
  });

  it('forward-applies over a DB that already carries every prior migration', () => {
    const db = openMigrationTestDb(dbPath);
    seedThrough016(db);
    expect(columnsOf(db, 'studio_runs').has('cost_browser_actions')).toBe(false);

    expect(() => applyMigrations(db, { vecLoaded: false })).not.toThrow();

    const cols = columnsOf(db, 'studio_runs');
    for (const c of COST_COLUMNS) expect(cols.has(c), `missing column ${c}`).toBe(true);
    expect(db.prepare('SELECT name FROM schema_migrations WHERE name = ?').all(NAME_017)).toHaveLength(1);
    db.close();
  });

  it('backfills the counters of runs that predate the columns, exactly as a replay folds them', () => {
    const db = openMigrationTestDb(dbPath);
    seedThrough016(db);
    db.prepare('INSERT INTO studio_runs (id, task, created_at, last_seq) VALUES (?, ?, ?, ?)').run('7fq2', 'old', 'T', 0);
    db.prepare('INSERT INTO studio_runs (id, task, created_at, last_seq) VALUES (?, ?, ?, ?)').run('a9kw', 'quiet', 'T', 0);
    const insert = db.prepare('INSERT INTO studio_run_events (run_id, seq, ts, actor, type, payload) VALUES (?, ?, ?, ?, ?, ?)');
    // The same payload zoo the store's fold-parity test uses: the arithmetic in the backfill is the
    // store's, restated in SQL, so every shape it must REFUSE has to be here too.
    const zoo: Array<Record<string, unknown>> = [
      { kind: 'browser_action', amount: 2 },
      { kind: 'browser_action', amount: '3' },   // a string is not an amount
      { kind: 'browser_action', amount: true },  // nor is a boolean — SQLite would read it as 1
      { kind: 'tokens_in', amount: 10 },
      { kind: 'tokens_out' },                    // no amount at all
      { kind: 'spend_usd', amount: 0.25 },
      { kind: 'spend_usd', amount: -1 },         // a refund is a legal counter
      { kind: 'wat', amount: 99 },               // an unknown kind lands in no bucket
      { amount: 5 },                             // ...and neither does no kind
    ];
    zoo.forEach((payload, i) => insert.run('7fq2', i + 1, 'T', '{"kind":"agent"}', 'cost.recorded', JSON.stringify(payload)));
    // A type that is not a counter must contribute nothing, even carrying a plausible payload.
    insert.run('7fq2', zoo.length + 1, 'T', '{"kind":"agent"}', 'mark.placed', JSON.stringify({ kind: 'browser_action', amount: 1000 }));

    applyMigrations(db, { vecLoaded: false });

    expect(db.prepare(`SELECT ${COST_COLUMNS.join(', ')} FROM studio_runs WHERE id = ?`).get('7fq2')).toEqual({
      cost_browser_actions: 2, cost_tokens_in: 10, cost_tokens_out: 0, cost_spend_usd: -0.75,
    });
    // A run with no counter events keeps the column default rather than a NULL the store would
    // then have to defend against on every projection.
    expect(db.prepare(`SELECT ${COST_COLUMNS.join(', ')} FROM studio_runs WHERE id = ?`).get('a9kw')).toEqual({
      cost_browser_actions: 0, cost_tokens_in: 0, cost_tokens_out: 0, cost_spend_usd: 0,
    });
    db.close();
  });

  it('swaps the type index for the two the append and list paths seek', () => {
    const db = openMigrationTestDb(dbPath);
    seedThrough016(db);
    expect(indexNames(db, 'studio_run_events').has('idx_studio_run_events_type')).toBe(true);

    applyMigrations(db, { vecLoaded: false });

    const idx = indexNames(db, 'studio_run_events');
    expect(idx.has('idx_studio_run_events_type_seq')).toBe(true);
    expect(idx.has('idx_studio_run_events_type_ts')).toBe(true);
    // Dropped, not kept alongside: (run_id, type) is a strict prefix of both, so it answers nothing
    // new and still costs a b-tree write on the append path this migration exists to make cheaper.
    expect(idx.has('idx_studio_run_events_type')).toBe(false);
    db.close();
  });

  it('is a no-op on a runner DB whose studio tables were never created', () => {
    // The runner-only harness skips whatever creates a table inline, so an absent studio_runs must
    // not abort the pass and take its neighbours down with it — the 012/015 guard, same shape.
    const db = openMigrationTestDb(dbPath);
    db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
    for (const m of MIGRATIONS) {
      if (m.name === NAME_017 || m.requiresVec) continue;
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(m.name, 1);
    }
    expect(() => applyMigrations(db, { vecLoaded: false })).not.toThrow();
    expect(db.prepare('SELECT name FROM schema_migrations WHERE name = ?').all(NAME_017)).toHaveLength(1);
    db.close();
  });

  it('is idempotent — a second pass adds nothing and re-counts nothing', () => {
    const db = openMigrationTestDb(dbPath);
    applyMigrations(db, { vecLoaded: false });
    db.prepare('INSERT INTO studio_runs (id, task, created_at, last_seq, cost_browser_actions) VALUES (?, ?, ?, ?, ?)').run('7fq2', 'a', 'T', 1, 7);
    db.prepare('INSERT INTO studio_run_events (run_id, seq, ts, actor, type, payload) VALUES (?, ?, ?, ?, ?, ?)')
      .run('7fq2', 1, 'T', '{"kind":"agent"}', 'cost.recorded', '{"kind":"browser_action","amount":7}');

    _resetMigrationGuard();
    expect(() => applyMigrations(db, { vecLoaded: false })).not.toThrow();
    // A re-run that backfilled again would double this to 14 — the guard is the column check, and
    // the number is what says the guard fired rather than the migration merely not throwing.
    expect((db.prepare('SELECT cost_browser_actions AS a FROM studio_runs WHERE id = ?').get('7fq2') as { a: number }).a).toBe(7);
    db.close();
  });

  it('keeps the .sql grep-mirror in step with the TS constant', async () => {
    const { readFile } = await import('node:fs/promises');
    const mirror = await readFile(new URL('../../../src/cache/migrations/017-studio-run-cost.sql', import.meta.url), 'utf8');
    const entry = MIGRATIONS.find((m) => m.name === NAME_017);
    expect(mirror.replace(/^--.*$/gm, '').trim()).toBe(entry!.sql.replace(/^--.*$/gm, '').trim());
    // ...and this migration's statements live in the postStep, so the mirror carries them as prose.
    // A reviewer who greps for the index by name must land in this file.
    expect(mirror).toContain('idx_studio_run_events_type_seq');
    expect(mirror).toContain('cost_browser_actions');
  });
});
