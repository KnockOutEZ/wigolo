import { chmodSync, copyFileSync, mkdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import * as sv from 'sqlite-vec';
import { createLogger } from '../logger.js';
import { getConfig } from '../config.js';
import { isPackagedBinary } from '../util/packaged.js';
import { applyMigrations } from './migrations/runner.js';

const log = createLogger('cache');

/**
 * Load the sqlite-vec loadable extension into `db`.
 *
 * On the npm/source path this is a straight `sv.load(db)` — SQLite dlopen's the
 * dylib/.so straight out of node_modules and nothing changes.
 *
 * Inside a single-file packaged binary (@yao-pkg/pkg) the extension lives in the
 * virtual `/snapshot` filesystem, which the OS loader (dlopen) cannot read — the
 * native `.node` addons work because pkg auto-extracts them at require() time,
 * but `db.loadExtension(path)` hands a raw path to SQLite with no pkg hook, so a
 * `/snapshot/...` path fails, and SQLite then re-suffixes the missing file to a
 * doubled `vec0.dylib.dylib` while probing. Fix: copy the extension out of the
 * snapshot to a real path under `<dataDir>/native/` and load it from there. The
 * copy is idempotent — re-copied only when the on-disk size differs (a binary
 * upgrade), so warm starts pay nothing.
 *
 * `dbPath` is `<dataDir>/wigolo.db`, so the sibling `native/` dir is the data
 * dir; no config dependency is pulled into the cache layer.
 */
function loadVecExtension(db: Database.Database, dbPath: string): void {
  if (!isPackagedBinary()) {
    sv.load(db);
    return;
  }

  // Snapshot source path, e.g. /snapshot/.../sqlite-vec-darwin-arm64/vec0.dylib
  const snapshotPath = sv.getLoadablePath();
  const nativeDir = join(dirname(dbPath), 'native');
  const realPath = join(nativeDir, basename(snapshotPath));

  mkdirSync(nativeDir, { recursive: true });

  let needsCopy = true;
  try {
    const src = statSync(snapshotPath);
    const dst = statSync(realPath);
    needsCopy = src.size !== dst.size;
  } catch {
    // Destination missing (first run) — copy.
    needsCopy = true;
  }
  if (needsCopy) {
    copyFileSync(snapshotPath, realPath);
  }

  // Load the exact extracted file. Passing the full, existing `.dylib`/`.so`
  // path stops SQLite from appending its own suffix (the doubled `.dylib.dylib`
  // seen under /snapshot). No entrypoint override — sqlite-vec's default init
  // symbol resolves from the filename, matching `sv.load`'s behaviour.
  db.loadExtension(realPath);
}

// The DB stores session-bearing anti-bot clearance tokens (cf_clearance), so
// the file must be owner-only like config.json — not the default 0644.
const DB_FILE_MODE = 0o600;

// Restrict a DB path (or a lazily-created -wal/-shm sidecar) to owner-only,
// tolerating ENOENT since sidecars may not exist yet on a fresh WAL DB.
function restrictMode(path: string): void {
  try {
    chmodSync(path, DB_FILE_MODE);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    log.warn('failed to restrict DB file permissions', {
      path,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

let instance: Database.Database | null = null;
let vecLoaded = false;
let exitHookRegistered = false;

export function isVecExtensionLoaded(): boolean {
  return vecLoaded;
}

// Register a process-exit guard so any CLI command that opens the DB
// closes it before native teardown — prevents the better-sqlite3 +
// sqlite-vec destructor race that surfaces as
// `mutex lock failed: Invalid argument` on doctor/warmup exit.
function ensureExitHookRegistered(): void {
  if (exitHookRegistered) return;
  exitHookRegistered = true;
  process.on('exit', () => {
    try {
      closeDatabase();
    } catch {
      // swallow — process is exiting, nothing useful to do
    }
  });
}

export function initDatabase(dbPath: string): Database.Database {
  if (instance) {
    instance.close();
    instance = null;
  }

  const db = new Database(dbPath);

  // Lock the DB file down before any write. In-memory DBs have no file.
  const isFileBacked = dbPath !== ':memory:' && dbPath !== '';
  if (isFileBacked) restrictMode(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  // Cross-process write contention (the stdio CLI and the Studio host can both
  // open wigolo.db): wait up to busy_timeout ms for the lock instead of throwing
  // SQLITE_BUSY immediately. WAL already lets readers proceed during a write.
  db.pragma(`busy_timeout = ${getConfig().sqliteBusyTimeoutMs}`);

  // sqlite-vec extension. Required for vector search; soft-fails on
  // unsupported platforms (musl/alpine) so cache.db init still works for
  // FTS5-only flows. Vector code paths check `isVecExtensionLoaded()` or
  // gracefully degrade.
  try {
    loadVecExtension(db, dbPath);
    vecLoaded = true;
  } catch (err) {
    vecLoaded = false;
    log.warn('sqlite-vec extension failed to load — vector search disabled', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS url_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT UNIQUE NOT NULL,
      normalized_url TEXT NOT NULL,
      title TEXT,
      markdown TEXT,
      raw_html TEXT,
      metadata TEXT,
      links TEXT,
      images TEXT,
      fetch_method TEXT,
      extractor_used TEXT,
      content_hash TEXT,
      fetched_at TEXT NOT NULL,
      expires_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_url_cache_normalized ON url_cache(normalized_url);

    CREATE VIRTUAL TABLE IF NOT EXISTS url_cache_fts USING fts5(
      title,
      markdown,
      url,
      content='url_cache',
      content_rowid='id'
    );

    CREATE TRIGGER IF NOT EXISTS url_cache_ai AFTER INSERT ON url_cache BEGIN
      INSERT INTO url_cache_fts(rowid, title, markdown, url)
        VALUES (new.id, new.title, new.markdown, new.url);
    END;

    CREATE TRIGGER IF NOT EXISTS url_cache_ad BEFORE DELETE ON url_cache BEGIN
      INSERT INTO url_cache_fts(url_cache_fts, rowid, title, markdown, url)
        VALUES ('delete', old.id, old.title, old.markdown, old.url);
    END;

    CREATE TRIGGER IF NOT EXISTS url_cache_au BEFORE UPDATE ON url_cache BEGIN
      INSERT INTO url_cache_fts(url_cache_fts, rowid, title, markdown, url)
        VALUES ('delete', old.id, old.title, old.markdown, old.url);
    END;

    CREATE TRIGGER IF NOT EXISTS url_cache_au_after AFTER UPDATE ON url_cache BEGIN
      INSERT INTO url_cache_fts(rowid, title, markdown, url)
        VALUES (new.id, new.title, new.markdown, new.url);
    END;

    CREATE TABLE IF NOT EXISTS search_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query TEXT NOT NULL,
      query_hash TEXT UNIQUE NOT NULL,
      results TEXT NOT NULL,
      engines_used TEXT,
      searched_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT
    );

    CREATE TABLE IF NOT EXISTS domain_routing (
      domain TEXT PRIMARY KEY,
      prefer_playwright INTEGER DEFAULT 0,
      http_failures INTEGER DEFAULT 0,
      last_updated TEXT
    );

    CREATE TABLE IF NOT EXISTS domain_boilerplate (
      domain TEXT NOT NULL,
      block_hash TEXT NOT NULL,
      sample_text TEXT,
      discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (domain, block_hash)
    );
  `);

  // Embedding columns migration
  try {
    const columns = db.pragma('table_info(url_cache)') as Array<{ name: string }>;
    const columnNames = new Set(columns.map(c => c.name));

    if (!columnNames.has('embedding')) {
      db.exec('ALTER TABLE url_cache ADD COLUMN embedding BLOB');
    }
    if (!columnNames.has('embedding_model')) {
      db.exec('ALTER TABLE url_cache ADD COLUMN embedding_model TEXT');
    }
    if (!columnNames.has('embedding_dims')) {
      db.exec('ALTER TABLE url_cache ADD COLUMN embedding_dims INTEGER');
    }
  } catch {
    // Migration already applied or column already exists
  }

  // Apply registered migrations after the inline schema is in place so
  // migrations can build on the legacy tables (url_cache, etc.). Migrations
  // that depend on the sqlite-vec extension declare `requiresVec: true` and
  // are skipped when the extension is unavailable; FTS5-only migrations
  // (e.g. feed_items) still run.
  try {
    applyMigrations(db, { vecLoaded });
  } catch (err) {
    log.error('migration runner failed — some schema may be missing', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // The -wal/-shm sidecars are created lazily on first write (the inline
  // schema + migrations above). Lock them down too — they can hold recently
  // written clearance rows. ENOENT is tolerated (WAL may be checkpointed away).
  if (isFileBacked) {
    restrictMode(`${dbPath}-wal`);
    restrictMode(`${dbPath}-shm`);
  }

  instance = db;
  ensureExitHookRegistered();
  return db;
}

export function getDatabase(): Database.Database {
  if (!instance) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return instance;
}

export function closeDatabase(): void {
  if (instance) {
    instance.close();
    instance = null;
    vecLoaded = false;
  }
}

/**
 * Liveness probe for the cache DB: true iff it is initialized AND answers a trivial
 * query. Used by the /health endpoint instead of assuming the cache is up. Never throws.
 */
export function probeCacheDb(): boolean {
  if (!instance) return false;
  try {
    instance.prepare('SELECT 1').get();
    return true;
  } catch {
    return false;
  }
}
