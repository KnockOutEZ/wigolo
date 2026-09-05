import { chmodSync, copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import * as sv from 'sqlite-vec';
import { createLogger } from '../logger.js';
import { getConfig } from '../config.js';
import { isInsideAppArchive, isPackagedBinary } from '../util/packaged.js';
import {
  getVecExtensionStatus,
  recordVecClosed,
  recordVecFailure,
  recordVecLoaded,
} from './vec-availability.js';
import { applyMigrations, MIGRATIONS } from './migrations/runner.js';

const log = createLogger('cache');

/**
 * Load the sqlite-vec loadable extension into `db`.
 *
 * On the npm/source path this is a straight `sv.load(db)` — SQLite dlopen's the
 * dylib/.so straight out of node_modules and nothing changes.
 *
 * TWO virtual filesystems need the copy-out path, not one. Both hand SQLite a
 * path the OS loader cannot resolve, and both used to be diagnosed as a broken
 * install because the error surfaces as a missing library or a doubled
 * `vec0.dylib.dylib` (SQLite re-suffixing while it probes for a file that, as
 * far as the OS is concerned, is not there):
 *
 *   - a single-file packaged binary (@yao-pkg/pkg), where the extension lives
 *     under the virtual `/snapshot` tree. Native `.node` addons survive because
 *     pkg auto-extracts them at require() time, but `db.loadExtension(path)`
 *     hands a raw path to SQLite with no pkg hook.
 *   - a desktop-app archive (`.asar`), which is a single FILE on disk. Only the
 *     desktop shell's patched `fs` can see inside it; SQLite's dlopen is not
 *     routed through that shim, so it walks the real filesystem and gets
 *     ENOTDIR at the archive segment.
 *
 * The archive case is invisible to `isPackagedBinary()` (`process.pkg` is
 * undefined in a normal Electron install), which is why it took the failing
 * branch. The gate is keyed on the PATH for both — see `isInsideAppArchive`.
 *
 * Fix: copy the extension out to a real path under `<dataDir>/native/` and load
 * it from there. The copy is idempotent — re-copied only when the on-disk size
 * differs (an upgrade), so warm starts pay nothing.
 *
 * `dbPath` is `<dataDir>/wigolo.db`, so the sibling `native/` dir is the data
 * dir; no config dependency is pulled into the cache layer.
 */
function loadVecExtension(db: Database.Database, dbPath: string): void {
  // The path SQLite would be handed. Ask it about itself rather than asking the
  // process what it is: `process.pkg` cannot see an archive, and an archive path
  // can also arrive in a plain-Node child that has no shim at all.
  const sourcePath = sv.getLoadablePath();
  const insideArchive = isInsideAppArchive(sourcePath);

  if (!isPackagedBinary() && !insideArchive) {
    sv.load(db);
    return;
  }

  const nativeDir = join(dirname(dbPath), 'native');
  const realPath = join(nativeDir, basename(sourcePath));

  mkdirSync(nativeDir, { recursive: true });

  let needsCopy = true;
  try {
    const src = statSync(sourcePath);
    const dst = statSync(realPath);
    needsCopy = src.size !== dst.size;
  } catch {
    // Destination missing (first run) — copy.
    needsCopy = true;
  }
  if (needsCopy) {
    try {
      copyFileSync(sourcePath, realPath);
    } catch (err) {
      // Do not let the raw ENOTDIR through. Unreadable-because-archived is a
      // PACKAGING defect with a specific remedy, and the OS-level wording sends
      // whoever reads it to reinstall instead — the exact misdiagnosis this
      // branch exists to prevent.
      throw new Error(archiveCopyFailureMessage(sourcePath, insideArchive, err));
    }
  }

  // Load the exact extracted file. Passing the full, existing `.dylib`/`.so`
  // path stops SQLite from appending its own suffix (the doubled `.dylib.dylib`
  // seen under /snapshot). No entrypoint override — sqlite-vec's default init
  // symbol resolves from the filename, matching `sv.load`'s behaviour.
  db.loadExtension(realPath);
}

/**
 * Name the real cause when the extension cannot be copied out to a real path.
 *
 * Reading a file out of an app archive needs the desktop shell's patched `fs`.
 * The cache DB deliberately runs in a plain-Node child (better-sqlite3 is built
 * for the Node ABI, not the desktop shell's), and that child has NO shim — so an
 * archived extension is not merely awkward there, it is unreachable, and copying
 * out cannot rescue it. The only fix is to publish the file outside the archive,
 * so that is what the message asks for.
 */
function archiveCopyFailureMessage(sourcePath: string, insideArchive: boolean, err: unknown): string {
  const cause = err instanceof Error ? err.message : String(err);
  if (!insideArchive) {
    return `could not extract the vector search extension from ${sourcePath} to a real path: ${cause}`;
  }
  return (
    `the vector search extension is packaged INSIDE a desktop application archive ` +
    `(${sourcePath}) and cannot be read from there: ${cause}. ` +
    `An archive is a single file, so neither the database engine's library loader nor a ` +
    `plain background process can see into it. This is a packaging problem, not a broken ` +
    `install — reinstalling will not change it. Add the extension to the packaging step's ` +
    `unpacked-files list (electron-builder: "asarUnpack") so it ships as a real file on disk.`
  );
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
let exitHookRegistered = false;

export function isVecExtensionLoaded(): boolean {
  return getVecExtensionStatus().loaded;
}

// Register a process-exit guard so any CLI command that opens the DB closes it
// deterministically instead of leaving it to native teardown order.
//
// This hook does NOT prevent the `mutex lock failed: Invalid argument` abort,
// and the "better-sqlite3 + sqlite-vec destructor race" this comment used to
// name as the cause is not supported by measurement: a process that opens a
// DB, loads the vector extension, runs a query and exits WITHOUT closing it
// terminates cleanly (macOS/arm64, plain Node). If that race were the
// mechanism, the unclosed case is where it would fire.
//
// What the real cause is remains OPEN — the abort was reported from doctor and
// warmup, which load several other native modules, and it did not reproduce
// under a bare require of any of them either. Deliberately not guessed at again
// here: the previous guess is what sent people looking at this hook, and a
// named-but-wrong cause is more expensive than an admitted unknown. The hook is
// kept because closing the handle you opened is right regardless of the abort.
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

export interface InitDatabaseOptions {
  /**
   * Whether this process OWNS the schema of the file it is opening.
   *
   * `true` (default) is the historic behaviour: create the inline schema and
   * run the migration registry, so the caller's build defines the file's shape.
   *
   * `false` opens the SAME file for data reads and writes but applies NO schema
   * statements at all — no inline `CREATE TABLE`, no embedding-column
   * `ALTER TABLE`, no migration runner, and no `journal_mode` change. It is for
   * an EMBEDDED core opening a cache file another core owns: the extraction
   * design pins "only the external core runs migrations on the shared cache;
   * the app NEVER migrates a DB it paired into", and until this option existed
   * every embedded consumer violated that pin by construction, because
   * `initDatabase` was the only way in.
   *
   * A non-owning caller is expected to probe {@link readSchemaHead} first and
   * refuse to pair on skew, rather than repair the file it found.
   */
  migrate?: boolean;
}

export function initDatabase(dbPath: string, opts: InitDatabaseOptions = {}): Database.Database {
  const migrate = opts.migrate !== false;

  if (instance) {
    instance.close();
    instance = null;
  }

  const db = new Database(dbPath);

  // Lock the DB file down before any write. In-memory DBs have no file.
  //
  // Done on the non-owning path too: this only ever TIGHTENS the mode, changes
  // no byte of the file's content, and the file holds session-bearing clearance
  // tokens whichever core opened it. It is a permission floor, not schema.
  const isFileBacked = dbPath !== ':memory:' && dbPath !== '';
  if (isFileBacked) restrictMode(dbPath);

  if (migrate) {
    db.pragma('journal_mode = WAL');
  } else {
    // `journal_mode = WAL` REWRITES the database header when the file is not
    // already in WAL, which is a structural write to a file we do not own. Read
    // the mode instead and let the owner decide; a non-WAL shared cache is
    // slower and more contended, not broken.
    const mode = String((db.pragma('journal_mode', { simple: true }) as unknown) ?? '').toLowerCase();
    if (mode !== 'wal') {
      log.warn('paired cache DB is not in WAL mode — leaving it alone (owner core sets journal mode)', {
        journalMode: mode,
      });
    }
  }
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
    recordVecLoaded();
  } catch (err) {
    // Always report WHICH file could not be loaded and whether it is archived.
    // Without those two fields the warning reads as a generic missing-library
    // error and a packaging defect gets reported as "the install is broken".
    let extensionPath: string | undefined;
    try {
      extensionPath = sv.getLoadablePath();
    } catch {
      // sqlite-vec cannot even name its own artifact (unsupported platform).
    }
    // The path is what makes the diagnosis decidable — an archived artifact is a
    // packaging defect with a specific remedy, a musl host is a permanent
    // platform gap, and the loader's own error distinguishes neither.
    const status = recordVecFailure(err, extensionPath);
    log.warn('sqlite-vec extension failed to load — vector search disabled', {
      reason: status.reason,
      summary: status.summary,
      consequence: status.consequence,
      error: status.detail,
      extensionPath,
      insideAppArchive: extensionPath ? isInsideAppArchive(extensionPath) : undefined,
    });
  }

  // Non-owning open: everything below this point writes schema. Stop here so
  // the file is returned exactly as it was found — see InitDatabaseOptions.
  if (!migrate) {
    if (isFileBacked) {
      restrictMode(`${dbPath}-wal`);
      restrictMode(`${dbPath}-shm`);
    }
    instance = db;
    ensureExitHookRegistered();
    return db;
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
    applyMigrations(db, { vecLoaded: isVecExtensionLoaded() });
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

/**
 * Whether a cache DB is currently open in this process. Distinct from
 * {@link probeCacheDb}: this asks only "would getDatabase() succeed", with no query, so a
 * best-effort writer can skip its work in a process that never opened the cache (a pure-helper
 * unit test, a CLI path that touches no DB) instead of throwing into a swallow.
 */
export function isDatabaseInitialized(): boolean {
  return instance !== null;
}

export function closeDatabase(): void {
  if (instance) {
    instance.close();
    instance = null;
    recordVecClosed();
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

/**
 * A cache DB's migration state, read WITHOUT opening the file for write.
 *
 * The migration registry is not name-ordered (`010-studio-audit` is registered
 * before `008-antibot-clearance`, and two migrations share number 013), so
 * "head" is not a number two builds can compare with `<`. The decidable
 * comparison is set containment, which is what {@link pending} and
 * {@link unknown} carry:
 *
 *   - `pending` non-empty  → the file is BEHIND this build. An owner core would
 *                            write to it; a paired non-owner must refuse
 *                            ("update wigolo") rather than repair it.
 *   - `unknown` non-empty  → the file is AHEAD of this build; something newer
 *                            owns it.
 *   - both empty           → the schemas agree.
 */
export interface SchemaHead {
  /** Applied migration names: registry order first, then names this build does not know. */
  applied: string[];
  /** Last applied migration in registry order — a label for logs, not an ordinal. */
  head: string | null;
  /** Registry entries the file does not have. */
  pending: string[];
  /** Names in the file that this build's registry does not contain. */
  unknown: string[];
  /** True when the file has no `schema_migrations` table at all. */
  uninitialized: boolean;
}

/**
 * Read a cache DB's schema state before deciding who owns it.
 *
 * Opens read-only, so no schema statement can run even by accident — the
 * connection would reject the write rather than rely on this module's own
 * branching. Pair this with `initDatabase(path, { migrate: false })`: probe
 * first, refuse on skew, and only then open the file you did not create.
 *
 * SQLite may still create a `-shm` sidecar next to a WAL database to read it,
 * which needs a writable DIRECTORY. That touches no byte of the database file.
 */
export function readSchemaHead(dbPath: string): SchemaHead {
  if (!existsSync(dbPath)) {
    throw new Error(`no cache database at ${dbPath} — nothing to read a schema head from`);
  }

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const registry = MIGRATIONS.map(m => m.name);

    const hasTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
      .get() as { name: string } | undefined;
    if (!hasTable) {
      return { applied: [], head: null, pending: registry, unknown: [], uninitialized: true };
    }

    const rows = db.prepare('SELECT name FROM schema_migrations').all() as Array<{ name: string }>;
    const found = new Set(rows.map(r => r.name));
    const known = new Set(registry);

    const applied = registry.filter(name => found.has(name));
    const pending = registry.filter(name => !found.has(name));
    const unknown = [...found].filter(name => !known.has(name)).sort();

    return {
      applied: [...applied, ...unknown],
      head: applied.length > 0 ? (applied[applied.length - 1] ?? null) : null,
      pending,
      unknown,
      uninitialized: false,
    };
  } finally {
    db.close();
  }
}
