import { createHash } from 'node:crypto';
import { createLogger } from '../logger.js';
import {
  normalizeUrl,
  getHashAndStatusForNormalizedUrl,
  getMarkdownForNormalizedUrl,
} from './store.js';
import { computeDiffSummary } from './diff-summary.js';

const log = createLogger('cache');

export interface ChangeResult {
  changed: boolean;
  previousHash?: string;
  diffSummary?: string;
  /** When the upstream status code transitioned (e.g.
   *  200 → 404), report the previous one so callers can distinguish a
   *  status flip from a content edit. Absent when the previous status was
   *  null/unknown or did not change. */
  previousHttpStatus?: number;
}

/**
 * Change detection compares HTTP status alongside the
 * body hash. A 200 page that becomes a 404 with an identical-looking body
 * (or vice-versa) IS a change — pretending otherwise is a silent-failure
 * mode.
 */
export function detectChange(url: string, newMarkdown: string, newHttpStatus?: number): ChangeResult {
  try {
    const normalizedUrl = normalizeUrl(url);
    // One SELECT for both columns, not two.
    const { hash: previousHash, status: previousStatus } =
      getHashAndStatusForNormalizedUrl(normalizedUrl);

    if (previousHash === null) {
      log.debug('no cached entry for change detection', { url: normalizedUrl });
      return { changed: false };
    }

    const newHash = createHash('sha256').update(newMarkdown).digest('hex');
    const statusChanged =
      previousStatus !== null &&
      typeof newHttpStatus === 'number' &&
      previousStatus !== newHttpStatus;

    if (newHash === previousHash && !statusChanged) {
      log.debug('content unchanged', { url: normalizedUrl, hash: newHash });
      return { changed: false };
    }

    const previousMarkdown = getMarkdownForNormalizedUrl(normalizedUrl);
    const diffSummary = previousMarkdown !== null
      ? computeDiffSummary(previousMarkdown, newMarkdown)
      : undefined;

    log.info('content change detected', {
      url: normalizedUrl,
      previousHash,
      newHash,
      previousStatus,
      newHttpStatus,
      statusChanged,
      diffSummary,
    });

    return {
      changed: true,
      previousHash,
      diffSummary,
      ...(statusChanged ? { previousHttpStatus: previousStatus } : {}),
    };
  } catch (err) {
    log.error('change detection failed', {
      url,
      error: err instanceof Error ? err.message : String(err),
    });
    return { changed: false };
  }
}
