-- 009-content-completeness
-- Mirror of MIGRATION_009_CONTENT_COMPLETENESS in runner.ts (grep-ability + review). Keep in step.
--
-- Nullable content-completeness columns on url_cache so a cache hit can be re-classified stale when
-- the cached capture was only a shell (a challenge page, an unhydrated SPA frame) rather than the
-- page a reader would have seen. `level` is the verdict, `reason` the evidence for it, and
-- `settled_by` the stage that settled it. All three are nullable so legacy rows stay readable;
-- callers read `null` as "never classified", never as "complete".
--
-- This .sql file is a grep-mirror only — the runner.ts MIGRATIONS[] entry (postStep-guarded on
-- PRAGMA table_info, since SQLite has no `ADD COLUMN IF NOT EXISTS`, and skipped entirely when
-- url_cache is absent because initDatabase() creates that table inline) is what actually runs.

ALTER TABLE url_cache ADD COLUMN content_completeness_level TEXT;
ALTER TABLE url_cache ADD COLUMN content_completeness_reason TEXT;
ALTER TABLE url_cache ADD COLUMN content_completeness_settled_by TEXT;
