import { searchCacheFiltered, getCacheStats, clearCacheEntries } from '../cache/store.js';
import { detectChange } from '../cache/change-detector.js';
import { createLogger } from '../logger.js';
import type { CacheInput, CacheOutput, ChangeReport } from '../types.js';

const log = createLogger('cache');

export function handleCache(input: CacheInput): CacheOutput {
  try {
    if (input.check_changes) {
      log.info('Checking for content changes', {
        query: input.query,
        urlPattern: input.url_pattern,
        since: input.since,
      });

      const entries = searchCacheFiltered({
        query: input.query,
        urlPattern: input.url_pattern,
        since: input.since,
      });

      const changes: ChangeReport[] = [];
      for (const entry of entries) {
        try {
          const changeResult = detectChange(entry.url, entry.markdown);
          changes.push({
            url: entry.url,
            changed: changeResult.changed,
            current_hash: entry.contentHash,
            ...(changeResult.changed ? {
              previous_hash: changeResult.previousHash,
              diff_summary: changeResult.diffSummary,
            } : {}),
          });
        } catch (err) {
          log.warn('change check failed for URL', {
            url: entry.url,
            error: err instanceof Error ? err.message : String(err),
          });
          changes.push({
            url: entry.url,
            changed: false,
            current_hash: entry.contentHash,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return { changes };
    }

    if (input.stats) {
      log.debug('Cache stats requested');
      return { stats: getCacheStats() };
    }

    if (input.clear) {
      if (!input.query && !input.url_pattern && !input.since) {
        return { error: 'clear requires at least one filter (query, url_pattern, or since)' };
      }
      log.info('Clearing cache entries', {
        query: input.query,
        urlPattern: input.url_pattern,
        since: input.since,
      });
      const count = clearCacheEntries({
        query: input.query,
        urlPattern: input.url_pattern,
        since: input.since,
      });
      return { cleared: count };
    }

    log.debug('Cache search', {
      query: input.query,
      urlPattern: input.url_pattern,
      since: input.since,
    });
    const results = searchCacheFiltered({
      query: input.query,
      urlPattern: input.url_pattern,
      since: input.since,
    });

    return {
      results: results.map((r) => ({
        url: r.url,
        title: r.title,
        markdown: r.markdown,
        fetched_at: r.fetchedAt,
      })),
    };
  } catch (err) {
    log.error('Cache tool error', { error: String(err) });
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
