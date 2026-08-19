import { createLogger } from '../logger.js';
import {
  buildContentHash,
  cacheIndexedDocument,
  resolveIndexExpiresAt,
} from '../cache/internal-store.js';
import { getHashForNormalizedUrl, normalizeUrl } from '../cache/store.js';
import { enqueueIndexEmbedSafe, readLocalFile } from './embed.js';
import { buildInternalUrl } from './url-builder.js';
import type {
  IndexFileResult,
  IngestBatchResult,
  IngestOptions,
  ScannedFile,
} from './types.js';

const log = createLogger('indexing');

export { buildInternalUrl, titleFromMarkdown } from './url-builder.js';
export { hashMarkdown } from './embed.js';

export async function ingestFile(
  file: ScannedFile,
  opts: IngestOptions,
  sourceRoot: string,
): Promise<IndexFileResult> {
  const url = buildInternalUrl(opts.namespace, file.relativePath);
  const normalized = normalizeUrl(url);

  let read;
  try {
    read = await readLocalFile(file.absolutePath, file.relativePath);
  } catch (err) {
    return {
      path: file.relativePath,
      url,
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const contentHash = buildContentHash(read.markdown);
  const existing = getHashForNormalizedUrl(normalized);
  if (existing === contentHash) {
    return { path: file.relativePath, url, status: 'skipped' };
  }

  const now = new Date();
  try {
    const outcome = cacheIndexedDocument({
      url,
      title: read.title,
      markdown: read.markdown,
      contentHash,
      namespace: opts.namespace,
      tags: opts.tags,
      expiresAt: resolveIndexExpiresAt(opts.ttlSeconds, now),
      extractorUsed: read.extractorUsed,
      sourcePath: file.absolutePath,
      sourceRoot,
      metadata: {
        mime: read.mime,
        description: `Locally indexed document (${opts.namespace}): ${file.relativePath}`,
        ...(opts.tags.length > 0 ? { keywords: opts.tags } : {}),
      },
    });
    if (outcome === 'skip') {
      return { path: file.relativePath, url, status: 'skipped' };
    }
  } catch (err) {
    return {
      path: file.relativePath,
      url,
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (opts.embed !== false) {
    await enqueueIndexEmbedSafe(url, read.title, read.markdown);
  }

  log.debug('indexed file', { path: file.relativePath, url });
  return { path: file.relativePath, url, status: 'indexed' };
}

export async function ingestFiles(
  files: ScannedFile[],
  opts: IngestOptions,
  sourceRoot: string,
): Promise<IngestBatchResult> {
  const results: IndexFileResult[] = [];
  let indexed = 0;
  let skipped = 0;
  let failed = 0;

  for (const file of files) {
    const r = await ingestFile(file, opts, sourceRoot);
    results.push(r);
    if (r.status === 'indexed') indexed++;
    else if (r.status === 'skipped') skipped++;
    else failed++;
  }

  return {
    indexed,
    skipped,
    failed,
    files: results,
    embed: {
      enqueued: indexed,
      skipped_embed: skipped,
    },
  };
}
