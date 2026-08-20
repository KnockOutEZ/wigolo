import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { getDatabase } from './db.js';
import { createLogger } from '../logger.js';
import { normalizeUrl } from './store.js';
import type { CacheIndexedOutcome, IndexedDocumentWrite } from '../indexing/types.js';

const log = createLogger('cache');

function toIsoSeconds(date: Date): string {
  return date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

/**
 * Write a locally indexed document into url_cache without web-fetch TTL
 * semantics. FTS5 sync triggers maintain the search index automatically.
 */
export function cacheIndexedDocument(doc: IndexedDocumentWrite): CacheIndexedOutcome {
  try {
    const db = getDatabase();
    const normalizedUrl = normalizeUrl(doc.url);
    const namespace = (doc.namespace.trim() || 'docs').toLowerCase();
    const tagsJson = JSON.stringify(doc.tags ?? []);

    const existing = db.prepare(
      'SELECT content_hash FROM url_cache WHERE normalized_url = ? LIMIT 1',
    ).get(normalizedUrl) as { content_hash: string } | undefined;

    if (existing?.content_hash === doc.contentHash) {
      return 'skip';
    }

    const now = new Date();
    let mtimeIso: string | undefined;
    try {
      mtimeIso = statSync(doc.sourcePath).mtime.toISOString();
    } catch {
      // File may disappear between scan/read and write — still persist content.
    }
    const metadata = {
      ...doc.metadata,
      source_path: doc.sourcePath,
      source_root: doc.sourceRoot,
      indexed_at: toIsoSeconds(now),
      ...(mtimeIso ? { mtime: mtimeIso } : {}),
    };

    const stmt = db.prepare(`
      INSERT INTO url_cache (
        url, normalized_url, title, markdown, raw_html,
        metadata, links, images, fetch_method, extractor_used,
        content_hash, fetched_at, expires_at, http_status,
        namespace, tags
      )
      VALUES (
        @url, @normalizedUrl, @title, @markdown, NULL,
        @metadata, '[]', '[]', 'index', @extractorUsed,
        @contentHash, @fetchedAt, @expiresAt, NULL,
        @namespace, @tags
      )
      ON CONFLICT(normalized_url) DO UPDATE SET
        url = excluded.url,
        title = excluded.title,
        markdown = excluded.markdown,
        metadata = excluded.metadata,
        fetch_method = excluded.fetch_method,
        extractor_used = excluded.extractor_used,
        content_hash = excluded.content_hash,
        fetched_at = excluded.fetched_at,
        expires_at = excluded.expires_at,
        namespace = excluded.namespace,
        tags = excluded.tags,
        updated_at = datetime('now')
    `);

    stmt.run({
      url: doc.url,
      normalizedUrl,
      title: doc.title,
      markdown: doc.markdown,
      metadata: JSON.stringify(metadata),
      extractorUsed: doc.extractorUsed,
      contentHash: doc.contentHash,
      fetchedAt: toIsoSeconds(now),
      expiresAt: doc.expiresAt ? toIsoSeconds(doc.expiresAt) : null,
      namespace,
      tags: tagsJson,
    });

    return existing ? 'update' : 'insert';
  } catch (err) {
    log.warn('cacheIndexedDocument failed', {
      url: doc.url,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

export function resolveIndexExpiresAt(
  ttlSeconds: number | null | undefined,
  now: Date,
): Date | null {
  if (ttlSeconds === null || ttlSeconds === 0) return null;
  if (ttlSeconds === undefined) return null;
  if (!Number.isFinite(ttlSeconds) || ttlSeconds < 0) return null;
  return new Date(now.getTime() + ttlSeconds * 1000);
}

export function buildContentHash(markdown: string): string {
  return createHash('sha256').update(markdown).digest('hex');
}
