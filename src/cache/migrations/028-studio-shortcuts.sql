CREATE TABLE IF NOT EXISTS studio_shortcuts (
  id          TEXT PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  body        TEXT NOT NULL,
  source      TEXT NOT NULL,
  used_count  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
