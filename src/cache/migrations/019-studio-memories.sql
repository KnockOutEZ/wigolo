-- 019-studio-memories
-- Mirror of MIGRATION_019_STUDIO_MEMORIES in runner.ts (grep-ability + review). Keep in step.

CREATE TABLE IF NOT EXISTS studio_memories (
  id            TEXT PRIMARY KEY,
  text          TEXT NOT NULL,
  scope         TEXT NOT NULL,
  scope_key     TEXT,
  provenance    TEXT NOT NULL,
  source_run_id TEXT,
  source_detail TEXT,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER,
  status        TEXT NOT NULL DEFAULT 'active'
);

CREATE INDEX IF NOT EXISTS idx_studio_memories_scope
  ON studio_memories(status, scope, scope_key, created_at);

CREATE INDEX IF NOT EXISTS idx_studio_memories_expiry
  ON studio_memories(expires_at)
  WHERE expires_at IS NOT NULL;
