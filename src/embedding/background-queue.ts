import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createLogger } from '../logger.js';
import { getConfig } from '../config.js';
import {
  getEmbedProvider,
  type EmbedProvider,
} from '../providers/embed-provider.js';
import {
  getVectorStore,
  type VectorRecord,
  type VectorStore,
} from '../providers/vector-store.js';

const log = createLogger('embedding');

const DEFAULT_MAX_ATTEMPTS = 3;

export interface IndexJobInput {
  url: string;
  text: string;
  contentHash: string;
}

interface JobRow {
  id: number;
  url: string;
  text: string;
  content_hash: string;
  attempts: number;
}

export interface BackgroundIndexQueueOptions {
  dbPath: string;
  embedProvider?: () => Promise<EmbedProvider>;
  vectorStore?: () => Promise<VectorStore>;
  maxAttempts?: number;
  syncMode?: boolean;
  /** Start the background worker on construction. Defaults to true. */
  autoStart?: boolean;
}

/**
 * SQLite-backed single-worker queue for embedding jobs. Crawls enqueue
 * {url, text, contentHash}; the worker drains the queue out-of-band so
 * the crawl/search response path returns without paying per-embed cost.
 *
 * Jobs survive process restarts via the on-disk table at `dbPath`.
 */
export class BackgroundIndexQueue {
  private db: Database.Database;
  private resolveProvider: () => Promise<EmbedProvider>;
  private resolveStore: () => Promise<VectorStore>;
  private maxAttempts: number;
  private syncMode: boolean;
  private worker: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  private stopped = false;
  private autoStart: boolean;
  private inflight: Promise<boolean> | null = null;

  constructor(opts: BackgroundIndexQueueOptions) {
    mkdirSync(dirname(opts.dbPath), { recursive: true });
    this.db = new Database(opts.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS index_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT UNIQUE NOT NULL,
        text TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    this.resolveProvider = opts.embedProvider ?? getEmbedProvider;
    this.resolveStore = opts.vectorStore ?? getVectorStore;
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.syncMode = opts.syncMode ?? false;
    this.autoStart = opts.autoStart ?? true;
    if (this.autoStart && !this.syncMode) {
      this.start();
    }
  }

  enqueue(job: IndexJobInput): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO index_jobs (url, text, content_hash, attempts)
         VALUES (?, ?, ?, 0)
         ON CONFLICT(url) DO UPDATE SET
           text = excluded.text,
           content_hash = excluded.content_hash,
           attempts = 0`,
      )
      .run(job.url, job.text, job.contentHash);

    if (this.syncMode) {
      return this.processOne().then(() => undefined);
    }
    this.kickWorker();
    return Promise.resolve();
  }

  pendingSize(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS c FROM index_jobs')
      .get() as { c: number };
    return row.c;
  }

  start(): void {
    if (this.worker || this.stopped) return;
    this.worker = this.runLoop().catch((err) => {
      log.error('background index worker crashed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  async drain(): Promise<void> {
    while (!this.stopped && this.pendingSize() > 0) {
      await this.processOne();
    }
  }

  shutdown(): void {
    if (this.stopped) return;
    this.stopped = true;
    const wake = this.wake;
    this.wake = null;
    if (wake) wake();
    try {
      this.db.close();
    } catch {
      // best-effort
    }
  }

  private kickWorker(): void {
    if (this.stopped || !this.autoStart) return;
    if (!this.worker) this.start();
    const wake = this.wake;
    this.wake = null;
    if (wake) wake();
  }

  private async runLoop(): Promise<void> {
    while (!this.stopped) {
      const processed = await this.processOne();
      if (processed) continue;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }

  private async processOne(): Promise<boolean> {
    if (this.stopped) return false;
    if (this.inflight) {
      // Serialize concurrent callers (worker loop + drain) so they don't
      // race to claim the same row.
      await this.inflight.catch(() => undefined);
      if (this.stopped) return false;
    }
    let resolveInflight!: (v: boolean) => void;
    this.inflight = new Promise<boolean>((r) => {
      resolveInflight = r;
    });
    try {
      const result = await this.processOneInner();
      resolveInflight(result);
      return result;
    } catch (err) {
      resolveInflight(false);
      throw err;
    } finally {
      this.inflight = null;
    }
  }

  private async processOneInner(): Promise<boolean> {
    const row = this.db
      .prepare(
        'SELECT id, url, text, content_hash, attempts FROM index_jobs ORDER BY id ASC LIMIT 1',
      )
      .get() as JobRow | undefined;
    if (!row) return false;

    try {
      const provider = await this.resolveProvider();
      const store = await this.resolveStore();
      const vectors = await provider.embed([row.text]);
      if (vectors.length > 0) {
        const record: VectorRecord = {
          id: row.url,
          vector: vectors[0],
          metadata: {
            url: row.url,
            contentHash: row.content_hash,
            modelId: provider.modelId,
          },
        };
        await store.upsert([record]);
      }
      this.db.prepare('DELETE FROM index_jobs WHERE id = ?').run(row.id);
      return true;
    } catch (err) {
      const attempts = row.attempts + 1;
      log.warn('background index job failed', {
        url: row.url,
        attempts,
        maxAttempts: this.maxAttempts,
        error: err instanceof Error ? err.message : String(err),
      });
      if (attempts >= this.maxAttempts) {
        this.db.prepare('DELETE FROM index_jobs WHERE id = ?').run(row.id);
      } else {
        this.db
          .prepare('UPDATE index_jobs SET attempts = ? WHERE id = ?')
          .run(attempts, row.id);
      }
      return true;
    }
  }
}

let singleton: BackgroundIndexQueue | null = null;

export function getBackgroundIndexQueue(): BackgroundIndexQueue {
  if (!singleton) {
    const dbPath = join(getConfig().dataDir, 'jobs.db');
    singleton = new BackgroundIndexQueue({
      dbPath,
      syncMode: process.env.WIGOLO_WAIT_FOR_INDEX === '1',
    });
  }
  return singleton;
}

export function _resetBackgroundIndexQueueForTest(): void {
  if (singleton) {
    singleton.shutdown();
    singleton = null;
  }
}
