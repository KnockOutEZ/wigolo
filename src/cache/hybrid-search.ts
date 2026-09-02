import {
  ftsSearchRanked,
  getCachedContentByNormalizedUrl,
  searchCacheFiltered,
} from './store.js';
import {
  ensureArtifactProviders,
  isArtifactKey,
  resolveArtifact,
  searchArtifactKeys,
} from './artifact-registry.js';
import { getEmbedProvider } from '../providers/embed-provider.js';
import { getVectorStore } from '../providers/vector-store.js';
import { buildRankMap, reciprocalRankFusion, sortByRRFScore } from '../search/rrf.js';
import { createLogger } from '../logger.js';
import type { CacheResultItem } from '../types.js';

const log = createLogger('cache');
const DEFAULT_CACHE_QUERY_LIMIT = 5;
const DEFAULT_HYBRID_LIMIT = 5;
const HYBRID_CANDIDATE_FLOOR = 50;
const HYBRID_CANDIDATE_FACTOR = 5;

export interface HybridSearchInput {
  query: string;
  urlPattern?: string;
  since?: string;
  limit?: number;
}

export type HybridSearchMethod = 'hybrid' | 'fts';

export interface HybridSearchResult {
  results: CacheResultItem[];
  method: HybridSearchMethod;
}

/** FTS-only cache search shared by ordinary tool reads and hybrid degradation. */
export async function runFtsCacheSearch(input: HybridSearchInput): Promise<CacheResultItem[]> {
  const limit = input.limit ?? DEFAULT_CACHE_QUERY_LIMIT;
  const cached = searchCacheFiltered({
    query: input.query,
    urlPattern: input.urlPattern,
    since: input.since,
    limit,
  }).map((row): CacheResultItem => ({
    url: row.url,
    title: row.title,
    markdown: row.markdown,
    fetched_at: row.fetchedAt,
    source: 'cache',
    trusted: false,
  }));
  const artifacts = input.query ? await artifactCacheResults(input.query, limit) : [];
  return dedupeByUrl([...cached, ...artifacts]).slice(0, limit);
}

/**
 * Hybrid FTS5 + vector search fused with reciprocal rank fusion.
 *
 * Degradation is explicit for Library consumers: when the vector path is not
 * available, this function performs the same FTS search and returns `method:
 * 'fts'` beside it. Callers therefore never have to infer degradation from an
 * empty or nullable result.
 */
export async function runHybridSearch(input: HybridSearchInput): Promise<HybridSearchResult> {
  const query = input.query;
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
    return { results: await runFtsCacheSearch(input), method: 'fts' };
  }

  const indexSize = await store.size();
  if (indexSize === 0) {
    log.debug('hybrid search skipped — vector index empty');
    return { results: await runFtsCacheSearch(input), method: 'fts' };
  }

  let queryVectors: Float32Array[];
  try {
    queryVectors = await embedProvider.embed([query]);
  } catch (err) {
    log.warn('hybrid search aborted — query embedding failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { results: await runFtsCacheSearch(input), method: 'fts' };
  }
  const queryVector = queryVectors[0];
  if (!queryVector || queryVector.length === 0) {
    return { results: await runFtsCacheSearch(input), method: 'fts' };
  }

  const [ftsHits, vecHits] = await Promise.all([
    Promise.resolve(ftsSearchRanked(query, candidateLimit)),
    store.search(queryVector, candidateLimit),
  ]);
  const ftsRankMap = buildRankMap(ftsHits.map((hit) => hit.url));
  const vecRankMap = buildRankMap(vecHits.map((hit) => hit.metadata.url));
  let artifactRankMap: Map<string, number>;
  try {
    await ensureArtifactProviders();
    artifactRankMap = buildRankMap(searchArtifactKeys(query, candidateLimit));
  } catch {
    artifactRankMap = new Map();
  }

  if (ftsRankMap.size === 0 && vecRankMap.size === 0 && artifactRankMap.size === 0) {
    return { results: [], method: 'hybrid' };
  }

  const fused = reciprocalRankFusion([ftsRankMap, artifactRankMap, vecRankMap], 60);
  const ordered = sortByRRFScore(fused);
  const results: CacheResultItem[] = [];
  for (const [key] of ordered) {
    if (results.length >= limit) break;
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
  return { results, method: 'hybrid' };
}

async function artifactCacheResults(query: string, limit: number): Promise<CacheResultItem[]> {
  try {
    await ensureArtifactProviders();
    const keys = searchArtifactKeys(query, limit);
    const out: CacheResultItem[] = [];
    for (const key of keys) {
      const hit = resolveArtifact(key);
      if (!hit) continue;
      out.push({
        url: key,
        title: hit.record.title ?? key,
        markdown: hit.record.markdown ?? '',
        fetched_at: hit.record.fetchedAt,
        source: hit.provider,
        trusted: hit.record.trusted,
      });
    }
    return out;
  } catch {
    return [];
  }
}

function dedupeByUrl(items: CacheResultItem[]): CacheResultItem[] {
  const seen = new Set<string>();
  const out: CacheResultItem[] = [];
  for (const item of items) {
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    out.push(item);
  }
  return out;
}
