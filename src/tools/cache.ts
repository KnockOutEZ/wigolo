import {
  searchCacheFiltered,
  getCacheStats,
  clearCacheEntries,
  ftsSearchRanked,
  getCachedContentByNormalizedUrl,
} from '../cache/store.js';
import { detectChange } from '../cache/change-detector.js';
import { getExtractProvider } from '../providers/extract-provider.js';
import { reciprocalRankFusion, sortByRRFScore, buildRankMap } from '../search/rrf.js';
import { applyAggregateMarkdownBudget } from '../search/evidence.js';
import { getEmbedProvider } from '../providers/embed-provider.js';
import { getVectorStore } from '../providers/vector-store.js';
import { createLogger } from '../logger.js';
import type { CacheInput, CacheOutput, CacheResultItem, ChangeReport } from '../types.js';
import type { SmartRouter } from '../fetch/router.js';

const log = createLogger('cache');

// cache.query default limit. The cache table can hold thousands of rows;
// without a tight default the response easily blows token budgets. Callers who
// genuinely need more results still get them by passing `limit` explicitly.
const DEFAULT_CACHE_QUERY_LIMIT = 5;
const DEFAULT_HYBRID_LIMIT = 5;
const HYBRID_CANDIDATE_FLOOR = 50;
const HYBRID_CANDIDATE_FACTOR = 5;

export async function handleCache(input: CacheInput, router?: SmartRouter): Promise<CacheOutput> {
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
          if (!router) {
            changes.push({
              url: entry.url,
              changed: false,
              current_hash: entry.contentHash,
              error: 'no router available for re-fetch',
            });
            continue;
          }
          const raw = await router.fetch(entry.url, { renderJs: 'auto' });
          const extractor = await getExtractProvider();
          const extraction = await extractor.extract(raw.html, raw.finalUrl, {
            contentType: raw.contentType,
          });
          // Pass the upstream status code so cache check_changes
          // surfaces 200→404 transitions as changes even when the body hash
          // matches — silent equality on missing pages was a
          // "cache treats 404 as identical content" failure mode.
          const changeResult = detectChange(entry.url, extraction.markdown, raw.statusCode);
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

    if (input.mode === 'hybrid' && input.query) {
      log.debug('Cache hybrid search', {
        query: input.query,
        limit: input.limit,
      });
      const results = await runHybridSearch(input);
      if (results !== null) return { results: applyBudget(results, input.max_tokens_out) };
      // fall through to FTS-only when hybrid was unavailable
    }

    log.debug('Cache search', {
      query: input.query,
      urlPattern: input.url_pattern,
      since: input.since,
      mode: input.mode,
      limit: input.limit,
    });
    const results = searchCacheFiltered({
      query: input.query,
      urlPattern: input.url_pattern,
      since: input.since,
      limit: input.limit ?? DEFAULT_CACHE_QUERY_LIMIT,
    });

    const mapped: CacheResultItem[] = results.map((r) => ({
      url: r.url,
      title: r.title,
      markdown: r.markdown,
      fetched_at: r.fetchedAt,
    }));
    return { results: applyBudget(mapped, input.max_tokens_out) };
  } catch (err) {
    log.error('Cache tool error', { error: String(err) });
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

// Trim the aggregate markdown body across results so the response stays under
// `max_tokens_out`. Bodies past the budget are emptied; results never disappear
// from the list (a callers can still see URL/title/fetched_at for trimmed rows).
function applyBudget(results: CacheResultItem[], maxTokensOut?: number): CacheResultItem[] {
  if (maxTokensOut === undefined) return results;
  applyAggregateMarkdownBudget(
    results,
    (r) => r.markdown,
    (r, body) => { r.markdown = body; },
    { maxTokensOut },
  );
  return results;
}

/**
 * Hybrid FTS5 + vector search fused with reciprocal rank fusion.
 *
 * Pulls `max(limit*5, 50)` candidates from each ranking, fuses with RRF
 * (k=60), then hydrates the top `limit` into cache rows. Returns `null`
 * when the vector path is unavailable so the caller falls back to FTS-only.
 */
async function runHybridSearch(input: CacheInput): Promise<CacheResultItem[] | null> {
  const query = input.query ?? '';
  const limit = Math.max(1, input.limit ?? DEFAULT_HYBRID_LIMIT);
  const candidateLimit = Math.max(HYBRID_CANDIDATE_FLOOR, limit * HYBRID_CANDIDATE_FACTOR);

  let embedProvider;
  let store;
  try {
    [embedProvider, store] = await Promise.all([getEmbedProvider(), getVectorStore()]);
  } catch (err) {
    log.warn('hybrid search unavailable — embed/vector provider failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  const indexSize = await store.size();
  if (indexSize === 0) {
    log.debug('hybrid search skipped — vector index empty');
    return null;
  }

  let queryVectors: Float32Array[];
  try {
    queryVectors = await embedProvider.embed([query]);
  } catch (err) {
    log.warn('hybrid search aborted — query embedding failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  const queryVector = queryVectors[0];
  if (!queryVector || queryVector.length === 0) return null;

  const [ftsHits, vecHits] = await Promise.all([
    Promise.resolve(ftsSearchRanked(query, candidateLimit)),
    store.search(queryVector, candidateLimit),
  ]);

  const ftsRankMap = buildRankMap(ftsHits.map(h => h.url));
  const vecRankMap = buildRankMap(vecHits.map(h => h.metadata.url));

  if (ftsRankMap.size === 0 && vecRankMap.size === 0) return [];

  const fused = reciprocalRankFusion([ftsRankMap, vecRankMap], 60);
  const ordered = sortByRRFScore(fused);

  const results: CacheResultItem[] = [];
  for (const [normalizedUrl] of ordered) {
    if (results.length >= limit) break;
    const cached = getCachedContentByNormalizedUrl(normalizedUrl);
    if (!cached) continue;
    results.push({
      url: cached.url,
      title: cached.title,
      markdown: cached.markdown,
      fetched_at: cached.fetchedAt,
    });
  }

  return results;
}
