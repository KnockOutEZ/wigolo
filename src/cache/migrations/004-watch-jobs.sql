-- Persistent state for the `watch` MCP tool.
-- Lazy-execution model — there is no background daemon. `last_check_at` is
-- consulted on every other tool call to decide whether a job is overdue and
-- should fire before the calling tool's work.

CREATE TABLE IF NOT EXISTS watch_jobs (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  interval_seconds INTEGER NOT NULL,
  selector TEXT,
  last_check_at INTEGER,
  last_content_hash TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  notification TEXT NOT NULL DEFAULT 'inline',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_watch_jobs_status ON watch_jobs(status);
CREATE INDEX IF NOT EXISTS idx_watch_jobs_url ON watch_jobs(url);
