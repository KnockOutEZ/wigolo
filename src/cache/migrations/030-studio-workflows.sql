CREATE TABLE IF NOT EXISTS studio_workflows (
  slug          TEXT NOT NULL,
  version       INTEGER NOT NULL,
  definition    TEXT NOT NULL,
  status        TEXT NOT NULL,
  published_at  INTEGER,
  PRIMARY KEY (slug, version)
);
