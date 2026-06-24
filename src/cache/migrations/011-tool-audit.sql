-- 011 — D10: non-studio tool-invocation audit log.
-- An append-only forensic record of every NON-studio_* MCP tool call: which tool ran, a
-- PRIVACY-PROJECTED slice of its args (closed per-tool shape — free-text intent omitted, target
-- URLs stripped of query+fragment; see src/server/tool-audit.ts), the outcome, and the duration.
-- A standalone table (NOT studio_audit — that one's session_id NOT-NULL FK + studio-shaped columns
-- don't fit a session-less stdio tool call). INSERT-only: the sole writer (src/server/tool-audit.ts)
-- never UPDATEs/DELETEs. Mirrored as MIGRATION_011_TOOL_AUDIT in runner.ts.

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
