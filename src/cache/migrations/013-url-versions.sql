-- S14-1: the corpus time axis.
--
-- url_cache is INSERT OR REPLACE, one row per URL: every re-fetch destroys the
-- body it replaces, so no past state of any page is reachable by any path.
-- url_versions is the append-on-change side table that keeps the older bodies.
--
-- D-S14-1: url_cache's schema is NOT touched. It stays the hot path for "give me
-- the current page"; a history column on a REPLACEd row would be destroyed by the
-- very mechanism this table exists to escape.
--
-- D-S14-6: versions are NOT embedded and NOT joined to url_cache_fts in S14 —
-- embedding every historical version multiplies the vector index by the version
-- count and turns retention into a two-store consistency problem.
--
-- Standalone by construction: no FK to url_cache. A version outlives the cache
-- row it was captured from, and the runner-only test harness (which skips
-- initDatabase's inline url_cache schema) must still be able to apply this.

CREATE TABLE IF NOT EXISTS url_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  normalized_url TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  markdown TEXT NOT NULL,
  title TEXT,
  http_status INTEGER,
  fetched_at TEXT NOT NULL,
  byte_len INTEGER NOT NULL,
  origin_authenticated INTEGER NOT NULL DEFAULT 0
);

-- The dedup key. Makes "a page fetched 200 times unchanged costs one row"
-- structural rather than a caller's discipline.
CREATE UNIQUE INDEX IF NOT EXISTS idx_url_versions_url_hash
  ON url_versions(normalized_url, content_hash);

-- Per-URL history reads and the per-URL count bound's oldest-first scan.
CREATE INDEX IF NOT EXISTS idx_url_versions_url_time
  ON url_versions(normalized_url, fetched_at, id);

-- The global byte + age bounds sweep the whole table oldest-first. byte_len is
-- carried so the per-write "are we over budget?" SUM is index-only and the
-- common case never has to build the eviction window at all.
CREATE INDEX IF NOT EXISTS idx_url_versions_time
  ON url_versions(fetched_at, id, byte_len);
