-- Per-URL ETag + Last-Modified cache so the
-- crawler can detect unchanged pages on incremental runs and skip
-- extraction. SmartRouter does not yet expose conditional headers, so this
-- table is content-hash-aware only — full GET still happens, but downstream
-- work (dedup, vec indexing) is skipped when the etag/last-modified match.

CREATE TABLE IF NOT EXISTS crawl_etags (
  url TEXT PRIMARY KEY,
  origin TEXT NOT NULL,
  etag TEXT,
  last_modified TEXT,
  fetched_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_crawl_etags_origin ON crawl_etags(origin);
