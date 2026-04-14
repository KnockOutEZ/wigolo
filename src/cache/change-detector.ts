import { createHash } from 'node:crypto';
import { createLogger } from '../logger.js';
import { normalizeUrl, getHashForNormalizedUrl, getMarkdownForNormalizedUrl } from './store.js';
import { computeDiffSummary } from './diff-summary.js';

const log = createLogger('cache');

export interface ChangeResult {
  changed: boolean;
  previousHash?: string;
  diffSummary?: string;
}

export function detectChange(url: string, newMarkdown: string): ChangeResult {
  try {
    const normalizedUrl = normalizeUrl(url);
    const previousHash = getHashForNormalizedUrl(normalizedUrl);

    if (previousHash === null) {
      log.debug('no cached entry for change detection', { url: normalizedUrl });
      return { changed: false };
    }

    const newHash = createHash('sha256').update(newMarkdown).digest('hex');

    if (newHash === previousHash) {
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
      diffSummary,
    });

    return {
      changed: true,
      previousHash,
      diffSummary,
    };
  } catch (err) {
    log.error('change detection failed', {
      url,
      error: err instanceof Error ? err.message : String(err),
    });
    return { changed: false };
  }
}
