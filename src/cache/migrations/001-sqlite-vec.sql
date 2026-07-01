-- sqlite-vec backing tables for vector search.
--
-- vec_documents holds the 384-dim float embeddings (BGE-small-en-v1.5).
-- vec_id_map maps external string ids (URLs today) to integer rowids that
-- vec0 requires. vec_metadata persists the full VectorMetadata so the
-- VectorStore.search filter/result contract is satisfied without a second
-- round-trip to url_cache.

CREATE VIRTUAL TABLE IF NOT EXISTS vec_documents USING vec0(
  embedding float[384]
);

CREATE TABLE IF NOT EXISTS vec_id_map (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS vec_metadata (
  rowid INTEGER PRIMARY KEY REFERENCES vec_id_map(rowid) ON DELETE CASCADE,
  url TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  model_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  extra_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_vec_metadata_url ON vec_metadata(url);
CREATE INDEX IF NOT EXISTS idx_vec_metadata_hash ON vec_metadata(content_hash);
CREATE INDEX IF NOT EXISTS idx_vec_metadata_model ON vec_metadata(model_id);
