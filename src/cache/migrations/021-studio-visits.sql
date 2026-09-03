-- A-18-5: history-with-content, partitioned from every agent-facing corpus BY CONSTRUCTION.
--
-- These tables are deliberately absent from BROKER_TABLES, from every artifact provider, and
-- from the url_cache_fts / vec unions that cache, find_similar and research read. Law 4
-- ("the user's own tabs are a separate group, invisible to every agent") extended to captured
-- content: a partition that holds because there is no join to cross, not because a caller
-- remembered to filter.
--
-- Two tables, not one: a human re-reading the same unchanged page must cost one body, so the
-- body lives once behind its content hash and the visit rows point at it. content_hash is
-- nullable — a visit whose body was not captured (capture off for the site, a credential
-- context, an empty extraction) is still history, and history without its URL is useless.
--
-- No FOREIGN KEY on either content_hash or run_id, and both omissions are deliberate.
-- Bodies are evicted by their own byte bound while the visit rows they served stay (the same
-- honesty url_versions retention has: the record of the visit outlives the body). run_id
-- is attribution written by a capture seam that cannot order itself against the run store's
-- writes, and recordVisit never throws — an FK would turn a race into silently dropped
-- history.
--
-- ts is the zone-less UTC "YYYY-MM-DD HH:MM:SS" that url_cache.fetched_at and
-- url_versions.fetched_at use, so a day is substr(ts, 1, 10) and a range is
-- lexicographic — which is what delete-per-day and the newest-first page are.

CREATE TABLE IF NOT EXISTS studio_visits (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  url            TEXT NOT NULL,
  normalized_url TEXT NOT NULL,
  title          TEXT,
  ts             TEXT NOT NULL,
  tab_id         TEXT NOT NULL,
  space_id       TEXT NOT NULL DEFAULT 'default',
  run_id         TEXT,
  content_hash   TEXT
);

-- Newest-first paging: the keyset predicate (ts < ? OR (ts = ? AND id < ?)) and the
-- ORDER BY ts DESC, id DESC are the same traversal, so no sort step survives.
CREATE INDEX IF NOT EXISTS idx_studio_visits_ts ON studio_visits(ts, id);

-- Per-site reads and the per-site delete seek by origin prefix; ts and id ride along so a
-- site's page is served from the index.
CREATE INDEX IF NOT EXISTS idx_studio_visits_url_ts ON studio_visits(normalized_url, ts, id);

-- "Is this body still referenced by any visit?" — the membership test the body sweep makes
-- once per deleted hash. Without it that question scans the visits table.
CREATE INDEX IF NOT EXISTS idx_studio_visits_hash ON studio_visits(content_hash);

CREATE TABLE IF NOT EXISTS studio_visit_pages (
  content_hash TEXT PRIMARY KEY,
  markdown     TEXT NOT NULL,
  byte_len     INTEGER NOT NULL,
  created_at   TEXT NOT NULL
);

-- The visits corpus's OWN index. Its own fts5 table rather than a column on url_cache_fts:
-- a shared index is a shared query, and every agent read of url_cache_fts would surface
-- browsing history the moment the tables met. content_hash is UNINDEXED — it is carried so
-- a match can be resolved back to its body and visits without a second lookup, not searched.
CREATE VIRTUAL TABLE IF NOT EXISTS studio_visit_pages_fts USING fts5(
  markdown,
  content_hash UNINDEXED
);

CREATE TRIGGER IF NOT EXISTS studio_visit_pages_ai AFTER INSERT ON studio_visit_pages BEGIN
  INSERT INTO studio_visit_pages_fts(rowid, markdown, content_hash)
  VALUES (new.rowid, new.markdown, new.content_hash);
END;

-- Plain DELETE, and NOT the INSERT ... VALUES('delete', ...) command the sibling
-- feed_items / studio_artifacts triggers use. That command requires every column's stored
-- value to be supplied, and an UNINDEXED column has no stored value to supply: measured on
-- this repo's SQLite build, the command form raises "SQL logic error" here while a plain
-- rowid DELETE is exact. This table carries content (it is not contentless or
-- external-content), so the rowid delete is the supported removal.
CREATE TRIGGER IF NOT EXISTS studio_visit_pages_ad AFTER DELETE ON studio_visit_pages BEGIN
  DELETE FROM studio_visit_pages_fts WHERE rowid = old.rowid;
END;

CREATE TRIGGER IF NOT EXISTS studio_visit_pages_au AFTER UPDATE ON studio_visit_pages BEGIN
  DELETE FROM studio_visit_pages_fts WHERE rowid = old.rowid;
  INSERT INTO studio_visit_pages_fts(rowid, markdown, content_hash)
  VALUES (new.rowid, new.markdown, new.content_hash);
END;

-- 3bf's per-site capture-off control, persisted. A row records a DECISION, so an absent row
-- is not an opt-out and the default reads capture-on; the column keeps a NOT NULL DEFAULT 1
-- for the same reason.
CREATE TABLE IF NOT EXISTS studio_visit_site_prefs (
  host            TEXT PRIMARY KEY,
  capture_enabled INTEGER NOT NULL DEFAULT 1,
  updated_at      TEXT NOT NULL
);
