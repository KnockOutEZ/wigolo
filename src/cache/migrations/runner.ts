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

// Phase 4a: Interactive Browser Studio capture schema — creates BOTH durable
// Studio tables, parent first so the artifacts FK resolves: studio_sessions (the
// session origin) THEN studio_artifacts (captured marks/clips/notes/qa, deduped
// per type via symmetric partial unique indexes). Schema only — no FTS5/triggers/
// insert path yet (later slices, each behind their own tests). Mirrored in
// 008-studio-artifacts.sql.
const MIGRATION_008_STUDIO_ARTIFACTS = `
CREATE TABLE IF NOT EXISTS studio_sessions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS studio_artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES studio_sessions(id),
  artifact_type TEXT NOT NULL,
  url TEXT,
  normalized_url TEXT,
  content_hash TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  curated_by_human INTEGER NOT NULL DEFAULT 0,
  content_trusted INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_studio_artifacts_url
  ON studio_artifacts(normalized_url, artifact_type, content_hash)
  WHERE normalized_url IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_studio_artifacts_nourl
  ON studio_artifacts(artifact_type, content_hash)
  WHERE normalized_url IS NULL;
`;

// Phase 4b-1: Studio capture content columns + searchable FTS index. Adds title /
// markdown / metadata / created_at to studio_artifacts (008) + an external-content
// studio_artifacts_fts with sync triggers. SQL is empty — the whole effect is in the
// postStep, columns-before-triggers, gated on pragma table_info so ADD COLUMN (no
// `IF NOT EXISTS` in SQLite) stays idempotent. created_at uses a CONSTANT sentinel
// default so ADD COLUMN succeeds even on a non-empty table (a non-constant default
// raises "Cannot add a column with non-constant default"). Mirrored in
// 009-studio-artifacts-content.sql.
const MIGRATION_009_STUDIO_ARTIFACTS_CONTENT = '';

// Phase 6b: durable per-session audit log of every agent action. Metadata-only by construction
// (no raw typed text — the in-memory AuditEntry never carries it; only `outcome_chars_landed`).
// session_id FKs studio_sessions (008, parent). The (session_id, seq) unique index gives the stable
// replay order + makes the sole-writer INSERT idempotent on re-append. INSERT-only — no UPDATE/DELETE
// anywhere. Mirrored in 010-studio-audit.sql.
const MIGRATION_010_STUDIO_AUDIT = `
CREATE TABLE IF NOT EXISTS studio_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES studio_sessions(id),
  seq INTEGER NOT NULL,
  action TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  target_url TEXT,
  target_ref TEXT,
  target_direction TEXT,
  target_amount REAL,
  outcome_ok INTEGER NOT NULL,
  outcome_error_reason TEXT,
  outcome_chars_landed INTEGER,
  risk TEXT,
  approval TEXT,
  ts INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_studio_audit_session_seq
  ON studio_audit(session_id, seq);
`;

// D10: non-studio tool-invocation audit log. An append-only forensic record of every NON-studio_*
// MCP tool call (tool, privacy-projected args_meta, outcome, duration). A STANDALONE table — NOT
// studio_audit (010), whose session_id NOT-NULL FK + studio-shaped columns don't fit a session-less
// stdio tool call. INSERT-only: the sole writer (src/server/tool-audit.ts) never UPDATEs/DELETEs.
// Mirrored in 011-tool-audit.sql.
//
// KNOWN, ACCEPTED LEAK — product-named tables in the shared DB, and the cost it has already charged.
// `studio_sessions`, `studio_artifacts`, `studio_artifacts_fts` and `studio_audit` carry a product
// name in a store every surface shares, and `studio_artifacts` holds a NOT-NULL FK to a
// product-named parent. THIS TABLE IS THE BILL: a session-less tool-call record could not reuse
// `studio_audit`, so D10 paid for a second audit table rather than one generic one. A second surface
// wanting an audit trail pays it again.
//   NOT FIXED ON PURPOSE. D15 locks migration names and rename-nothing: renaming a shipped table or
// migration is a data-integrity bug on every machine that already ran them, which costs strictly more
// than the duplication. The read paths that used to hardcode these names no longer do — core reaches
// them through `src/cache/artifact-registry.ts` — so the leak is now confined to the schema, where a
// future migration can address it deliberately with a data-migration plan attached.
const MIGRATION_011_TOOL_AUDIT = `
CREATE TABLE IF NOT EXISTS tool_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tool TEXT NOT NULL,
  args_meta TEXT,
  outcome_ok INTEGER NOT NULL,
  error_reason TEXT,
  ts INTEGER NOT NULL,
  duration_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_tool_audit_ts ON tool_audit(ts);
CREATE INDEX IF NOT EXISTS idx_tool_audit_tool ON tool_audit(tool);
`;
// Anti-bot clearance columns on domain_routing. The base table is created
// inline in src/cache/db.ts; the CREATE here is the safety net for raw
// callers. ALTERs live in the postStep (guarded by table_info) since SQLite
// has no `ADD COLUMN IF NOT EXISTS` and an unguarded ALTER blows up on re-run.
const MIGRATION_008_ANTIBOT_CLEARANCE = `
CREATE TABLE IF NOT EXISTS domain_routing (
  domain TEXT PRIMARY KEY,
  prefer_playwright INTEGER DEFAULT 0,
  http_failures INTEGER DEFAULT 0,
  last_updated TEXT
);
`;

const ANTIBOT_CLEARANCE_COLUMNS = [
  'cf_clearance',
  'clearance_ua',
  'clearance_tier',
  'clearance_expires_at',
  'backoff_until',
  'last_403_at',
];

// Nullable content-completeness columns on url_cache so a cache hit can be
// re-classified stale when the cached capture was only a shell. Empty SQL —
// the whole effect is the guarded ADD COLUMNs in the postStep (mirrors 006).
const MIGRATION_009_CONTENT_COMPLETENESS = '';

const CONTENT_COMPLETENESS_COLUMNS = [
  'content_completeness_level',
  'content_completeness_reason',
  'content_completeness_settled_by',
];

// Nullable route-identity column on domain_routing. A cf_clearance is bound to
// the {IP + UA + TLS} of the egress it was solved on, so a clearance harvested
// on one route (proxy-or-direct) is invalid from another. `solved_route`
// records that egress at harvest; legacy rows read NULL → 'direct'. Empty SQL —
// the whole effect is the guarded ADD COLUMN in the postStep (mirrors 008).
const MIGRATION_010_CLEARANCE_ROUTE = '';

// Index url_cache.content_hash so `diff`'s `old.content_hash` reverse lookup is
// an index seek instead of a scan of every cached page body. NOT UNIQUE — two
// URLs serving identical markdown share a hash by design. Empty SQL: url_cache
// is created inline by initDatabase(), which the runner-only harness skips, and
// CREATE INDEX on a missing table throws (mirrors the 006/009 guard).
const MIGRATION_012_URL_CACHE_CONTENT_HASH_INDEX = '';

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
  { name: '008-studio-artifacts', sql: MIGRATION_008_STUDIO_ARTIFACTS },
  {
    name: '009-studio-artifacts-content',
    sql: MIGRATION_009_STUDIO_ARTIFACTS_CONTENT,
    postStep: (db) => {
      // studio_artifacts is created by 008, which runs earlier in this same pass.
      // Guard for a bare runner-only harness where it might be absent (mirrors 006).
      const cols = db.pragma('table_info(studio_artifacts)') as Array<{ name: string }>;
      if (cols.length === 0) return;
      const names = new Set(cols.map((c) => c.name));
      // ADD COLUMN has no `IF NOT EXISTS` — gate each on table_info for idempotency.
      if (!names.has('title')) db.exec('ALTER TABLE studio_artifacts ADD COLUMN title TEXT');
      if (!names.has('markdown')) db.exec('ALTER TABLE studio_artifacts ADD COLUMN markdown TEXT');
      if (!names.has('metadata')) db.exec('ALTER TABLE studio_artifacts ADD COLUMN metadata TEXT');
      // CONSTANT sentinel default (not (datetime('now'))) so ADD COLUMN succeeds even
      // with rows present; insertArtifact (4b-3) sets created_at explicitly.
      if (!names.has('created_at')) {
        db.exec("ALTER TABLE studio_artifacts ADD COLUMN created_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'");
      }
      // External-content FTS5 + sync triggers (feed_items AFTER pattern). The columns
      // are added above first, so the triggers' column references resolve.
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS studio_artifacts_fts USING fts5(
          title,
          markdown,
          content='studio_artifacts',
          content_rowid='id'
        );

        CREATE TRIGGER IF NOT EXISTS studio_artifacts_ai AFTER INSERT ON studio_artifacts BEGIN
          INSERT INTO studio_artifacts_fts(rowid, title, markdown) VALUES (new.id, new.title, new.markdown);
        END;

        CREATE TRIGGER IF NOT EXISTS studio_artifacts_ad AFTER DELETE ON studio_artifacts BEGIN
          INSERT INTO studio_artifacts_fts(studio_artifacts_fts, rowid, title, markdown) VALUES('delete', old.id, old.title, old.markdown);
        END;

        CREATE TRIGGER IF NOT EXISTS studio_artifacts_au AFTER UPDATE ON studio_artifacts
          WHEN old.title IS NOT new.title OR old.markdown IS NOT new.markdown
        BEGIN
          INSERT INTO studio_artifacts_fts(studio_artifacts_fts, rowid, title, markdown) VALUES('delete', old.id, old.title, old.markdown);
          INSERT INTO studio_artifacts_fts(rowid, title, markdown) VALUES (new.id, new.title, new.markdown);
        END;
      `);
      // Index any rows that predate the triggers (none on the forward path; defensive
      // + covers a seeded table).
      db.exec(`INSERT INTO studio_artifacts_fts(studio_artifacts_fts) VALUES('rebuild')`);
    },
  },
  { name: '010-studio-audit', sql: MIGRATION_010_STUDIO_AUDIT },
  { name: '011-tool-audit', sql: MIGRATION_011_TOOL_AUDIT },
  {
    name: '008-antibot-clearance',
    sql: MIGRATION_008_ANTIBOT_CLEARANCE,
    /**
     * Adds the anti-bot clearance columns to domain_routing, skipping any
     * that already exist (idempotent) — mirrors the 005 postStep pattern.
     */
    postStep: (db) => {
      const cols = db.pragma('table_info(domain_routing)') as Array<{ name: string }>;
      const names = new Set(cols.map((c) => c.name));
      for (const col of ANTIBOT_CLEARANCE_COLUMNS) {
        if (!names.has(col)) {
          db.exec(`ALTER TABLE domain_routing ADD COLUMN ${col} TEXT`);
        }
      }
    },
  },
  {
    name: '009-content-completeness',
    sql: MIGRATION_009_CONTENT_COMPLETENESS,
    /**
     * Adds the nullable content-completeness columns to url_cache, skipping any
     * that already exist (idempotent) — mirrors the 006 postStep. url_cache is
     * created inline by initDatabase(); the runner-only harness skips that, so
     * guard on an empty table_info (no table → no-op, column arrives with the
     * table on the next initDatabase).
     */
    postStep: (db) => {
      const cols = db.pragma('table_info(url_cache)') as Array<{ name: string }>;
      if (cols.length === 0) return;
      const names = new Set(cols.map((c) => c.name));
      for (const col of CONTENT_COMPLETENESS_COLUMNS) {
        if (!names.has(col)) {
          db.exec(`ALTER TABLE url_cache ADD COLUMN ${col} TEXT`);
        }
      }
    },
  },
  {
    name: '010-clearance-route',
    sql: MIGRATION_010_CLEARANCE_ROUTE,
    /**
     * Adds the nullable route-identity column to domain_routing, skipping it if
     * already present (idempotent) — mirrors the 008 postStep. SQLite has no
     * `ADD COLUMN IF NOT EXISTS`, so we guard on PRAGMA table_info.
     */
    postStep: (db) => {
      const cols = db.pragma('table_info(domain_routing)') as Array<{ name: string }>;
      const names = new Set(cols.map((c) => c.name));
      if (!names.has('solved_route')) {
        db.exec('ALTER TABLE domain_routing ADD COLUMN solved_route TEXT');
      }
    },
  },
  {
    name: '012-url-cache-content-hash-index',
    sql: MIGRATION_012_URL_CACHE_CONTENT_HASH_INDEX,
    /**
     * Creates the content_hash index on url_cache. Guarded on the COLUMN, not
     * just the table: CREATE INDEX throws both when url_cache is absent (a
     * runner-only harness skips initDatabase's inline schema) AND when it
     * exists without content_hash, and either throw aborts the whole migration
     * pass — including every migration queued behind this one. The column
     * check subsumes the missing-table case. `IF NOT EXISTS` keeps the exec
     * itself idempotent.
     */
    postStep: (db) => {
      const cols = db.pragma('table_info(url_cache)') as Array<{ name: string }>;
      if (!cols.some((c) => c.name === 'content_hash')) return;
      db.exec('CREATE INDEX IF NOT EXISTS idx_url_cache_content_hash ON url_cache(content_hash)');
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
