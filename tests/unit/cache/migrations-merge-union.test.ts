import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { applyMigrations, MIGRATIONS, _resetMigrationGuard } from '../../../src/cache/migrations/runner.js';
import { openMigrationTestDb } from '../../helpers/migration-test-db.js';

/**
 * D15 — migration identity is the `name` field, and a released name must never be
 * renamed: renaming re-applies the migration on every existing user database.
 *
 * The pre-flight #2 merge unioned two independently-released MIGRATIONS arrays. These
 * are the exact names each branch had shipped at its tip immediately before the merge
 * (`origin/main` @ b3ccf92b, `studio-handoff` @ 013ae226). They are hard-coded rather
 * than derived so that dropping, renaming or reordering an entry in runner.ts fails
 * here instead of silently re-running migrations on users' DBs.
 */
const MAIN_RELEASED = [
  '001-sqlite-vec',
  '002-feed-items',
  '003-crawl-etags',
  '004-watch-jobs',
  '005-tls-routing',
  '006-url-cache-http-status',
  '007-drop-lp-routing',
  '008-antibot-clearance',
  '009-content-completeness',
  '010-clearance-route',
];

const STUDIO_RELEASED = [
  '001-sqlite-vec',
  '002-feed-items',
  '003-crawl-etags',
  '004-watch-jobs',
  '005-tls-routing',
  '006-url-cache-http-status',
  '007-drop-lp-routing',
  '008-studio-artifacts',
  '009-studio-artifacts-content',
  '010-studio-audit',
  '011-tool-audit',
];

/**
 * Migrations added AFTER the pre-flight #2 merge. Kept separate from the two
 * released sets on purpose: those record history and must never change, whereas
 * this list grows. An entry here is a deliberate addition; an unrecognised name
 * in neither list is still a failure.
 */
const POST_MERGE_ADDED = [
  '012-url-cache-content-hash-index',
  '013-studio-flows',
  '013-url-versions',
  '014-url-versions-hash-index',
  '015-url-cache-origin-authenticated',
];

/** Union of both released sets (7 shared + main's 3 + studio's 4) plus post-merge additions. */
const UNION_SIZE = 14 + POST_MERGE_ADDED.length;

/**
 * url_cache is created inline by initDatabase(), not by the runner, and two migrations
 * (006, 009-content-completeness) no-op when the table is absent. Seeding a minimal
 * copy is what makes those ALTER paths actually execute — without it those assertions
 * would pass vacuously.
 */
function seedUrlCache(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS url_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT UNIQUE NOT NULL,
      normalized_url TEXT NOT NULL,
      content_hash TEXT,
      fetched_at TEXT NOT NULL
    );
  `);
}

/**
 * Replay only one branch's entries, exactly as the runner does (same order, same
 * transaction, same schema_migrations bookkeeping). This reproduces a real user DB
 * sitting at that branch's released schema.
 */
function seedBranchSchema(db: Database.Database, names: string[]): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);
  const record = db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)');
  for (const migration of MIGRATIONS) {
    if (!names.includes(migration.name)) continue;
    if (migration.requiresVec) continue; // sqlite-vec is not loaded in this harness
    db.transaction(() => {
      db.exec(migration.sql);
      migration.postStep?.(db);
      record.run(migration.name, Date.now());
    })();
  }
}

function appliedNames(db: Database.Database): string[] {
  return (db.prepare('SELECT name FROM schema_migrations ORDER BY name').all() as Array<{ name: string }>)
    .map((r) => r.name);
}

/**
 * A schema fingerprint that survives ALTER TABLE. sqlite_master's stored CREATE text is
 * NOT rewritten by `ADD COLUMN`, so comparing it alone would miss every column added by
 * a postStep — which is most of what the two branches contributed.
 */
function schemaSnapshot(db: Database.Database): string {
  const objects = db
    .prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
    .all() as Array<{ type: string; name: string; sql: string | null }>;

  const lines: string[] = [];
  for (const o of objects) {
    lines.push(`${o.type}:${o.name}:${(o.sql ?? '').replace(/\s+/g, ' ').trim()}`);
    if (o.type === 'table') {
      const cols = (db.prepare(`PRAGMA table_info('${o.name}')`).all() as Array<{ name: string; type: string }>)
        .map((c) => `${c.name} ${c.type}`)
        .sort();
      lines.push(`  cols:${cols.join(',')}`);
    }
  }
  return lines.join('\n');
}

describe('MIGRATIONS — merged union of origin/main and studio-handoff (D15)', () => {
  let dir: string;

  beforeEach(() => {
    _resetMigrationGuard();
    dir = mkdtempSync(join(tmpdir(), 'wigolo-union-'));
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function open(name: string): Database.Database {
    return openMigrationTestDb(join(dir, `${name}.db`));
  }

  it('carries both branches\' released names, unrenamed, with no duplicates', () => {
    const names = MIGRATIONS.map((m) => m.name);

    expect(new Set(names).size).toBe(names.length);
    expect(names).toHaveLength(UNION_SIZE);

    for (const name of MAIN_RELEASED) expect(names).toContain(name);
    for (const name of STUDIO_RELEASED) expect(names).toContain(name);

    for (const name of POST_MERGE_ADDED) expect(names).toContain(name);

    // Nothing beyond the union may appear without a deliberate update here: an
    // unrecognised name means a migration was added or renamed since the merge.
    const union = new Set([...MAIN_RELEASED, ...STUDIO_RELEASED, ...POST_MERGE_ADDED]);
    expect(names.filter((n) => !union.has(n))).toEqual([]);
  });

  it('preserves each branch\'s relative order', () => {
    const names = MIGRATIONS.map((m) => m.name);
    const positions = (branch: string[]) => branch.map((n) => names.indexOf(n));

    for (const branch of [MAIN_RELEASED, STUDIO_RELEASED]) {
      const idx = positions(branch);
      // Strictly increasing. studio's 009-studio-artifacts-content postStep reads
      // pragma table_info(studio_artifacts), so it MUST run after 008-studio-artifacts
      // in the same pass or it silently no-ops and the FTS index is never created.
      expect(idx).toEqual([...idx].sort((a, b) => a - b));
      expect(new Set(idx).size).toBe(idx.length);
    }
  });

  it('applies cleanly on a fresh DB and is idempotent on re-run', () => {
    const db = open('fresh');
    seedUrlCache(db);
    applyMigrations(db, { vecLoaded: false });

    // 001 requiresVec and is skipped without the extension; everything else applies.
    expect(appliedNames(db)).toHaveLength(UNION_SIZE - 1);

    const before = schemaSnapshot(db);
    _resetMigrationGuard();
    applyMigrations(db, { vecLoaded: false });
    expect(appliedNames(db)).toHaveLength(UNION_SIZE - 1);
    expect(schemaSnapshot(db)).toBe(before);
    db.close();
  });

  it('applies studio\'s four entries to a DB already at main\'s released schema', () => {
    const db = open('at-main');
    seedUrlCache(db);
    seedBranchSchema(db, MAIN_RELEASED);
    const seeded = appliedNames(db);
    expect(seeded).not.toContain('008-studio-artifacts');

    applyMigrations(db, { vecLoaded: false });

    const after = appliedNames(db);
    expect(after.filter((n) => !seeded.includes(n)).sort()).toEqual([
      '008-studio-artifacts',
      '009-studio-artifacts-content',
      '010-studio-audit',
      '011-tool-audit',
      ...POST_MERGE_ADDED,
    ]);
    // main's released rows must NOT be re-applied — that is the D15 data-integrity bug.
    expect(after).toHaveLength(UNION_SIZE - 1);
    db.close();
  });

  it('applies main\'s three entries to a DB already at studio\'s released schema', () => {
    const db = open('at-studio');
    seedUrlCache(db);
    seedBranchSchema(db, STUDIO_RELEASED);
    const seeded = appliedNames(db);
    expect(seeded).not.toContain('008-antibot-clearance');

    applyMigrations(db, { vecLoaded: false });

    const after = appliedNames(db);
    expect(after.filter((n) => !seeded.includes(n)).sort()).toEqual([
      '008-antibot-clearance',
      '009-content-completeness',
      '010-clearance-route',
      ...POST_MERGE_ADDED,
    ]);
    expect(after).toHaveLength(UNION_SIZE - 1);
    db.close();
  });

  it('converges on an identical schema from a fresh DB and from either branch\'s DB', () => {
    const snapshots: Record<string, string> = {};

    for (const [label, seed] of [
      ['fresh', null],
      ['at-main', MAIN_RELEASED],
      ['at-studio', STUDIO_RELEASED],
    ] as Array<[string, string[] | null]>) {
      _resetMigrationGuard();
      const db = open(`converge-${label}`);
      seedUrlCache(db);
      if (seed) seedBranchSchema(db, seed);
      applyMigrations(db, { vecLoaded: false });
      snapshots[label] = schemaSnapshot(db);
      db.close();
    }

    // Divergence here means an upgrade path skipped work a fresh install gets — the
    // exact failure mode where studio's 009 postStep no-ops against an existing DB.
    expect(snapshots['at-main']).toBe(snapshots['fresh']);
    expect(snapshots['at-studio']).toBe(snapshots['fresh']);

    // Spot-check the columns each branch contributed, so a converged-but-empty schema
    // (e.g. every postStep no-opping identically) cannot satisfy the assertion above.
    const db = open('converge-at-main');
    const routing = (db.prepare("PRAGMA table_info('domain_routing')").all() as Array<{ name: string }>)
      .map((c) => c.name);
    expect(routing).toContain('cf_clearance');      // main, 008-antibot-clearance
    expect(routing).toContain('solved_route');       // main, 010-clearance-route
    const urlCache = (db.prepare("PRAGMA table_info('url_cache')").all() as Array<{ name: string }>)
      .map((c) => c.name);
    expect(urlCache).toContain('http_status');                  // main, 006
    expect(urlCache).toContain('content_completeness_level');   // main, 009-content-completeness
    const artifacts = (db.prepare("PRAGMA table_info('studio_artifacts')").all() as Array<{ name: string }>)
      .map((c) => c.name);
    expect(artifacts).toContain('markdown');         // studio, 009-studio-artifacts-content
    const fts = db
      .prepare("SELECT name FROM sqlite_master WHERE name = 'studio_artifacts_fts'")
      .all();
    expect(fts).toHaveLength(1);                     // studio, 009 postStep
    db.close();
  });
});
