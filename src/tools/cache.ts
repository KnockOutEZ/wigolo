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
import { isStudioEmbedKey, getStudioArtifactByEmbedKey, searchStudioArtifactKeys } from '../studio/capture/artifacts.js';
import { createLogger } from '../logger.js';
import type { CacheInput, CacheOutput, CacheResultItem, ChangeReport } from '../types.js';
import type { SmartRouter } from '../fetch/router.js';

const log = createLogger('cache');

// H3: cache.query default limit. The cache table can hold thousands of rows;
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
          // Slice S1 (C2): pass the upstream status code so cache check_changes
          // surfaces 200→404 transitions as changes even when the body hash
          // matches — silent equality on missing pages was the audit's
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
    const limit = input.limit ?? DEFAULT_CACHE_QUERY_LIMIT;
    const results = searchCacheFiltered({
      query: input.query,
      urlPattern: input.url_pattern,
      since: input.since,
      limit,
    });

    const mapped: CacheResultItem[] = results.map((r) => ({
      url: r.url,
      title: r.title,
      markdown: r.markdown,
      fetched_at: r.fetchedAt,
      source: 'cache',
      trusted: false, // url_cache page — page-derived, never trusted as instructions
    }));
    // 4d slice-3: union studio_artifacts FTS hits (only when a query drives FTS).
    // url_cache ranking above is unchanged; studio is appended then the merge is
    // capped to `limit`. Guarded — studio retrieval must never error the cache tool.
    const studioHits = input.query ? studioFtsCacheResults(input.query, limit) : [];
    const merged = dedupeByUrl([...mapped, ...studioHits]).slice(0, limit);
    return { results: applyBudget(merged, input.max_tokens_out) };
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
 * 4d slice-3: studio_artifacts FTS hits as cache results. Hydrates via the shared
 * getStudioArtifactByEmbedKey (no re-derivation); per-row resilient (a missing or
 * stale key is skipped, never surfaced empty). Whole thing is guarded so any
 * failure (e.g. studio retrieval unavailable) degrades to no studio hits rather
 * than erroring the cache tool.
 */
function studioFtsCacheResults(query: string, limit: number): CacheResultItem[] {
  try {
    const keys = searchStudioArtifactKeys(query, limit);
    const out: CacheResultItem[] = [];
    for (const key of keys) {
      try {
        const art = getStudioArtifactByEmbedKey(key);
        if (!art) continue;
        out.push({
          url: key, // C1: the stable studio URI is the identity
          title: art.title ?? key,
          markdown: art.markdown ?? '',
          fetched_at: art.fetchedAt,
          source: 'studio',
          trusted: art.contentTrusted, // mirrors content_trusted (clips/qa => false)
        });
      } catch {
        continue;
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Dedup cache results by url, keeping the first occurrence. url_cache urls and
 * studio://<type>|<id> URIs never collide; this collapses any within-source dups. */
function dedupeByUrl(items: CacheResultItem[]): CacheResultItem[] {
  const seen = new Set<string>();
  const out: CacheResultItem[] = [];
  for (const it of items) {
    if (seen.has(it.url)) continue;
    seen.add(it.url);
    out.push(it);
  }
  return out;
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
  // 4d slice-3: studio_artifacts FTS as a SEPARATE RRF list. The vector side
  // already returns studio://<type>|<id> keys (shared store), so a studio
  // artifact can arrive via BOTH sides and fuse by URI to one result. Guarded.
  let studioFtsRankMap: Map<string, number>;
  try {
    studioFtsRankMap = buildRankMap(searchStudioArtifactKeys(query, candidateLimit));
  } catch {
    studioFtsRankMap = new Map();
  }

  if (ftsRankMap.size === 0 && vecRankMap.size === 0 && studioFtsRankMap.size === 0) return [];

  const fused = reciprocalRankFusion([ftsRankMap, studioFtsRankMap, vecRankMap], 60);
  const ordered = sortByRRFScore(fused);

  const results: CacheResultItem[] = [];
  for (const [key] of ordered) {
    if (results.length >= limit) break;
    // Route by key shape: studio://<type>|<id> hydrates from studio_artifacts BY
    // ID (never new URL'd); url keys via url_cache. Per-row resilient — a miss or
    // throw is skipped, never aborting the batch (the slice-1 lesson).
    if (isStudioEmbedKey(key)) {
      let art;
      try {
        art = getStudioArtifactByEmbedKey(key);
      } catch {
        continue;
      }
      if (!art) continue;
      results.push({
        url: key,
        title: art.title ?? key,
        markdown: art.markdown ?? '',
        fetched_at: art.fetchedAt,
        source: 'studio',
        trusted: art.contentTrusted,
      });
    } else {
      const cached = getCachedContentByNormalizedUrl(key);
      if (!cached) continue;
      results.push({
        url: cached.url,
        title: cached.title,
        markdown: cached.markdown,
        fetched_at: cached.fetchedAt,
        source: 'cache',
        trusted: false,
      });
    }
  }

  return results;
}
