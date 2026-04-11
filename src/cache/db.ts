import Database from 'better-sqlite3';

let instance: Database.Database | null = null;

export function initDatabase(dbPath: string): Database.Database {
  if (instance) {
    instance.close();
    instance = null;
  }

  const db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS url_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL,
      normalized_url TEXT NOT NULL,
      title TEXT,
      markdown TEXT,
      raw_html TEXT,
      metadata TEXT,
      links TEXT,
      images TEXT,
      fetch_method TEXT,
      extractor_used TEXT,
      content_hash TEXT,
      fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_url_cache_normalized ON url_cache(normalized_url);

    CREATE VIRTUAL TABLE IF NOT EXISTS url_cache_fts USING fts5(
      title,
      markdown,
      content='url_cache',
      content_rowid='id'
    );

    CREATE TRIGGER IF NOT EXISTS url_cache_ai AFTER INSERT ON url_cache BEGIN
      INSERT INTO url_cache_fts(rowid, title, markdown)
        VALUES (new.id, new.title, new.markdown);
    END;

    CREATE TRIGGER IF NOT EXISTS url_cache_ad BEFORE DELETE ON url_cache BEGIN
      INSERT INTO url_cache_fts(url_cache_fts, rowid, title, markdown)
        VALUES ('delete', old.id, old.title, old.markdown);
    END;

    CREATE TRIGGER IF NOT EXISTS url_cache_au BEFORE UPDATE ON url_cache BEGIN
      INSERT INTO url_cache_fts(url_cache_fts, rowid, title, markdown)
        VALUES ('delete', old.id, old.title, old.markdown);
    END;

    CREATE TABLE IF NOT EXISTS search_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query TEXT,
      engine TEXT,
      results TEXT,
      fetched_at TEXT,
      expires_at TEXT
    );

    CREATE TABLE IF NOT EXISTS domain_routing (
      domain TEXT PRIMARY KEY,
      preferred_method TEXT,
      failure_count INTEGER DEFAULT 0,
      last_updated TEXT
    );

    CREATE TABLE IF NOT EXISTS domain_boilerplate (
      domain TEXT PRIMARY KEY,
      selectors TEXT,
      last_updated TEXT
    );
  `);

  instance = db;
  return db;
}

export function closeDatabase(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}
