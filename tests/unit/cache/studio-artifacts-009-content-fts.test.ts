import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { applyMigrations, _resetMigrationGuard, MIGRATIONS } from '../../../src/cache/migrations/runner.js';

/**
 * Phase 4b-1 — migration 009 RED: content columns (title / markdown / metadata /
 * created_at) on studio_artifacts + studio_artifacts_fts (external-content FTS5) +
 * the FTS sync triggers. Exercised DIRECTLY via raw SQL — there is NO production
 * capture/insert path, hash helper, trust-by-path, or embed enqueue yet (those are
 * 4b-2 / 4b-3 and get their own REDs). This beat is schema + FTS only.
 *
 * RIGHT-REASON: migration 009 is NOT written this beat. 008 IS applied (so the
 * beforeEach session seed succeeds), but studio_artifacts has only its 008 columns
 * and studio_artifacts_fts does not exist. Every case fails because THE 009 SCHEMA
 * IS ABSENT — "no such column: title/markdown/created_at", "no such table:
 * studio_artifacts_fts", a missing AFTER UPDATE trigger, or the 009 entry missing
 * from MIGRATIONS — not a test bug.
 *
 * created_at (C#1, signed off): a CONSTANT-sentinel column default, NOT the
 * (datetime('now')) expression — so 009 has NO empty-table dependency and
 * insertArtifact (4b-3) sets created_at explicitly. B2 is the forcing pin: 009
 * applies on a SEEDED studio_artifacts table. A constant default succeeds with rows
 * present; the expression default raises "Cannot add a column with non-constant
 * default" (verified on the bundled SQLite 3.53.0). So B2 rejects a regression to
 * the expr default. (Per the sign-off, an expr default would instead require a
 * negative pin that 009-on-a-seeded-table RAISES; the constant default is the chosen
 * path, so B2 pins the positive property, which is strictly stronger.)
 *
 * au WHEN-guard (C#9): migration 009 keeps the AFTER UPDATE trigger's
 *   WHEN old.title IS NOT new.title OR old.markdown IS NOT new.markdown
 * guard (a curate-only UPDATE — curated_by_human 0→1, title/markdown unchanged — skips
 * the FTS delete+reinsert). It is NOT pinned here: the guard is behaviorally invisible
 * through MATCH (FTS stays correct either way), so a test could only assert its SQL
 * text — over-coupling to an impl detail of a correctness-neutral perf opt.
 *
 * Trigger timing/count (feed_items 3-trigger AFTER) is likewise a GREEN implementation
 * choice, NOT structurally pinned: the INSERT/UPDATE/DELETE sync behavior (C2/C3/C4) is
 * what matters and holds for the AFTER pattern; a brittle count/timing assertion would
 * over-couple.
 *
 * metadata is KEPT (C#8 "iff a named writer"): the named writer is 4b-3 mark capture,
 * which serializes the StructuredTarget selectors (fingerprint + ancestorPath + attrs)
 * as JSON into metadata — they don't fit title/markdown/url and must stay out of the
 * FTS-indexed columns, so the mark persists as a re-resolvable durable target.
 *
 * BOUNDARY: retrieval-time trust framing (data-not-instructions on surfaced results)
 * is 4d, NOT here — FTS indexes raw content verbatim.
 */

const FETCHED_AT = '2026-06-19T00:00:00.000Z';
const M009_PREFIX = '009-studio-artifacts';

describe('migration 009_studio_artifacts content — columns + created_at + FTS (raw-SQL RED)', () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    _resetMigrationGuard();
    dir = mkdtempSync(join(tmpdir(), 'wigolo-studio-4b1-'));
    db = new Database(join(dir, 'cache.db'));
    db.pragma('foreign_keys = ON');
    // ONE commit for the whole fixture. applyMigrations wraps each migration in its
    // own transaction, so a bare `new Database(<file>)` — journal_mode=delete +
    // synchronous=FULL, unlike production's WAL+NORMAL — pays a journal
    // create+fsync+delete 16 times per test (14 migrations + the schema_migrations
    // DDL + this seed). The outer transaction demotes those to SAVEPOINTs. What each
    // case asserts is the SCHEMA these migrations leave behind; the number of
    // transactions used to reach it carries none of that meaning.
    db.transaction(() => {
      applyMigrations(db, { vecLoaded: false });
      // 008 is applied, so studio_sessions exists and this seed succeeds. Artifacts
      // reference this row (FK, NOT NULL session_id from 008).
      db.prepare('INSERT OR IGNORE INTO studio_sessions (id) VALUES (?)').run('sess');
    })();
  });

  afterEach(() => {
    try { db.close(); } catch { /* ignore */ }
    try { chmodSync(dir, 0o700); } catch { /* ignore */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // Test-local raw-SQL insert (NOT the production capture path — that is 4b-3).
  // Always supplies the 008 NOT NULL columns; the content columns are added only
  // when their key is present, so a test can omit created_at (default fires) or
  // supply it (verbatim). normalized_url = url verbatim (no normalize helper this
  // beat — that is 4b-3, card 5).
  function insertContent(
    row: {
      type?: string; url?: string | null; hash?: string;
      title?: string | null; markdown?: string | null; metadata?: string | null;
      createdAt?: string | null; session?: string;
    },
    opts: { ignore?: boolean } = {},
  ): Database.RunResult {
    const verb = opts.ignore ? 'INSERT OR IGNORE' : 'INSERT';
    const cols = ['session_id', 'artifact_type', 'url', 'normalized_url', 'content_hash', 'fetched_at'];
    const vals: Array<string | number | null> = [
      row.session ?? 'sess', row.type ?? 'clip', row.url ?? null, row.url ?? null, row.hash ?? 'h', FETCHED_AT,
    ];
    if ('title' in row) { cols.push('title'); vals.push(row.title ?? null); }
    if ('markdown' in row) { cols.push('markdown'); vals.push(row.markdown ?? null); }
    if ('metadata' in row) { cols.push('metadata'); vals.push(row.metadata ?? null); }
    if ('createdAt' in row) { cols.push('created_at'); vals.push(row.createdAt ?? null); }
    return db.prepare(
      `${verb} INTO studio_artifacts (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    ).run(...vals);
  }

  const ftsCount = (q: string): number =>
    (db.prepare('SELECT COUNT(*) AS n FROM studio_artifacts_fts WHERE studio_artifacts_fts MATCH ?')
      .get(q) as { n: number }).n;

  describe('content columns + created_at', () => {
    it('A1 adds title/markdown/metadata (nullable TEXT) + created_at (NOT NULL, with a default)', () => {
      const cols = db.prepare("PRAGMA table_info('studio_artifacts')").all() as Array<{
        name: string; type: string; notnull: number; dflt_value: string | null;
      }>;
      const by = (n: string) => cols.find((c) => c.name === n);
      for (const n of ['title', 'markdown', 'metadata']) {
        const c = by(n);
        expect(c, `column ${n} must exist`).toBeDefined();
        expect(c!.type).toBe('TEXT');
        expect(c!.notnull, `${n} is nullable`).toBe(0);
      }
      const created = by('created_at');
      expect(created, 'created_at must exist').toBeDefined();
      expect(created!.type).toBe('TEXT');
      expect(created!.notnull, 'created_at is NOT NULL').toBe(1);
      // ADD COLUMN of a NOT NULL column is only legal with a non-NULL default.
      expect(created!.dflt_value, 'created_at needs a default').not.toBeNull();
    });

    it('A2 created_at: an insert that omits it is accepted and reads non-null (sentinel default fires)', () => {
      insertContent({ type: 'clip', url: 'https://x/a', hash: 'hca2' });
      const row = db.prepare('SELECT created_at FROM studio_artifacts WHERE content_hash = ?')
        .get('hca2') as { created_at: string | null };
      expect(row.created_at).not.toBeNull();
      expect(typeof row.created_at).toBe('string');
    });

    it('A3 created_at recent after a real insert: an explicit value is stored verbatim', () => {
      const ts = '2026-06-20T12:34:56.000Z';
      insertContent({ type: 'note', url: null, hash: 'hca3', createdAt: ts });
      const row = db.prepare('SELECT created_at FROM studio_artifacts WHERE content_hash = ?')
        .get('hca3') as { created_at: string };
      expect(row.created_at).toBe(ts);
    });
  });

  describe('migration application', () => {
    it('B1 009 is registered and applied (clean on the empty, as-shipped 008 DB)', () => {
      const applied = db.prepare('SELECT name FROM schema_migrations').all() as Array<{ name: string }>;
      expect(applied.some((m) => m.name.startsWith(M009_PREFIX)), '009 must be registered + applied').toBe(true);
    });

    it('B2 009 applies clean on a SEEDED 008 table (constant default — no empty-table dependency)', () => {
      // Build the 008 schema directly, seed a studio_artifacts row, THEN apply 009.
      // A constant-sentinel default lets ADD COLUMN created_at succeed with rows
      // present; the (datetime('now')) expression default raises "Cannot add a column
      // with non-constant default" here. This is the pin that rejects the expr default.
      const seeded = new Database(':memory:');
      try {
        seeded.pragma('foreign_keys = ON');
        const m008 = MIGRATIONS.find((m) => m.name === '008-studio-artifacts');
        expect(m008, '008 must be registered').toBeDefined();
        seeded.exec(m008!.sql);
        seeded.prepare('INSERT INTO studio_sessions (id) VALUES (?)').run('s');
        seeded.prepare(
          'INSERT INTO studio_artifacts (session_id, artifact_type, content_hash, fetched_at) VALUES (?,?,?,?)',
        ).run('s', 'note', 'hseed', FETCHED_AT);

        const m009 = MIGRATIONS.find((m) => m.name.startsWith(M009_PREFIX));
        expect(m009, '009 migration must be registered').toBeDefined();
        expect(() => {
          seeded.transaction(() => { seeded.exec(m009!.sql); m009!.postStep?.(seeded); })();
        }).not.toThrow();

        const row = seeded.prepare('SELECT created_at FROM studio_artifacts WHERE content_hash = ?')
          .get('hseed') as { created_at: string | null };
        expect(row.created_at, 'the pre-existing row gets the sentinel default').not.toBeNull();
      } finally {
        seeded.close();
      }
    });

    it('B3 009 is idempotent: re-running its sql+postStep does not throw (table_info guards)', () => {
      // 009 already ran in beforeEach. A direct re-run must be a no-op: ADD COLUMN has
      // no IF NOT EXISTS, so the postStep must table_info-guard each column.
      const m009 = MIGRATIONS.find((m) => m.name.startsWith(M009_PREFIX));
      expect(m009, '009 migration must be registered').toBeDefined();
      expect(() => {
        db.transaction(() => { db.exec(m009!.sql); m009!.postStep?.(db); })();
      }).not.toThrow();
    });
  });

  describe('studio_artifacts_fts — external-content sync triggers', () => {
    it('C1 the studio_artifacts_fts virtual table exists', () => {
      const t = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='studio_artifacts_fts'",
      ).get();
      expect(t, 'studio_artifacts_fts must exist').toBeDefined();
    });

    it('C2 INSERT sync: a captured row is immediately findable via FTS MATCH', () => {
      insertContent({ type: 'clip', url: 'https://x/a', hash: 'hf2', title: 'alpha', markdown: 'hello world' });
      expect(ftsCount('hello')).toBe(1);
      expect(ftsCount('alpha')).toBe(1);
    });

    it('C3 UPDATE sync: editing markdown re-indexes — new text matches, old does not', () => {
      const res = insertContent({ type: 'clip', url: 'https://x/a', hash: 'hf3', title: 'alpha', markdown: 'hello world' });
      db.prepare('UPDATE studio_artifacts SET markdown = ? WHERE id = ?').run('goodbye moon', Number(res.lastInsertRowid));
      expect(ftsCount('goodbye')).toBe(1);
      expect(ftsCount('hello')).toBe(0);
    });

    it('C4 DELETE sync (external-content footgun): delete removes it from FTS with no corruption', () => {
      const res = insertContent({ type: 'clip', url: 'https://x/a', hash: 'hf4', title: 'alpha', markdown: 'hello world' });
      expect(ftsCount('hello')).toBe(1);
      db.prepare('DELETE FROM studio_artifacts WHERE id = ?').run(Number(res.lastInsertRowid));
      expect(ftsCount('hello')).toBe(0);
      // A later MATCH must execute cleanly. A missing ('delete', …) command in the
      // BEFORE/AFTER DELETE trigger leaves a dangling external-content entry that
      // corrupts subsequent queries ("database disk image is malformed").
      expect(() => ftsCount('alpha')).not.toThrow();
    });

    it('C5 OR-IGNORE dedup hit does not double-index (ai fires only on a real insert)', () => {
      insertContent({ type: 'clip', url: 'https://x/a', hash: 'hf5', title: 'alpha', markdown: 'hello world' });
      // Same (normalized_url, artifact_type, content_hash) → ignored by idx_studio_artifacts_url.
      insertContent({ type: 'clip', url: 'https://x/a', hash: 'hf5', title: 'beta', markdown: 'hello mars' }, { ignore: true });
      const rows = (db.prepare('SELECT COUNT(*) AS n FROM studio_artifacts WHERE content_hash = ?')
        .get('hf5') as { n: number }).n;
      expect(rows, 'the duplicate insert was ignored').toBe(1);
      expect(ftsCount('hello'), 'one FTS row, not two').toBe(1);
      expect(ftsCount('beta'), 'the ignored insert never reached FTS').toBe(0);
    });
  });
});
