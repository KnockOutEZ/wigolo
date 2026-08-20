import { watch, type FSWatcher, statSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { createLogger } from '../logger.js';
import { ingestFile } from './ingester.js';
import { matchSimpleGlob } from './scanner.js';
import type { IngestOptions } from './types.js';

const log = createLogger('indexing');

const DEBOUNCE_MS = 300;

export interface IndexWatcherHandle {
  watching: true;
  stop: () => void;
}

export interface IndexWatcherOptions {
  root: string;
  namespace: string;
  glob: string;
  recursive: boolean;
  ingestOpts: IngestOptions;
}

/**
 * Debounced fs.watch over `root`. Re-ingests changed files that still match
 * the glob. Does not persist jobs — process-lifetime only (MCP stdio model).
 *
 * When `root` is a single file, watches the parent directory and filters to
 * that basename (Node's fs.watch on a file is unreliable across platforms).
 */
export function startIndexWatcher(options: IndexWatcherOptions): IndexWatcherHandle {
  const timers = new Map<string, NodeJS.Timeout>();
  let closed = false;

  let watchTarget = options.root;
  let singleFileName: string | null = null;
  try {
    const st = statSync(options.root);
    if (st.isFile()) {
      singleFileName = basename(options.root);
      watchTarget = dirname(options.root);
    }
  } catch {
    // Fall through — fs.watch will surface the error.
  }

  const flush = (absPath: string): void => {
    const existing = timers.get(absPath);
    if (existing) clearTimeout(existing);
    timers.set(
      absPath,
      setTimeout(() => {
        timers.delete(absPath);
        if (closed) return;
        void reingest(absPath);
      }, DEBOUNCE_MS),
    );
  };

  const reingest = async (absPath: string): Promise<void> => {
    if (singleFileName && basename(absPath) !== singleFileName) return;
    const name = basename(absPath);
    if (!matchSimpleGlob(name, options.glob)) return;
    const rel = relative(options.root, absPath);
    const relativePath =
      !rel || rel === '.' || rel.startsWith('..')
        ? name
        : rel.split(sep).join('/');
    try {
      const r = await ingestFile(
        { absolutePath: absPath, relativePath },
        options.ingestOpts,
        options.root,
      );
      log.debug('watch re-index', { path: relativePath, status: r.status });
    } catch (err) {
      log.warn('watch re-index failed', {
        path: absPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  let watcher: FSWatcher;
  try {
    watcher = watch(
      watchTarget,
      { recursive: singleFileName ? false : options.recursive },
      (_event, filename) => {
        if (!filename || closed) return;
        flush(join(watchTarget, filename));
      },
    );
  } catch (err) {
    throw new Error(
      `fs.watch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  watcher.on('error', (err) => {
    log.warn('index watcher error', { error: err.message });
  });

  return {
    watching: true,
    stop: () => {
      if (closed) return;
      closed = true;
      watcher.close();
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
  };
}

/** Block until SIGINT/SIGTERM or an external abort signal. */
export function waitForWatchStop(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      process.off('SIGINT', done);
      process.off('SIGTERM', done);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
    signal?.addEventListener('abort', done, { once: true });
  });
}
