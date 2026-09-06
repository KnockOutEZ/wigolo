-- 034 — SD10 / D11: make the shared studio_artifacts FTS lifecycle recipe-aware.
--
-- A recipe artifact is a canonical extraction definition, not a document. It persists with
-- `title` populated, its canonical JSON in `metadata`, and `markdown` NULL — and it must NOT
-- appear in `studio_artifacts_fts` or in any similarity-class read built on it, because it is
-- not prose an agent can cite.
--
-- Migration 009's triggers index every title unconditionally, which leaves the private Studio
-- half two bad options, both of which this migration removes:
--   * leave the recipe indexed — it surfaces as captured prose (forbidden); or
--   * delete the FTS entry right after insert — the later generic title-UPDATE / base-DELETE
--     trigger then issues a SECOND external-content 'delete' for a rowid the index no longer
--     holds, and FTS5 raises SQLITE_CORRUPT_VTAB.
-- The exclusion therefore belongs in the triggers themselves.
--
-- D15: 009 is RELEASED and is not edited or renamed — its triggers are DROPped and recreated
-- here under the same names, so a database at any prior schema converges with a fresh one.
--
-- The WHOLE migration runs in the runner postStep (see runner.ts) and is mirrored here for
-- review. It is guarded on studio_artifacts existing, for 009's reason: a runner-only harness
-- skips initDatabase's inline schema, and an unguarded DDL would abort the whole pass.
--
-- The AFTER UPDATE trigger uses INSERT ... SELECT ... WHERE rather than two WHEN-guarded
-- triggers because SQLite allows only one WHEN per trigger and the four transitions need
-- different halves of the delete/insert pair:
--   ordinary -> ordinary   delete old terms, insert new terms
--   ordinary -> recipe     delete old terms, insert nothing
--   recipe   -> ordinary   delete nothing, insert new terms
--   recipe   -> recipe     neither (a recipe title rewrite stays absent)
-- `IS NOT` (not `<>`) so the comparison is NULL-safe even though 008 declares the column
-- NOT NULL. The WHEN clause keeps 009's curate-only skip (curated_by_human 0->1, or a
-- metadata-only recipe rewrite, changes no indexed column and must not churn FTS) and adds
-- artifact_type, without which a pure type transition would not fire at all.

DROP TRIGGER IF EXISTS studio_artifacts_ai;
DROP TRIGGER IF EXISTS studio_artifacts_ad;
DROP TRIGGER IF EXISTS studio_artifacts_au;

CREATE TRIGGER studio_artifacts_ai AFTER INSERT ON studio_artifacts
  WHEN new.artifact_type IS NOT 'recipe'
BEGIN
  INSERT INTO studio_artifacts_fts(rowid, title, markdown) VALUES (new.id, new.title, new.markdown);
END;

CREATE TRIGGER studio_artifacts_ad AFTER DELETE ON studio_artifacts
  WHEN old.artifact_type IS NOT 'recipe'
BEGIN
  INSERT INTO studio_artifacts_fts(studio_artifacts_fts, rowid, title, markdown) VALUES('delete', old.id, old.title, old.markdown);
END;

CREATE TRIGGER studio_artifacts_au AFTER UPDATE ON studio_artifacts
  WHEN old.title IS NOT new.title
    OR old.markdown IS NOT new.markdown
    OR old.artifact_type IS NOT new.artifact_type
BEGIN
  INSERT INTO studio_artifacts_fts(studio_artifacts_fts, rowid, title, markdown)
    SELECT 'delete', old.id, old.title, old.markdown WHERE old.artifact_type IS NOT 'recipe';
  INSERT INTO studio_artifacts_fts(rowid, title, markdown)
    SELECT new.id, new.title, new.markdown WHERE new.artifact_type IS NOT 'recipe';
END;

-- Rebuild from the non-recipe rows only. FTS5's own 'rebuild' command cannot be filtered — it
-- reindexes every content row — so the index is emptied and repopulated by SELECT instead.
-- Writing straight into the FTS table fires no trigger on studio_artifacts.
INSERT INTO studio_artifacts_fts(studio_artifacts_fts) VALUES('delete-all');
INSERT INTO studio_artifacts_fts(rowid, title, markdown)
  SELECT id, title, markdown FROM studio_artifacts WHERE artifact_type IS NOT 'recipe';
