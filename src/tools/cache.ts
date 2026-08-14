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
import { applyCacheOutputBudget, DEFAULT_CHECK_CHANGES_LIMIT } from '../cache/output-budget.js';
import { getEmbedProvider } from '../providers/embed-provider.js';
import { getVectorStore } from '../providers/vector-store.js';
import {
  ensureArtifactProviders,
  isArtifactKey,
  resolveArtifact,
  searchArtifactKeys,
} from '../cache/artifact-registry.js';
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

      // Unbounded, this matched every cached entry and re-fetched all of them:
      // 358,152 chars of reports over 1,134 URLs on a real cache, and 1,134
      // live requests from one tool call. The cap bounds both.
      const matched = searchCacheFiltered({
        query: input.query,
        urlPattern: input.url_pattern,
        since: input.since,
      });
      const checkLimit = input.limit ?? DEFAULT_CHECK_CHANGES_LIMIT;
      const entries = matched.slice(0, checkLimit);

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

      if (entries.length < matched.length) {
        return {
          changes,
          changes_truncation: {
            matched: matched.length,
            checked: entries.length,
            hint:
              `Checked the first ${entries.length} of ${matched.length} matching entries. ` +
              'Raise limit to check more, or narrow with query / url_pattern / since.',
          },
        };
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
      if (results !== null) return applyCacheOutputBudget(results, input.max_tokens_out);
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
    // 4d slice-3: union registered artifact providers' FTS hits (only when a query drives FTS).
    // url_cache ranking above is unchanged; provider hits are appended then the merge is capped to
    // `limit`. Guarded — artifact retrieval must never error the cache tool.
    const artifactHits = input.query ? await artifactCacheResults(input.query, limit) : [];
    const merged = dedupeByUrl([...mapped, ...artifactHits]).slice(0, limit);
    return applyCacheOutputBudget(merged, input.max_tokens_out);
  } catch (err) {
    log.error('Cache tool error', { error: String(err) });
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * 4d slice-3: artifact-provider FTS hits as cache results. The provider hydrates each key (no
 * re-derivation) and supplies the `source` value, so this path names no product. Per-row resilient
 * (a missing or stale key is skipped, never surfaced empty). Whole thing is guarded so any failure
 * (e.g. a provider's store unavailable) degrades to no artifact hits rather than erroring the tool.
 */
async function artifactCacheResults(query: string, limit: number): Promise<CacheResultItem[]> {
  try {
    await ensureArtifactProviders();
    const keys = searchArtifactKeys(query, limit);
    const out: CacheResultItem[] = [];
    for (const key of keys) {
      const hit = resolveArtifact(key);
      if (!hit) continue;
      out.push({
        url: key, // C1: the provider's stable URI is the identity
        title: hit.record.title ?? key,
        markdown: hit.record.markdown ?? '',
        fetched_at: hit.record.fetchedAt,
        source: hit.provider,
        trusted: hit.record.trusted, // mirrors the provider's content-trust tag
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** Dedup cache results by url, keeping the first occurrence. url_cache urls and provider artifact
 * URIs never collide; this collapses any within-source dups. */
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
  // 4d slice-3: artifact-provider FTS as a SEPARATE RRF list. The vector side already returns
  // provider artifact keys (shared store), so one artifact can arrive via BOTH sides and fuse by
  // URI to a single result. Guarded.
  let artifactRankMap: Map<string, number>;
  try {
    await ensureArtifactProviders();
    artifactRankMap = buildRankMap(searchArtifactKeys(query, candidateLimit));
  } catch {
    artifactRankMap = new Map();
  }

  if (ftsRankMap.size === 0 && vecRankMap.size === 0 && artifactRankMap.size === 0) return [];

  const fused = reciprocalRankFusion([ftsRankMap, artifactRankMap, vecRankMap], 60);
  const ordered = sortByRRFScore(fused);

  const results: CacheResultItem[] = [];
  for (const [key] of ordered) {
    if (results.length >= limit) break;
    // Route by owner: a provider artifact key hydrates from its provider BY ID (never new URL'd);
    // url keys via url_cache. Per-row resilient — a miss or throw is skipped, never aborting the
    // batch (the slice-1 lesson).
    if (isArtifactKey(key)) {
      const hit = resolveArtifact(key);
      if (!hit) continue;
      results.push({
        url: key,
        title: hit.record.title ?? key,
        markdown: hit.record.markdown ?? '',
        fetched_at: hit.record.fetchedAt,
        source: hit.provider,
        trusted: hit.record.trusted,
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
