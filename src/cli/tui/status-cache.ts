import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';

export interface CacheStats {
  pages: number;
  bytes: number;
}

export function readCacheStats(dataDir: string): CacheStats {
  const dbPath = join(dataDir, 'cache.db');
  if (!existsSync(dbPath)) return { pages: 0, bytes: 0 };

  let bytes = 0;
  try {
    const stat = statSync(dbPath);
    if (!stat.isFile()) return { pages: 0, bytes: 0 };
    bytes = stat.size;
  } catch {
    return { pages: 0, bytes: 0 };
  }

  let pages = 0;
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const row = db.prepare(
      "SELECT count(*) AS c FROM sqlite_master WHERE type='table' AND name='url_cache'",
    ).get() as { c: number };
    if (row.c > 0) {
      const count = db.prepare('SELECT count(*) AS c FROM url_cache').get() as { c: number };
      pages = count.c;
    }
  } catch {
    pages = 0;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }

  return { pages, bytes };
}
