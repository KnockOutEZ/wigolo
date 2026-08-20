/** A file discovered by the local scanner, ready for ingest. */
export interface ScannedFile {
  absolutePath: string;
  /** POSIX-style path relative to the scan root (no `..`). */
  relativePath: string;
}

export interface ScanResult {
  root: string;
  files: ScannedFile[];
  /** Soft warnings (skipped secrets, oversized files, cap hit). */
  warnings: string[];
  /** True when scanning stopped because `maxFiles` was reached. */
  capReached?: boolean;
}

/** Parsed local file content before cache write. */
export interface ReadFileResult {
  title: string;
  markdown: string;
  mime: string;
  extractorUsed: string;
}

export type IndexFileStatus = 'indexed' | 'skipped' | 'failed';

export interface IndexFileResult {
  path: string;
  url: string;
  status: IndexFileStatus;
  error?: string;
  /** Internal: whether embedding was actually enqueued (not serialized to MCP). */
  embedEnqueued?: boolean;
}

export interface IngestOptions {
  namespace: string;
  tags: string[];
  /** Seconds; 0 or null → never expire (`expires_at` NULL). */
  ttlSeconds: number | null;
  /** When false, skip embedding enqueue (tests). Default true. */
  embed?: boolean;
}

export interface IngestBatchResult {
  indexed: number;
  skipped: number;
  failed: number;
  files: IndexFileResult[];
  embed?: {
    enqueued: number;
    skipped_embed: number;
  };
}

export interface IndexedDocumentWrite {
  url: string;
  title: string;
  markdown: string;
  contentHash: string;
  namespace: string;
  tags: string[];
  expiresAt: Date | null;
  extractorUsed: string;
  metadata: Record<string, unknown>;
  sourcePath: string;
  sourceRoot: string;
}

export type CacheIndexedOutcome = 'insert' | 'update' | 'skip';
