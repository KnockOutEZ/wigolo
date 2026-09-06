CREATE TABLE IF NOT EXISTS studio_watchers (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL,
  target           TEXT NOT NULL,
  cadence_seconds  INTEGER NOT NULL,
  alert_rules      TEXT NOT NULL,
  status           TEXT NOT NULL,
  run_id           TEXT,
  last_check_at    INTEGER,
  last_state       TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
