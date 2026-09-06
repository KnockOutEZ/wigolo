import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { applyMigrations, MIGRATIONS, _resetMigrationGuard } from '../../../src/cache/migrations/runner.js';
import { openMigrationTestDb } from '../../helpers/migration-test-db.js';

/**
 * SD10 / D11 — migration 034 makes the SHARED `studio_artifacts_fts` lifecycle recipe-aware.
 *
 * A recipe is a canonical extraction definition, not a document: it persists with `title`
 * populated, its JSON in `metadata`, and `markdown` NULL. Migration 009's triggers index every
 * title unconditionally, which leaves exactly two bad options for the private Studio half:
 *
 *  - leave the recipe indexed — it surfaces in `cache` / `find_similar` / `research` as if it
 *    were captured prose (the condition #448's A-441-1 forbids); or
 *  - delete the FTS entry after insert — then the generic AFTER DELETE / title-UPDATE trigger
 *    later issues a SECOND external-content 'delete' for a row the index no longer holds, and
 *    FTS5 raises `SQLITE_CORRUPT_VTAB`.
 *
 * So the exclusion has to live in the triggers themselves, which is what 034 does. These cases
 * pin the BEHAVIOUR (what MATCH, %_docsize and integrity-check report after each transition),
 * never the trigger SQL text — the same properties must hold however the triggers are spelled.
 *
 * RIGHT-REASON while 034 is unwritten: `MIGRATION_NAME` is absent from MIGRATIONS and 009's
 * triggers index the recipe, so the recipe-absence cases fail on a real indexed row rather than
 * on a harness bug.
 *
 * Every transition is followed by `integrity-check`, because that is the assertion the
 * double-delete failure mode actually trips: a MATCH-only test stays green while the index and
 * its content table have already diverged.
 */

const MIGRATION_NAME = '034-studio-artifacts-recipe-fts';

/** A term that appears in no other seeded row, so a MATCH hit is unambiguous. */
const TERM = 'zebrafish';

describe('migration 034 — recipe-aware studio_artifacts FTS lifecycle', () => {
  let dir: string;
  let db: Database.Database;
  let nextHash = 0;

  beforeEach(() => {
    _resetMigrationGuard();
    dir = mkdtempSync(join(tmpdir(), 'wigolo-sd466-'));
    db = openMigrationTestDb(join(dir, 'cache.db'));
    nextHash = 0;
  });

  afterEach(() => {
    try { db.close(); } catch { /* ignore */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  /**
   * Insert one artifact row the way the capture pipeline does. A recipe carries its canonical
   * JSON in `metadata` with `markdown` NULL — that shape is the point of the issue, so it is
   * seeded here rather than approximated with a prose row that merely claims the type.
   */
  function seed(type: string, title: string | null, markdown: string | null, metadata: string | null = null): number {
    db.prepare('INSERT OR IGNORE INTO studio_sessions (id) VALUES (?)').run('sess');
    const now = '2026-09-06T00:00:00.000Z';
    const info = db
      .prepare(
        `INSERT INTO studio_artifacts
           (session_id, artifact_type, url, normalized_url, content_hash, fetched_at,
            created_at, title, markdown, metadata, content_trusted, curated_by_human)
         VALUES ('sess', ?, NULL, NULL, ?, ?, ?, ?, ?, ?, 0, 0)`,
      )
      .run(type, `hash-${nextHash++}`, now, now, title, markdown, metadata);
    return Number(info.lastInsertRowid);
  }

  /** Rowids the FTS index returns for a term — the agent-visible surface of "is it indexed". */
  function matched(term: string): number[] {
    return (db.prepare('SELECT rowid FROM studio_artifacts_fts WHERE studio_artifacts_fts MATCH ?').all(term) as Array<{ rowid: number }>)
      .map((r) => r.rowid)
      .sort((a, b) => a - b);
  }

  /**
   * Rowids with a stored document size. MATCH alone cannot distinguish "not indexed" from
   * "indexed under different terms", and %_docsize is where an orphaned entry actually sits.
   */
  function docsized(): number[] {
    return (db.prepare('SELECT id FROM studio_artifacts_fts_docsize ORDER BY id').all() as Array<{ id: number }>)
      .map((r) => r.id);
  }

  /** Throws if the index and its content table have diverged. */
  function integrityCheck(): void {
    db.exec("INSERT INTO studio_artifacts_fts(studio_artifacts_fts) VALUES('integrity-check')");
  }

  it('is registered exactly once, after 009, and stays applied on re-run', () => {
    const names = MIGRATIONS.map((m) => m.name);
    expect(names.filter((n) => n === MIGRATION_NAME)).toHaveLength(1);
    // The postStep replaces triggers 009 created, so ordering is load-bearing, not cosmetic.
    expect(names.indexOf(MIGRATION_NAME)).toBeGreaterThan(names.indexOf('009-studio-artifacts-content'));

    applyMigrations(db, { vecLoaded: false });
    const applied = () =>
      (db.prepare('SELECT name FROM schema_migrations WHERE name = ?').all(MIGRATION_NAME) as unknown[]).length;
    expect(applied()).toBe(1);

    _resetMigrationGuard();
    applyMigrations(db, { vecLoaded: false });
    expect(applied()).toBe(1);
  });

  describe('lifecycle on a migrated database', () => {
    beforeEach(() => {
      applyMigrations(db, { vecLoaded: false });
    });

    it('indexes an ordinary artifact and never a recipe, by title or by document size', () => {
      const recipe = seed('recipe', `${TERM} canonical rows`, null, '{"selector":".price"}');
      const clip = seed('clip', `${TERM} pricing`, `# ${TERM}\n$20/mo`);

      // The recipe's title contains the term and its row exists — so an empty result here is the
      // trigger's exclusion, not a missing row or a tokenizer accident.
      expect(matched(TERM)).toEqual([clip]);
      expect(docsized()).toEqual([clip]);
      expect(docsized()).not.toContain(recipe);
      integrityCheck();
    });

    it('leaves FTS untouched when recipe metadata is curated or rewritten', () => {
      const recipe = seed('recipe', `${TERM} canonical rows`, null, '{"selector":".price"}');
      const clip = seed('clip', `${TERM} pricing`, 'body');
      const before = docsized();

      db.prepare('UPDATE studio_artifacts SET metadata = ? WHERE id = ?').run('{"selector":".cost"}', recipe);
      db.prepare('UPDATE studio_artifacts SET curated_by_human = 1 WHERE id = ?').run(recipe);

      expect(docsized()).toEqual(before);
      expect(matched(TERM)).toEqual([clip]);
      integrityCheck();
    });

    it('keeps a recipe absent when its own title is rewritten', () => {
      const recipe = seed('recipe', `${TERM} canonical rows`, null, '{}');

      db.prepare('UPDATE studio_artifacts SET title = ? WHERE id = ?').run(`${TERM} renamed rows`, recipe);

      expect(matched(TERM)).toEqual([]);
      expect(docsized()).toEqual([]);
      integrityCheck();
    });

    it('removes the indexed terms when an ordinary artifact becomes a recipe', () => {
      const clip = seed('clip', `${TERM} pricing`, 'body');
      expect(matched(TERM)).toEqual([clip]);

      db.prepare("UPDATE studio_artifacts SET artifact_type = 'recipe' WHERE id = ?").run(clip);

      expect(matched(TERM)).toEqual([]);
      expect(docsized()).toEqual([]);
      integrityCheck();
    });

    it('adds the terms when a recipe becomes an ordinary artifact', () => {
      const recipe = seed('recipe', `${TERM} canonical rows`, null, '{}');
      expect(matched(TERM)).toEqual([]);

      db.prepare("UPDATE studio_artifacts SET artifact_type = 'clip', markdown = ? WHERE id = ?")
        .run(`# ${TERM}`, recipe);

      expect(matched(TERM)).toEqual([recipe]);
      expect(docsized()).toEqual([recipe]);
      integrityCheck();
    });

    it('deletes a recipe row and an ordinary row without corrupting the index', () => {
      const recipe = seed('recipe', `${TERM} canonical rows`, null, '{}');
      const clip = seed('clip', `${TERM} pricing`, 'body');

      // The recipe delete is the SQLITE_CORRUPT_VTAB case: 009's trigger would issue an
      // external-content 'delete' for a rowid the index never held.
      db.prepare('DELETE FROM studio_artifacts WHERE id = ?').run(recipe);
      expect(matched(TERM)).toEqual([clip]);
      integrityCheck();

      db.prepare('DELETE FROM studio_artifacts WHERE id = ?').run(clip);
      expect(matched(TERM)).toEqual([]);
      expect(docsized()).toEqual([]);
      integrityCheck();
    });
  });

  it('rebuilds an existing database so only its non-recipe rows are indexed', () => {
    // Replay every migration EXCEPT 034, exactly as the runner does, to reproduce a user database
    // sitting at the pre-034 schema — where 009's trigger indexes a recipe on insert.
    db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
    const record = db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)');
    for (const migration of MIGRATIONS) {
      if (migration.name === MIGRATION_NAME || migration.requiresVec) continue;
      db.transaction(() => {
        db.exec(migration.sql);
        migration.postStep?.(db);
        record.run(migration.name, Date.now());
      })();
    }

    const recipe = seed('recipe', `${TERM} canonical rows`, null, '{}');
    const clip = seed('clip', `${TERM} pricing`, 'body');
    // Forcing pin: without this the rebuild assertion could pass over an index that was empty
    // for reasons of its own. The stale index MUST hold the recipe before 034 runs.
    expect(matched(TERM)).toEqual([clip, recipe].sort((a, b) => a - b));

    _resetMigrationGuard();
    applyMigrations(db, { vecLoaded: false });

    expect(matched(TERM)).toEqual([clip]);
    expect(docsized()).toEqual([clip]);
    integrityCheck();

    // And the replaced triggers govern the upgraded database from here on.
    db.prepare('DELETE FROM studio_artifacts WHERE id = ?').run(recipe);
    integrityCheck();
  });
});
