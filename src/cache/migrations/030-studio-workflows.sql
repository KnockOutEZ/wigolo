CREATE TABLE IF NOT EXISTS studio_workflows (
  slug          TEXT NOT NULL,
  version       INTEGER NOT NULL,
  definition    TEXT NOT NULL,
  status        TEXT NOT NULL,
  published_at  INTEGER,
  PRIMARY KEY (slug, version)
);

CREATE TRIGGER IF NOT EXISTS studio_workflows_append_only_insert
BEFORE INSERT ON studio_workflows
WHEN EXISTS (
  SELECT 1 FROM studio_workflows WHERE slug = NEW.slug AND version = NEW.version
)
BEGIN
  SELECT RAISE(ABORT, 'studio_workflows is append-only');
END;

CREATE TRIGGER IF NOT EXISTS studio_workflows_append_only_update
BEFORE UPDATE ON studio_workflows
BEGIN
  SELECT RAISE(ABORT, 'studio_workflows is append-only');
END;

CREATE TRIGGER IF NOT EXISTS studio_workflows_append_only_delete
BEFORE DELETE ON studio_workflows
BEGIN
  SELECT RAISE(ABORT, 'studio_workflows is append-only');
END;
