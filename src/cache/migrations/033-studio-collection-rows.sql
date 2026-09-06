CREATE TABLE IF NOT EXISTS studio_collection_rows (
  collection_id  TEXT NOT NULL,
  entity_key     TEXT NOT NULL,
  fields         TEXT NOT NULL,
  content_hash   TEXT,
  first_seen_at  INTEGER NOT NULL,
  last_seen_at   INTEGER NOT NULL,
  changed_at     INTEGER,
  status         TEXT NOT NULL,
  UNIQUE (collection_id, entity_key)
);
