import { createLogger } from '../logger.js';
import { getBackgroundIndexQueue } from '../embedding/background-queue.js';
import { ingestFiles, buildInternalUrl } from '../indexing/ingester.js';
import { resolveLocalSource, scanLocalFiles, MAX_INDEX_FILES } from '../indexing/scanner.js';
import { startIndexWatcher, waitForWatchStop } from '../indexing/watcher.js';
import { VALID_NAMESPACE } from '../indexing/url-builder.js';
import type { IndexInput, IndexOutput, IndexFileResult } from '../types.js';

const log = createLogger('indexing');

const MAX_ERROR_DETAILS = 20;

function emptyOutput(namespace: string): IndexOutput {
  return {
    scanned: 0,
    indexed: 0,
    skipped: 0,
    failed: 0,
    namespace,
    files: [],
  };
}

function collectErrors(
  files: IndexOutput['files'],
): Array<{ path: string; reason: string }> | undefined {
  const errors = files
    .filter((f) => f.status === 'failed' && f.error)
    .slice(0, MAX_ERROR_DETAILS)
    .map((f) => ({ path: f.path, reason: f.error! }));
  return errors.length > 0 ? errors : undefined;
}

function toPublicFiles(
  files: Array<{ path: string; url: string; status: IndexFileResult['status']; error?: string }>,
): IndexFileResult[] {
  return files.map(({ path, url, status, error }) => ({
    path,
    url,
    status,
    ...(error ? { error } : {}),
  }));
}

/**
 * Ingest local markdown/text/PDF files into url_cache under `internal://` URLs.
 * Does not touch the network and does not go through SSRF guards.
 */
export async function handleIndex(input: IndexInput): Promise<IndexOutput> {
  const namespaceRaw = input.namespace?.trim() || 'docs';
  const namespace = namespaceRaw.toLowerCase();
  const empty = emptyOutput(namespace);

  if (!input.source || !input.source.trim()) {
    return { ...empty, error: 'source is required' };
  }

  if (!VALID_NAMESPACE.test(namespace)) {
    return { ...empty, error: `invalid namespace: ${JSON.stringify(input.namespace)}` };
  }

  const resolved = resolveLocalSource(input.source);
  if (!resolved.ok) {
    return { ...empty, error: resolved.error };
  }

  const ttl =
    input.ttl === undefined || input.ttl === null
      ? 0
      : Number(input.ttl);
  if (!Number.isFinite(ttl) || ttl < 0) {
    return { ...empty, error: 'ttl must be a non-negative number (0 = never expire)' };
  }

  const maxFilesRaw = input.max_files;
  let maxFiles: number;
  if (maxFilesRaw === undefined || maxFilesRaw === null) {
    maxFiles = MAX_INDEX_FILES;
  } else if (typeof maxFilesRaw === 'number' && Number.isInteger(maxFilesRaw) && maxFilesRaw >= 1) {
    maxFiles = maxFilesRaw;
  } else {
    return { ...empty, error: 'max_files must be a positive integer' };
  }

  const tags = Array.isArray(input.tags)
    ? input.tags.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
    : [];

  const glob = input.glob?.trim() || '*.md';

  log.info('index request', {
    source: resolved.root,
    namespace,
    glob,
    recursive: input.recursive !== false,
    ttl,
    tagCount: tags.length,
    dryRun: input.dry_run === true,
    maxFiles,
    watch: input.watch === true,
  });

  const scan = scanLocalFiles(resolved.root, {
    glob,
    recursive: input.recursive,
    maxFiles,
  });

  if (scan.capReached) {
    return {
      ...empty,
      error: `batch limit exceeded: more than ${maxFiles} files match under ${input.source}`,
    };
  }

  if (scan.files.length === 0) {
    const hint = scan.warnings.length > 0 ? ` (${scan.warnings[0]})` : '';
    return {
      ...empty,
      error: `no matching files under ${input.source}${hint}`,
    };
  }

  const sample_urls = scan.files
    .slice(0, 5)
    .map((f) => buildInternalUrl(namespace, f.relativePath));

  if (input.dry_run === true) {
    return {
      ...empty,
      scanned: scan.files.length,
      sample_urls,
    };
  }

  const ingestOpts = {
    namespace,
    tags,
    ttlSeconds: ttl,
  };

  let batch;
  try {
    batch = await ingestFiles(scan.files, ingestOpts, resolved.root);
  } catch (err) {
    return {
      ...empty,
      scanned: scan.files.length,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const publicFiles = toPublicFiles(batch.files);

  if (input.wait_for_embed === true) {
    try {
      await getBackgroundIndexQueue().drain();
    } catch (err) {
      return {
        ...empty,
        scanned: scan.files.length,
        indexed: batch.indexed,
        skipped: batch.skipped,
        failed: batch.failed,
        files: publicFiles,
        sample_urls,
        errors: collectErrors(publicFiles),
        error: `embed unavailable: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  const result: IndexOutput = {
    scanned: scan.files.length,
    indexed: batch.indexed,
    skipped: batch.skipped,
    failed: batch.failed,
    namespace,
    files: publicFiles,
    sample_urls,
    errors: collectErrors(publicFiles),
    embed: batch.embed,
  };

  log.info('index complete', {
    indexed: batch.indexed,
    skipped: batch.skipped,
    failed: batch.failed,
    warnings: scan.warnings.length,
  });

  if (input.watch === true) {
    let watcher;
    try {
      watcher = startIndexWatcher({
        root: resolved.root,
        namespace,
        glob,
        recursive: input.recursive !== false,
        ingestOpts,
      });
    } catch (err) {
      return {
        ...result,
        error: `watch failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    result.watching = true;
    await waitForWatchStop();
    watcher.stop();
  }

  return result;
}
