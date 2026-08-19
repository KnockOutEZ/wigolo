-- S13-0: the FLOW SIDECAR — an ordered, purpose-built record of the agent's successful
-- actions, derived from studio_audit and carrying exactly what a later re-run needs and the
-- audit deliberately does not (the full re-resolution seed).
--
-- A SIDECAR, not a change to studio_audit. S13 adds no writer, no reader, no column and no
-- index to studio_audit — that table stays the forensic record, and its append-only sole-writer
-- story is the reason it is trustworthy. This table references an audit row by (session_id,
-- audit_seq); it never writes one.
--
-- A TABLE, not a studio_artifacts row: (a) a flow is an ORDERED sequence and studio_artifacts
-- has no ordering column, and its dedup indexes on (normalized_url, artifact_type, content_hash)
-- would silently COLLAPSE two steps that touch the same URL with the same target; (b) the
-- studio_artifacts FTS triggers copy `title`/`markdown` into a shadow table, so a step body
-- stored there would exist in a SECOND copy that the write/read allow-list below cannot reach.
--
-- WHAT IS STRUCTURALLY ABSENT, and why each absence is the design:
--   * no text/value column — a `type` step stores a named SLOT, never a value. The recording
--     cannot leak what it never held.
--   * no risk/approval column — a recording does NOT carry authorization. Risk is re-classified
--     from the live page at run time and authorization is re-sought from the live pre-grant
--     store. Making the columns absent is stronger than "the runner must not read them".
--   * no backend_node_id column — that is a live host-side handle, invalid (not merely stale)
--     in a stored step.
--   * target_attrs holds ONLY the fixed stable-attr subset the fingerprint is computed from, so
--     it is exactly sufficient to recompute target_fingerprint and structurally cannot carry a
--     credential-shaped attribute.
CREATE TABLE IF NOT EXISTS studio_flow_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  flow_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES studio_sessions(id),
  seq INTEGER NOT NULL,
  audit_seq INTEGER NOT NULL,
  action TEXT NOT NULL,
  page_url TEXT,
  target_role TEXT,
  target_name TEXT,
  target_fingerprint TEXT,
  target_ancestor_path TEXT,
  target_attrs TEXT,
  recorded_ref TEXT,
  heal_tier_at_record TEXT,
  slot TEXT,
  direction TEXT,
  amount REAL,
  ts INTEGER NOT NULL
);

-- The ordered sequence IS the artifact: two steps may never collapse onto one position, and the
-- unique index makes the sole-writer INSERT idempotent on a re-append (mirrors studio_audit).
CREATE UNIQUE INDEX IF NOT EXISTS idx_studio_flow_steps_flow_seq
  ON studio_flow_steps(flow_id, seq);

CREATE INDEX IF NOT EXISTS idx_studio_flow_steps_session
  ON studio_flow_steps(session_id);
