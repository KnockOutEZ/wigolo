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
      url TEXT UNIQUE NOT NULL,
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
      fetched_at TEXT NOT NULL,
      expires_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_url_cache_normalized ON url_cache(normalized_url);

    CREATE VIRTUAL TABLE IF NOT EXISTS url_cache_fts USING fts5(
      title,
      markdown,
      url,
      content='url_cache',
      content_rowid='id'
    );

    CREATE TRIGGER IF NOT EXISTS url_cache_ai AFTER INSERT ON url_cache BEGIN
      INSERT INTO url_cache_fts(rowid, title, markdown, url)
        VALUES (new.id, new.title, new.markdown, new.url);
    END;

    CREATE TRIGGER IF NOT EXISTS url_cache_ad BEFORE DELETE ON url_cache BEGIN
      INSERT INTO url_cache_fts(url_cache_fts, rowid, title, markdown, url)
        VALUES ('delete', old.id, old.title, old.markdown, old.url);
    END;

    CREATE TRIGGER IF NOT EXISTS url_cache_au BEFORE UPDATE ON url_cache BEGIN
      INSERT INTO url_cache_fts(url_cache_fts, rowid, title, markdown, url)
        VALUES ('delete', old.id, old.title, old.markdown, old.url);
    END;

    CREATE TRIGGER IF NOT EXISTS url_cache_au_after AFTER UPDATE ON url_cache BEGIN
      INSERT INTO url_cache_fts(rowid, title, markdown, url)
        VALUES (new.id, new.title, new.markdown, new.url);
    END;

    CREATE TABLE IF NOT EXISTS search_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query TEXT NOT NULL,
      query_hash TEXT UNIQUE NOT NULL,
      results TEXT NOT NULL,
      engines_used TEXT,
      searched_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT
    );

    CREATE TABLE IF NOT EXISTS domain_routing (
      domain TEXT PRIMARY KEY,
      prefer_playwright INTEGER DEFAULT 0,
      http_failures INTEGER DEFAULT 0,
      last_updated TEXT
    );

    CREATE TABLE IF NOT EXISTS domain_boilerplate (
      domain TEXT NOT NULL,
      block_hash TEXT NOT NULL,
      sample_text TEXT,
      discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (domain, block_hash)
    );
  `);

  // Embedding columns migration (Slice 22)
  try {
    const columns = db.pragma('table_info(url_cache)') as Array<{ name: string }>;
    const columnNames = new Set(columns.map(c => c.name));

    if (!columnNames.has('embedding')) {
      db.exec('ALTER TABLE url_cache ADD COLUMN embedding BLOB');
    }
    if (!columnNames.has('embedding_model')) {
      db.exec('ALTER TABLE url_cache ADD COLUMN embedding_model TEXT');
    }
    if (!columnNames.has('embedding_dims')) {
      db.exec('ALTER TABLE url_cache ADD COLUMN embedding_dims INTEGER');
    }
  } catch {
    // Migration already applied or column already exists
  }

  instance = db;
  return db;
}

export function getDatabase(): Database.Database {
  if (!instance) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return instance;
}

export function closeDatabase(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}
