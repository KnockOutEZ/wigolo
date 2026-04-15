import type {
  FindSimilarInput,
  FindSimilarOutput,
  FindSimilarResult,
  SearchEngine,
  CachedContent,
} from '../types.js';
import type { SmartRouter } from '../fetch/router.js';
import type { BackendStatus } from '../server/backend-status.js';
import { extractKeyTerms, buildFTS5Query } from '../embedding/key-terms.js';
import { reciprocalRankFusion, buildRankMap, sortByRRFScore } from './rrf.js';
import { searchCache, getCachedContent, normalizeUrl } from '../cache/store.js';
import { filterByDomains } from './filters.js';
import { handleSearch } from '../tools/search.js';
import { extractContent } from '../extraction/pipeline.js';
import { getEmbeddingService } from '../embedding/embed.js';
import { createLogger } from '../logger.js';

const log = createLogger('search');

const DEFAULT_MAX_RESULTS = 10;
const MAX_FTS5_CANDIDATES = 20;
const MAX_EMBEDDING_CANDIDATES = 20;
const WEB_SEARCH_QUERY_COUNT = 3;

interface ResolvedSignal {
  terms: string[];
  title: string;
  inputUrl?: string;
  inputNormalizedUrl?: string;
  queryText?: string;
}

export async function findSimilar(
  input: FindSimilarInput,
  engines: SearchEngine[],
  router: SmartRouter,
  backendStatus?: BackendStatus,
): Promise<FindSimilarOutput> {
  const start = Date.now();

  // Probe embedding availability once up front for the whole request
  const embeddingAvailable = checkEmbeddingAvailable();

  try {
    const url = input.url?.trim();
    const concept = input.concept?.trim();

    if (!url && !concept) {
      return {
        results: [],
        method: 'fts5',
        cache_hits: 0,
        search_hits: 0,
        embedding_available: embeddingAvailable,
        error: 'Either url or concept must be provided',
        total_time_ms: Date.now() - start,
      };
    }

    const maxResults = input.max_results ?? DEFAULT_MAX_RESULTS;
    const includeCache = input.include_cache ?? true;
    const includeWeb = input.include_web ?? true;

    const signal = await prepareSignal(url, concept, router);

    if (signal.terms.length === 0 && !signal.queryText) {
      log.warn('no key terms or query text extracted, falling back to web search');

      if (!includeWeb) {
        return {
          results: [],
          method: 'fts5',
          cache_hits: 0,
          search_hits: 0,
          embedding_available: embeddingAvailable,
          error: 'Could not extract key terms from input and web search is disabled',
          total_time_ms: Date.now() - start,
        };
      }
    }

    // Phase 1: FTS5 + embedding in parallel (both hit local state, cheap)
    let cacheResults: FindSimilarResult[] = [];
    const fts5RankMap = new Map<string, number>();
    let embeddingResults: FindSimilarResult[] = [];
    const embeddingRankMap = new Map<string, number>();

    await Promise.all([
      (async () => {
        if (includeCache && signal.terms.length > 0) {
          cacheResults = runFTS5Search(
            signal.terms,
            signal.inputNormalizedUrl,
            input.include_domains,
            input.exclude_domains,
            MAX_FTS5_CANDIDATES,
            fts5RankMap,
          );
          log.debug('FTS5 search complete', { hits: cacheResults.length });
        }
      })(),
      (async () => {
        if (includeCache && embeddingAvailable && signal.queryText) {
          embeddingResults = await runEmbeddingSearch(
            signal.queryText,
            signal.inputNormalizedUrl,
            input.include_domains,
            input.exclude_domains,
            MAX_EMBEDDING_CANDIDATES,
            embeddingRankMap,
          );
          log.debug('embedding search complete', { hits: embeddingResults.length });
        }
      })(),
    ]);

    // Phase 2: Web search fallback (only if combined unique local hits < maxResults)
    let searchResults: FindSimilarResult[] = [];
    const searchRankMap = new Map<string, number>();

    const combinedLocalHits = new Set<string>();
    for (const r of cacheResults) combinedLocalHits.add(safeNormalize(r.url));
    for (const r of embeddingResults) combinedLocalHits.add(safeNormalize(r.url));

    if (combinedLocalHits.size < maxResults && includeWeb) {
      searchResults = await runWebSearchFallback(
        signal,
        engines,
        router,
        backendStatus,
        maxResults,
        signal.inputNormalizedUrl,
        input.include_domains,
        input.exclude_domains,
        searchRankMap,
      );
      log.debug('web search fallback complete', { hits: searchResults.length });
    }

    // Phase 3: 3-way RRF fusion
    const rankedLists: Map<string, number>[] = [];
    if (fts5RankMap.size > 0) rankedLists.push(fts5RankMap);
    if (embeddingRankMap.size > 0) rankedLists.push(embeddingRankMap);
    if (searchRankMap.size > 0) rankedLists.push(searchRankMap);

    const allResults = mergeResults(cacheResults, embeddingResults, searchResults);

    let finalResults: FindSimilarResult[];

    if (rankedLists.length >= 1) {
      finalResults = fuseResults(rankedLists, allResults, maxResults);
    } else {
      finalResults = allResults
        .sort((a, b) => b.relevance_score - a.relevance_score)
        .slice(0, maxResults);
    }

    const method = determineMethod(
      cacheResults.length > 0,
      embeddingResults.length > 0,
      searchResults.length > 0,
    );

    const cacheHits = finalResults.filter(r => r.source === 'cache').length;
    const searchHits = finalResults.filter(r => r.source === 'search').length;

    return {
      results: finalResults,
      method,
      cache_hits: cacheHits,
      search_hits: searchHits,
      embedding_available: embeddingAvailable,
      total_time_ms: Date.now() - start,
    };
  } catch (err) {
    log.error('findSimilar failed', { error: String(err) });
    return {
      results: [],
      method: 'fts5',
      cache_hits: 0,
      search_hits: 0,
      embedding_available: embeddingAvailable,
      error: `find_similar failed: ${err instanceof Error ? err.message : String(err)}`,
      total_time_ms: Date.now() - start,
    };
  }
}

function checkEmbeddingAvailable(): boolean {
  try {
    const svc = getEmbeddingService();
    return svc.isAvailable() && svc.getIndex().size() > 0;
  } catch {
    return false;
  }
}

function safeNormalize(url: string): string {
  try {
    return normalizeUrl(url);
  } catch {
    return url;
  }
}

function mergeResults(...lists: FindSimilarResult[][]): FindSimilarResult[] {
  const seen = new Map<string, FindSimilarResult>();
  for (const list of lists) {
    for (const r of list) {
      const key = safeNormalize(r.url);
      const existing = seen.get(key);
      if (!existing) {
        seen.set(key, r);
      } else {
        // Merge match_signals so fused result records the most-specific source info
        existing.match_signals = {
          ...existing.match_signals,
          ...r.match_signals,
          fused_score: existing.match_signals.fused_score,
        };
      }
    }
  }
  return [...seen.values()];
}

async function prepareSignal(
  url: string | undefined,
  concept: string | undefined,
  router: SmartRouter,
): Promise<ResolvedSignal> {
  if (url) {
    return await prepareSignalFromUrl(url, router);
  }

  if (concept) {
    const terms = extractKeyTerms(concept, '');
    return { terms, title: concept, queryText: concept };
  }

  return { terms: [], title: '' };
}

async function prepareSignalFromUrl(
  url: string,
  router: SmartRouter,
): Promise<ResolvedSignal> {
  let normalizedInputUrl: string;
  try {
    normalizedInputUrl = normalizeUrl(url);
  } catch {
    normalizedInputUrl = url;
  }

  const cached = getCachedContent(url);
  if (cached) {
    const terms = extractKeyTerms(cached.markdown, cached.title);
    return {
      terms,
      title: cached.title,
      inputUrl: url,
      inputNormalizedUrl: normalizedInputUrl,
      queryText: cached.markdown,
    };
  }

  try {
    log.info('fetching URL for signal extraction', { url });
    const raw = await router.fetch(url, { renderJs: 'auto' });
    const extraction = await extractContent(raw.html, raw.finalUrl, {
      contentType: raw.contentType,
    });
    const terms = extractKeyTerms(extraction.markdown, extraction.title);
    return {
      terms,
      title: extraction.title,
      inputUrl: url,
      inputNormalizedUrl: normalizedInputUrl,
      queryText: extraction.markdown,
    };
  } catch (err) {
    log.warn('failed to fetch URL for signal extraction', { url, error: String(err) });
    const urlTerms = extractKeyTerms('', url);
    return {
      terms: urlTerms,
      title: url,
      inputUrl: url,
      inputNormalizedUrl: normalizedInputUrl,
    };
  }
}

async function runEmbeddingSearch(
  queryText: string,
  excludeNormalizedUrl: string | undefined,
  includeDomains: string[] | undefined,
  excludeDomains: string[] | undefined,
  topK: number,
  rankMap: Map<string, number>,
): Promise<FindSimilarResult[]> {
  try {
    const service = getEmbeddingService();
    if (!service.isAvailable() || service.getIndex().size() === 0) return [];

    const excludeUrls = excludeNormalizedUrl ? new Set([excludeNormalizedUrl]) : undefined;
    const similar = await service.findSimilar(queryText, topK, excludeUrls);
    if (similar.length === 0) return [];

    // Hydrate with cached content and apply domain filters on the hydrated pool
    const hydrated: Array<{ entry: CachedContent | null; url: string; score: number }> = [];
    for (const { url: nUrl, score } of similar) {
      const cached = getCachedContent(nUrl);
      hydrated.push({ entry: cached, url: nUrl, score });
    }

    const filterableInputs = hydrated.map(h => ({
      url: h.entry?.url ?? h.url,
    })) as unknown as CachedContent[];
    const filtered = filterByDomains(filterableInputs, includeDomains, excludeDomains) as unknown as Array<{
      url: string;
    }>;
    const allowedUrls = new Set(filtered.map(f => f.url));

    const results: FindSimilarResult[] = [];
    let rank = 0;
    for (const h of hydrated) {
      const displayUrl = h.entry?.url ?? h.url;
      if (!allowedUrls.has(displayUrl)) continue;

      rank++;
      rankMap.set(safeNormalize(displayUrl), rank);

      results.push({
        url: displayUrl,
        title: h.entry?.title ?? displayUrl,
        markdown: (h.entry?.markdown ?? '').slice(0, 5000),
        relevance_score: h.score,
        source: 'cache',
        match_signals: {
          embedding_rank: rank,
          fused_score: 0,
        },
      });
    }

    return results;
  } catch (err) {
    log.warn('embedding search failed', { error: String(err) });
    return [];
  }
}

function runFTS5Search(
  terms: string[],
  excludeNormalizedUrl: string | undefined,
  includeDomains: string[] | undefined,
  excludeDomains: string[] | undefined,
  maxCandidates: number,
  rankMap: Map<string, number>,
): FindSimilarResult[] {
  try {
    const fts5Query = buildFTS5Query(terms);
    if (!fts5Query) return [];

    let cached = searchCache(fts5Query);

    if (excludeNormalizedUrl) {
      cached = cached.filter(c => {
        try {
          return normalizeUrl(c.url) !== excludeNormalizedUrl;
        } catch {
          return c.url !== excludeNormalizedUrl;
        }
      });
    }

    cached = filterByDomains(cached, includeDomains, excludeDomains) as CachedContent[];
    cached = cached.slice(0, maxCandidates);

    const results: FindSimilarResult[] = [];
    for (let i = 0; i < cached.length; i++) {
      const entry = cached[i];
      let nUrl: string;
      try {
        nUrl = normalizeUrl(entry.url);
      } catch {
        nUrl = entry.url;
      }

      rankMap.set(nUrl, i + 1);

      results.push({
        url: entry.url,
        title: entry.title,
        markdown: entry.markdown.slice(0, 5000),
        relevance_score: 0,
        source: 'cache',
        match_signals: {
          fts5_rank: i + 1,
          fused_score: 0,
        },
      });
    }

    return results;
  } catch (err) {
    log.error('FTS5 search failed', { error: String(err) });
    return [];
  }
}

async function runWebSearchFallback(
  signal: ResolvedSignal,
  engines: SearchEngine[],
  router: SmartRouter,
  backendStatus: BackendStatus | undefined,
  maxResults: number,
  excludeNormalizedUrl: string | undefined,
  includeDomains: string[] | undefined,
  excludeDomains: string[] | undefined,
  rankMap: Map<string, number>,
): Promise<FindSimilarResult[]> {
  try {
    const queries = generateSearchQueries(signal.terms, signal.title);
    if (queries.length === 0) return [];

    const allResults: FindSimilarResult[] = [];
    const seenUrls = new Set<string>();

    if (excludeNormalizedUrl) {
      seenUrls.add(excludeNormalizedUrl);
    }

    for (const query of queries) {
      try {
        const searchOutput = await handleSearch(
          {
            query,
            max_results: maxResults,
            include_content: true,
            include_domains: includeDomains,
            exclude_domains: excludeDomains,
          },
          engines,
          router,
          backendStatus,
        );

        for (const item of searchOutput.results) {
          let nUrl: string;
          try {
            nUrl = normalizeUrl(item.url);
          } catch {
            nUrl = item.url;
          }

          if (seenUrls.has(nUrl)) continue;
          seenUrls.add(nUrl);

          const rank = allResults.length + 1;
          rankMap.set(nUrl, rank);

          allResults.push({
            url: item.url,
            title: item.title,
            markdown: (item.markdown_content ?? item.snippet).slice(0, 5000),
            relevance_score: item.relevance_score,
            source: 'search',
            match_signals: {
              fused_score: 0,
            },
          });
        }
      } catch (err) {
        log.warn('web search query failed', { query, error: String(err) });
      }
    }

    try {
      const embeddingService = getEmbeddingService();
      if (embeddingService.isAvailable()) {
        for (const result of allResults) {
          if (result.markdown) {
            embeddingService.embedAsync(result.url, result.markdown);
          }
        }
      }
    } catch (err) {
      log.debug('embedding hook skipped for find_similar results', { error: String(err) });
    }

    return allResults;
  } catch (err) {
    log.error('web search fallback failed', { error: String(err) });
    return [];
  }
}

function generateSearchQueries(terms: string[], title: string): string[] {
  if (terms.length === 0 && !title) return [];

  const queries: string[] = [];

  if (title && title.length > 3) {
    queries.push(title.slice(0, 150));
  }

  if (terms.length >= 3) {
    queries.push(terms.slice(0, 5).join(' '));
  }

  if (terms.length >= 2) {
    queries.push(`${terms.slice(0, 3).join(' ')} tutorial guide`);
  }

  const unique = [...new Set(queries)];
  return unique.slice(0, WEB_SEARCH_QUERY_COUNT);
}

function fuseResults(
  rankedLists: Map<string, number>[],
  allResults: FindSimilarResult[],
  maxResults: number,
): FindSimilarResult[] {
  const scores = reciprocalRankFusion(rankedLists);
  const sorted = sortByRRFScore(scores);

  const resultsByNormalizedUrl = new Map<string, FindSimilarResult>();
  for (const r of allResults) {
    const key = safeNormalize(r.url);
    if (!resultsByNormalizedUrl.has(key)) {
      resultsByNormalizedUrl.set(key, r);
    }
  }

  const fused: FindSimilarResult[] = [];
  for (const [nUrl, score] of sorted) {
    if (fused.length >= maxResults) break;

    const result = resultsByNormalizedUrl.get(nUrl);
    if (!result) continue;

    fused.push({
      ...result,
      relevance_score: score,
      match_signals: {
        ...result.match_signals,
        fused_score: score,
      },
    });
  }

  return fused;
}

function determineMethod(
  hasCache: boolean,
  hasEmbedding: boolean,
  hasSearch: boolean,
): FindSimilarOutput['method'] {
  const sources = [hasCache, hasEmbedding, hasSearch].filter(Boolean).length;
  if (sources >= 2) return 'hybrid';
  if (hasEmbedding) return 'embedding';
  if (hasCache) return 'fts5';
  if (hasSearch) return 'search';
  return 'fts5';
}
