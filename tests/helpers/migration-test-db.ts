import Database from 'better-sqlite3';

/**
 * Open a real on-disk SQLite DB for a migration test with DURABILITY turned off —
 * and nothing else changed.
 *
 * Why this exists (K27). `applyMigrations` wraps EACH migration in its own
 * transaction, so one pass costs `N_migrations` top-level commits — 18 today, and
 * `N_migrations` only ever grows. A bare `new Database(<file>)` runs SQLite's
 * defaults, `journal_mode=delete` + `synchronous=FULL`, so every one of those
 * commits creates a `<db>-journal` sidecar, fsyncs, and deletes it again. On a
 * Windows CI runner writing into `%TEMP%` — where a create/delete pair is also an
 * on-access scan — that per-commit file-op latency is the whole cost, and the
 * three body-level migration suites crossed the 20 s `testTimeout` on it twice
 * with no causal diff.
 *
 * What this changes and what it deliberately does not:
 *
 * - `journal_mode = MEMORY` keeps the rollback journal in RAM. No sidecar is ever
 *   written, so the per-commit file-op term goes to zero. **ROLLBACK still works** —
 *   the journal exists, it is just not on disk. Only durability across a process
 *   crash is given up, and no test asserts that.
 * - `synchronous = OFF` drops the fsync on commit. Same trade: durability only.
 * - It is NOT `journal_mode = OFF`. That one deletes the rollback journal
 *   altogether and SQLite documents ROLLBACK as undefined under it. Measured
 *   honestly: "undefined" includes "happens to work", and the rollback tests in
 *   `migration-test-db.test.ts` still pass when the mode is switched to OFF. What
 *   actually stops the substitution landing is the pragma assertion in that file,
 *   which reds on it — so the pin is the reported mode, not an observed rollback.
 * - It does NOT batch, wrap or otherwise touch how `applyMigrations` commits.
 *   In these suites `applyMigrations` is the subject — idempotency on re-run,
 *   read-only fail-soft, merge-union convergence — and an outer transaction would
 *   change the rollback semantics under test. The per-commit *cost* is harness
 *   overhead; the per-migration *commit* is the thing being tested, and it is
 *   still there, one per migration, exactly as in production.
 *
 * Both pragmas are connection-level, not file-level: reopening the same path with
 * a plain `new Database(path)` (as the read-only fail-soft tests do) is unaffected.
 *
 * Do not use this for anything asserting on-disk durability, journal layout or WAL
 * sidecars — `src/cache/db.ts` opens production DBs with WAL + `synchronous=NORMAL`
 * and tests of THAT belong on `initDatabase`, not here.
 */
export function openMigrationTestDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = MEMORY');
  db.pragma('synchronous = OFF');
  return db;
}
