-- 016-studio-runs
-- Mirror of MIGRATION_016_STUDIO_RUNS in runner.ts (grep-ability + review). Keep in step.

CREATE TABLE IF NOT EXISTS studio_runs (
  id         TEXT PRIMARY KEY,
  task       TEXT NOT NULL,
  space_id   TEXT NOT NULL DEFAULT 'default',
  created_at TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'running',
  last_seq   INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS studio_run_events (
  run_id  TEXT NOT NULL REFERENCES studio_runs(id),
  seq     INTEGER NOT NULL,
  ts      TEXT NOT NULL,
  actor   TEXT NOT NULL,
  type    TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_studio_run_events_type ON studio_run_events(run_id, type);
CREATE INDEX IF NOT EXISTS idx_studio_runs_status ON studio_runs(status, created_at);
