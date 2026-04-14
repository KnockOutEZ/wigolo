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
import { createLogger } from '../logger.js';

const log = createLogger('search');

const DEFAULT_MAX_RESULTS = 10;
const MAX_FTS5_CANDIDATES = 20;
const WEB_SEARCH_QUERY_COUNT = 3;

interface ResolvedSignal {
  terms: string[];
  title: string;
  inputUrl?: string;
  inputNormalizedUrl?: string;
}

export async function findSimilar(
  input: FindSimilarInput,
  engines: SearchEngine[],
  router: SmartRouter,
  backendStatus?: BackendStatus,
): Promise<FindSimilarOutput> {
  const start = Date.now();

  try {
    const url = input.url?.trim();
    const concept = input.concept?.trim();

    if (!url && !concept) {
      return {
        results: [],
        method: 'fts5',
        cache_hits: 0,
        search_hits: 0,
        embedding_available: false,
        error: 'Either url or concept must be provided',
        total_time_ms: Date.now() - start,
      };
    }

    const maxResults = input.max_results ?? DEFAULT_MAX_RESULTS;
    const includeCache = input.include_cache ?? true;
    const includeWeb = input.include_web ?? true;

    const signal = await prepareSignal(url, concept, router);

    if (signal.terms.length === 0) {
      log.warn('no key terms extracted, falling back to web search');

      if (!includeWeb) {
        return {
          results: [],
          method: 'fts5',
          cache_hits: 0,
          search_hits: 0,
          embedding_available: false,
          error: 'Could not extract key terms from input and web search is disabled',
          total_time_ms: Date.now() - start,
        };
      }
    }

    // FTS5 search on cache
    let cacheResults: FindSimilarResult[] = [];
    const fts5RankMap = new Map<string, number>();

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

    // Web search fallback
    let searchResults: FindSimilarResult[] = [];
    const searchRankMap = new Map<string, number>();

    if (cacheResults.length < maxResults && includeWeb) {
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

    // Fuse results via RRF
    const rankedLists: Map<string, number>[] = [];
    if (fts5RankMap.size > 0) rankedLists.push(fts5RankMap);
    if (searchRankMap.size > 0) rankedLists.push(searchRankMap);

    let finalResults: FindSimilarResult[];

    if (rankedLists.length >= 1) {
      finalResults = fuseResults(rankedLists, cacheResults, searchResults, maxResults);
    } else {
      finalResults = [...cacheResults, ...searchResults]
        .sort((a, b) => b.relevance_score - a.relevance_score)
        .slice(0, maxResults);
    }

    const method = determineMethod(cacheResults.length > 0, searchResults.length > 0);

    const cacheHits = finalResults.filter(r => r.source === 'cache').length;
    const searchHits = finalResults.filter(r => r.source === 'search').length;

    return {
      results: finalResults,
      method,
      cache_hits: cacheHits,
      search_hits: searchHits,
      embedding_available: false,
      total_time_ms: Date.now() - start,
    };
  } catch (err) {
    log.error('findSimilar failed', { error: String(err) });
    return {
      results: [],
      method: 'fts5',
      cache_hits: 0,
      search_hits: 0,
      embedding_available: false,
      error: `find_similar failed: ${err instanceof Error ? err.message : String(err)}`,
      total_time_ms: Date.now() - start,
    };
  }
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
    return { terms, title: concept };
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
  cacheResults: FindSimilarResult[],
  searchResults: FindSimilarResult[],
  maxResults: number,
): FindSimilarResult[] {
  const scores = reciprocalRankFusion(rankedLists);
  const sorted = sortByRRFScore(scores);

  const resultsByNormalizedUrl = new Map<string, FindSimilarResult>();
  for (const r of [...cacheResults, ...searchResults]) {
    let key: string;
    try {
      key = normalizeUrl(r.url);
    } catch {
      key = r.url;
    }
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
  hasSearch: boolean,
): FindSimilarOutput['method'] {
  if (hasCache && hasSearch) return 'hybrid';
  if (hasCache) return 'fts5';
  if (hasSearch) return 'search';
  return 'fts5';
}
