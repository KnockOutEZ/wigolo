-- S14-2: reach a retained version BY HASH without scanning the body table.
--
-- A SEPARATE migration rather than an edit to 013. 013 has already applied on
-- machines that record it in schema_migrations and will never re-run it, so an
-- amended 013 would create this index on new installs only — exactly the split
-- where the slow path survives unseen on the machines that already have data.
--
-- None of 013's three indexes leads on content_hash, so `WHERE content_hash = ?`
-- scanned the whole url_versions b-tree — the table holding full page bodies up
-- to the byte budget. `diff`'s old.content_hash reaches that lookup on EVERY hash
-- that misses the live url_cache row, which is both the ordinary case the time
-- axis exists for and the case for every bogus hash a caller can invent, with no
-- rate limit and no cost signal at the call site.
--
-- fetched_at and id ride along so the newest-first pick that resolves a
-- shared-hash tie is served from the index rather than by fetching rows to sort
-- them. Mirrored inline in runner.ts as MIGRATION_014_URL_VERSIONS_HASH_INDEX.

CREATE INDEX IF NOT EXISTS idx_url_versions_hash
  ON url_versions(content_hash, fetched_at, id);
