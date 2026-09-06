CREATE TABLE IF NOT EXISTS studio_collections (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  criteria      TEXT NOT NULL,
  recipe_id     TEXT,
  watcher_id    TEXT,
  export_prefs  TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
