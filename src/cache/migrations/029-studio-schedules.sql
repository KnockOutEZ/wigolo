CREATE TABLE IF NOT EXISTS studio_schedules (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  cadence            TEXT NOT NULL,
  wake               TEXT NOT NULL,
  target             TEXT NOT NULL,
  approval_required  INTEGER NOT NULL DEFAULT 1,
  status             TEXT NOT NULL,
  next_due_at        INTEGER,
  last_run_id        TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
