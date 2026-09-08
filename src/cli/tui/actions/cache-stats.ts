/**
 * getCacheStatsAction — wraps the cache module's public getCacheStats() API.
 *
 * Returns a structured result for the Dashboard to render. Never reaches into
 * SQLite directly; always delegates to the public cache/store.ts export.
 *
 * The database connection is opened here when the process has not opened one
 * yet. `wigolo cache --stats` succeeds because its dispatcher opens the
 * database first; `wigolo config --cache-stats` reported "Database not
 * initialized" and exited 1 on the same data directory purely because nothing
 * on that path had opened it. Opening it here fixes both callers rather than
 * the one flag, and matches what every other reader of the cache does.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getCacheStats } from '../../../cache/store.js';
import { initDatabase, isDatabaseInitialized } from '../../../cache/db.js';
import { getConfig } from '../../../config.js';

export interface CacheStatsResult {
  totalEntries: number;
  sizeMb: number;
  oldest: string;
  newest: string;
  /** Present when an error occurred fetching stats */
  error?: string;
}

export interface CacheStatsOpts {
  /** Override the data directory holding `wigolo.db`. Defaults to the resolved config. */
  dataDir?: string;
  /**
   * Override how the database is opened. Injected by tests so a unit test does
   * not create a real SQLite file; production passes nothing.
   */
  openDatabase?: (dataDir: string) => void;
}

function openDatabaseAt(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true });
  initDatabase(join(dataDir, 'wigolo.db'));
}

export async function getCacheStatsAction(
  opts: CacheStatsOpts = {},
): Promise<CacheStatsResult> {
  try {
    if (!isDatabaseInitialized()) {
      (opts.openDatabase ?? openDatabaseAt)(opts.dataDir ?? getConfig().dataDir);
    }
    const stats = getCacheStats();
    return {
      totalEntries: stats.total_urls,
      sizeMb: stats.total_size_mb,
      oldest: stats.oldest,
      newest: stats.newest,
    };
  } catch (err) {
    return {
      totalEntries: 0,
      sizeMb: 0,
      oldest: '',
      newest: '',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
