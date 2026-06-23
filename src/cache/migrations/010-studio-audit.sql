-- 010 — Phase 6b: durable per-session Studio audit log.
-- Persists every agent action + its resolved outcome for trust + the Phase-7 replay timeline.
-- METADATA ONLY by construction: the in-memory AuditEntry never carries raw typed text (only
-- outcome_chars_landed), so no raw values reach this table. session_id FKs studio_sessions (008,
-- the parent). The (session_id, seq) unique index is the stable replay order AND makes the
-- sole-writer (src/studio/audit.ts) INSERT idempotent. INSERT-only: no UPDATE/DELETE anywhere.

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
