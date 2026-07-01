import type Database from 'better-sqlite3';
import { createLogger } from '../../logger.js';

const log = createLogger('cache');

/**
 * Migration registry. Entries are TS constants (not file reads) so the
 * built dist/ tree has no runtime filesystem dependency. Each migration's
 * `sql` string is also mirrored in src/cache/migrations/NNN-*.sql for
 * grep-ability and review.
 */
export interface Migration {
  /** Unique stable name. Must never be renamed after release. */
  name: string;
  sql: string;
  /** True if the migration depends on sqlite-vec being loaded. */
  requiresVec?: boolean;
  /**
   * Optional follow-up step run inside the same transaction as `sql`. Used
   * for migrations whose idempotency requires JS-level inspection (e.g.
   * conditional ADD COLUMN) that pure SQL can't express on SQLite.
   */
  postStep?: (db: Database.Database) => void;
}

const MIGRATION_001_SQLITE_VEC = `
CREATE VIRTUAL TABLE IF NOT EXISTS vec_documents USING vec0(
  embedding float[384]
);

CREATE TABLE IF NOT EXISTS vec_id_map (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS vec_metadata (
  rowid INTEGER PRIMARY KEY REFERENCES vec_id_map(rowid) ON DELETE CASCADE,
  url TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  model_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  extra_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_vec_metadata_url ON vec_metadata(url);
CREATE INDEX IF NOT EXISTS idx_vec_metadata_hash ON vec_metadata(content_hash);
CREATE INDEX IF NOT EXISTS idx_vec_metadata_model ON vec_metadata(model_id);
`;

const MIGRATION_002_FEED_ITEMS = `
CREATE TABLE IF NOT EXISTS feed_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  feed_url TEXT NOT NULL,
  guid TEXT NOT NULL,
  title TEXT NOT NULL,
  link TEXT NOT NULL,
  summary TEXT NOT NULL,
  published_date TEXT,
  category TEXT NOT NULL DEFAULT 'news',
  fetched_at TEXT NOT NULL,
  UNIQUE(feed_url, guid)
);

CREATE INDEX IF NOT EXISTS idx_feed_items_published ON feed_items(published_date);
CREATE INDEX IF NOT EXISTS idx_feed_items_feed_url ON feed_items(feed_url);

CREATE VIRTUAL TABLE IF NOT EXISTS feed_items_fts USING fts5(
  title, summary, link UNINDEXED,
  content='feed_items',
  content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS feed_items_ai AFTER INSERT ON feed_items BEGIN
  INSERT INTO feed_items_fts(rowid, title, summary, link) VALUES (new.id, new.title, new.summary, new.link);
END;

CREATE TRIGGER IF NOT EXISTS feed_items_ad AFTER DELETE ON feed_items BEGIN
  INSERT INTO feed_items_fts(feed_items_fts, rowid, title, summary, link) VALUES('delete', old.id, old.title, old.summary, old.link);
END;

CREATE TRIGGER IF NOT EXISTS feed_items_au AFTER UPDATE ON feed_items BEGIN
  INSERT INTO feed_items_fts(feed_items_fts, rowid, title, summary, link) VALUES('delete', old.id, old.title, old.summary, old.link);
  INSERT INTO feed_items_fts(feed_items_fts, rowid, title, summary, link) VALUES (new.id, new.title, new.summary, new.link);
END;
`;

const MIGRATION_003_CRAWL_ETAGS = `
CREATE TABLE IF NOT EXISTS crawl_etags (
  url TEXT PRIMARY KEY,
  origin TEXT NOT NULL,
  etag TEXT,
  last_modified TEXT,
  fetched_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_crawl_etags_origin ON crawl_etags(origin);
`;

const MIGRATION_004_WATCH_JOBS = `
CREATE TABLE IF NOT EXISTS watch_jobs (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  interval_seconds INTEGER NOT NULL,
  selector TEXT,
  last_check_at INTEGER,
  last_content_hash TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  notification TEXT NOT NULL DEFAULT 'inline',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_watch_jobs_status ON watch_jobs(status);
CREATE INDEX IF NOT EXISTS idx_watch_jobs_url ON watch_jobs(url);
`;

// TLS-impersonation routing columns on domain_routing. The base
// table is created inline in src/cache/db.ts; tests and bare callers get a
// safety-net CREATE here. ALTERs are skipped (per-statement) when the column
// already exists so the migration is idempotent against existing installs
// that may have been hand-patched.
const MIGRATION_005_TLS_ROUTING = `
CREATE TABLE IF NOT EXISTS domain_routing (
  domain TEXT PRIMARY KEY,
  prefer_playwright INTEGER DEFAULT 0,
  http_failures INTEGER DEFAULT 0,
  last_updated TEXT
);
`;

// Add nullable http_status column so cache + change-detection
// can distinguish status-code transitions from body changes. SQL is empty
// because the entire effect is in the postStep — `ADD COLUMN IF NOT EXISTS`
// doesn't exist in SQLite, and an unguarded `ALTER` blows up on re-runs.
const MIGRATION_006_URL_CACHE_HTTP_STATUS = '';

// SP1: Remove the browser-routing telemetry table for the alternative browser
// backend that has been dropped. The table is not user data; dropping it is
// safe. SQL is empty — the actual drop runs in postStep guarded against fresh
// DBs where the table was never created.
const MIGRATION_007_DROP_LP_ROUTING = '';

export const MIGRATIONS: Migration[] = [
  { name: '001-sqlite-vec', sql: MIGRATION_001_SQLITE_VEC, requiresVec: true },
  { name: '002-feed-items', sql: MIGRATION_002_FEED_ITEMS },
  { name: '003-crawl-etags', sql: MIGRATION_003_CRAWL_ETAGS },
  { name: '004-watch-jobs', sql: MIGRATION_004_WATCH_JOBS },
  {
    name: '005-tls-routing',
    sql: MIGRATION_005_TLS_ROUTING,
    /**
     * Post-step adds the TLS-impersonation columns to domain_routing using
     * pragma table_info to skip already-present columns. SQLite has no
     * `ADD COLUMN IF NOT EXISTS` so we gate at the JS layer to keep the
     * migration idempotent if a column was added out-of-band.
     */
    postStep: (db) => {
      const cols = db.pragma('table_info(domain_routing)') as Array<{ name: string }>;
      const names = new Set(cols.map((c) => c.name));
      if (!names.has('prefer_tls_impersonation')) {
        db.exec('ALTER TABLE domain_routing ADD COLUMN prefer_tls_impersonation INTEGER DEFAULT 0');
      }
      if (!names.has('tls_success_count')) {
        db.exec('ALTER TABLE domain_routing ADD COLUMN tls_success_count INTEGER DEFAULT 0');
      }
    },
  },
  {
    name: '006-url-cache-http-status',
    sql: MIGRATION_006_URL_CACHE_HTTP_STATUS,
    postStep: (db) => {
      // url_cache is created inline by initDatabase() in src/cache/db.ts; the
      // runner-only test harness skips that inline schema. Guard the ALTER so
      // the migration is harmless on bare in-memory DBs (the column will be
      // present whenever the table is, via the next initDatabase call).
      const cols = db.pragma('table_info(url_cache)') as Array<{ name: string }>;
      if (cols.length === 0) return;
      const names = new Set(cols.map((c) => c.name));
      if (!names.has('http_status')) {
        db.exec('ALTER TABLE url_cache ADD COLUMN http_status INTEGER');
      }
    },
  },
  {
    name: '007-drop-lp-routing',
    sql: MIGRATION_007_DROP_LP_ROUTING,
    postStep: (db) => {
      // Drop the browser-routing telemetry table from the removed alternative
      // browser backend. Fresh DBs won't have this table; this is a no-op for them.
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='lightpanda_routing'",
      ).all() as Array<{ name: string }>;
      if (tables.length > 0) {
        db.exec('DROP TABLE lightpanda_routing');
      }
    },
  },
];

function isReadOnlyError(err: unknown): boolean {
  if (!err) return false;
  const code = (err as { code?: string }).code;
  if (code === 'SQLITE_READONLY' || code === 'SQLITE_READONLY_DBMOVED') return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /SQLITE_READONLY|attempt to write a readonly|readonly database/i.test(msg);
}

// Process-lifetime guard: once we have seen a read-only DB we stop retrying
// migrations for the rest of the process. Without this, each
// initDatabase() in a single CLI invocation (eg. doctor's two checks) would
// re-attempt every pending migration and emit the same error twice.
let readOnlyWarned = false;

/** Test-only: reset the module-level read-only guard between cases. */
export function _resetMigrationGuard(): void {
  readOnlyWarned = false;
}

/**
 * Apply pending migrations in order. Idempotent — already-applied migrations
 * are skipped via the schema_migrations table. Migrations marked
 * `requiresVec: true` are skipped when the sqlite-vec extension is absent so
 * FTS5-only flows still work on platforms without the native extension.
 * On a read-only database, logs a single warning and stops; subsequent
 * calls in the same process are no-ops.
 */
export function applyMigrations(db: Database.Database, opts: { vecLoaded: boolean } = { vecLoaded: true }): void {
  if (readOnlyWarned) {
    return;
  }

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL
      )
    `);
  } catch (err) {
    if (isReadOnlyError(err)) {
      readOnlyWarned = true;
      log.warn('database is read-only — skipping migrations for this process', {
        cause: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    throw err;
  }

  const appliedRows = db.prepare('SELECT name FROM schema_migrations').all() as Array<{ name: string }>;
  const applied = new Set(appliedRows.map(r => r.name));

  const recordStmt = db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)');

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.name)) continue;
    if (migration.requiresVec && !opts.vecLoaded) {
      log.warn('migration skipped — sqlite-vec not loaded', { name: migration.name });
      continue;
    }
    try {
      db.transaction(() => {
        db.exec(migration.sql);
        if (migration.postStep) {
          migration.postStep(db);
        }
        recordStmt.run(migration.name, Date.now());
      })();
      log.info('migration applied', { name: migration.name });
    } catch (err) {
      if (isReadOnlyError(err)) {
        readOnlyWarned = true;
        log.warn('database is read-only — skipping remaining migrations for this process', {
          name: migration.name,
          cause: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      log.error('migration failed', {
        name: migration.name,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
}
