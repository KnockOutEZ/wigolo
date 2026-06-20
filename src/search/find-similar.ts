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
import { reciprocalRankFusion, sortByRRFScore } from './rrf.js';
import { searchCache, getCachedContent, normalizeUrl, getCacheStats } from '../cache/store.js';
import { filterByDomains } from './filters.js';
import { handleSearch } from '../tools/search.js';
import { getExtractProvider } from '../providers/extract-provider.js';
import { getEmbeddingService } from '../embedding/embed.js';
import { isStudioEmbedKey, getStudioArtifactByEmbedKey } from '../studio/capture/artifacts.js';
import { createLogger } from '../logger.js';
import { getConfig } from '../config.js';
import { selectMode } from './find-similar/mode.js';
import { crawlRank } from './find-similar/crawl-rank.js';

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

  // Snapshot cache/embedding posture BEFORE the web fallback writes new
  // entries into cache, otherwise the cold-start note would wrongly report a
  // populated cache simply because we just fetched during this call.
  const initialCacheSize = safeCacheCount();
  const initialEmbedIndexSize = safeEmbedIndexSize();

  try {
    // Mode dispatch: only 'crawl-rank' diverts. All other modes (cache,
    // web-expansion, auto) fall through to the existing hybrid flow.
    const mode = selectMode(input);
    if (mode === 'crawl-rank') {
      const seed = input.url?.trim();
      if (!seed) {
        return {
          results: [],
          method: 'fts5',
          cache_hits: 0,
          search_hits: 0,
          embedding_available: embeddingAvailable,
          error: 'crawl-rank mode requires a url',
          total_time_ms: Date.now() - start,
        };
      }
      const cr = await crawlRank(seed, input, router);
      return { ...cr, total_time_ms: Date.now() - start };
    }

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

      // After web fallback, re-run embedding search against newly-populated index.
      // The web fallback used embedAndStore() (awaited) so vectors are already in
      // the index — no sleep needed, just re-query.
      if (embeddingAvailable && signal.queryText && searchResults.length > 0) {
        const freshEmbeddingResults = await runEmbeddingSearch(
          signal.queryText,
          signal.inputNormalizedUrl,
          input.include_domains,
          input.exclude_domains,
          MAX_EMBEDDING_CANDIDATES,
          embeddingRankMap,
        );

        if (freshEmbeddingResults.length > 0) {
          embeddingResults = freshEmbeddingResults;
          log.debug('re-ran embedding search after web fallback', { hits: embeddingResults.length });
        }
      }
    }

    // Phase 3: 3-way RRF fusion
    const rankedLists: Map<string, number>[] = [];
    if (fts5RankMap.size > 0) rankedLists.push(fts5RankMap);
    if (embeddingRankMap.size > 0) rankedLists.push(embeddingRankMap);
    if (searchRankMap.size > 0) rankedLists.push(searchRankMap);

    const allResults = mergeResults(cacheResults, embeddingResults, searchResults);

    let finalResults: FindSimilarResult[];
    let topRawScore = 0;

    if (rankedLists.length >= 1) {
      const fused = fuseResults(rankedLists, allResults, maxResults);
      finalResults = fused.results;
      topRawScore = fused.topRawScore;
    } else {
      finalResults = allResults
        .sort((a, b) => b.relevance_score - a.relevance_score)
        .slice(0, maxResults);
    }

    // H8: hard post-filter on raw fused_score. Empty result is the correct
    // answer when nothing meets the threshold — do not silently relax.
    // Filters on the raw RRF signal because that's the field the audit case
    // reports against (`threshold: 0.95` vs `fused_score: 0.029`); the
    // normalized relevance_score top-scales to 1.0 and would always pass.
    const threshold = input.threshold ?? 0;
    if (threshold > 0) {
      finalResults = finalResults.filter(
        (r) => r.match_signals.fused_score >= threshold,
      );
    }

    const method = determineMethod(
      cacheResults.length > 0,
      embeddingResults.length > 0,
      searchResults.length > 0,
    );

    const cacheHits = finalResults.filter(r => r.source === 'cache').length;
    const searchHits = finalResults.filter(r => r.source === 'search').length;

    // Weak-signal cold_start (sub-ticket 2.8): when the raw RRF top score is
    // below the configured threshold, fuseResults' normalization to 1.0 is
    // hiding the truth — the match is weak. Surface that to the caller and
    // replace per-result relevance_score with the raw fused_score so callers
    // see the real signal strength instead of the normalization lie.
    const coldStartThreshold = safeColdStartThreshold();
    const weakSignal =
      rankedLists.length >= 1 &&
      finalResults.length > 0 &&
      topRawScore > 0 &&
      coldStartThreshold > 0 &&
      topRawScore < coldStartThreshold;

    if (weakSignal) {
      for (const r of finalResults) {
        r.relevance_score = r.match_signals.fused_score;
      }
    }

    // Slice S7 (M10): opt-in ranking_debug — emit per-result fts5_rank /
    // embedding_rank / web_rank plus raw rrf_score so the caller can audit
    // disagreement between the three ranking sources. Off by default so the
    // standard response shape stays slim.
    if (input.include_ranking_debug) {
      for (const r of finalResults) {
        const key = safeNormalize(r.url);
        const debug: {
          fts5_rank?: number;
          embedding_rank?: number;
          web_rank?: number;
          rrf_score: number;
        } = {
          rrf_score: r.match_signals.fused_score,
        };
        const fts = fts5RankMap.get(key);
        if (fts !== undefined) debug.fts5_rank = fts;
        const emb = embeddingRankMap.get(key);
        if (emb !== undefined) debug.embedding_rank = emb;
        const web = searchRankMap.get(key);
        if (web !== undefined) debug.web_rank = web;
        r.ranking_debug = debug;
      }
    }

    const queryForNote = (input.concept?.trim() || input.url?.trim() || '').slice(0, 200);
    const conceptMode = !!input.concept?.trim() && !input.url?.trim();
    const baseNote = buildColdStartNote(
      cacheHits,
      searchHits,
      embeddingAvailable,
      initialCacheSize,
      initialEmbedIndexSize,
      conceptMode,
      finalResults.length,
    );
    const weakNote = weakSignal
      ? buildWeakSignalNote(queryForNote, topRawScore, coldStartThreshold)
      : undefined;
    const coldStart = [baseNote, weakNote].filter(Boolean).join(' ') || undefined;

    return {
      results: finalResults,
      method,
      cache_hits: cacheHits,
      search_hits: searchHits,
      embedding_available: embeddingAvailable,
      ...(coldStart ? { cold_start: coldStart } : {}),
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
    // Available = service initialized + subprocess verified (Python + model work).
    // We no longer require index.size() > 0 because the embedding path can
    // generate query embeddings on-the-fly and compare against freshly-embedded
    // web fallback results within the same request.
    return svc.isAvailable() && svc.isSubprocessReady();
  } catch {
    return false;
  }
}

function safeCacheCount(): number {
  try {
    return getCacheStats().total_urls;
  } catch {
    return 0;
  }
}

function safeEmbedIndexSize(): number {
  try {
    return getEmbeddingService().getIndex().size();
  } catch {
    return 0;
  }
}

// Surface a note when local hybrid signals are weak so host LLMs can
// explain to users why results are search-heavy. Avoids silent fallbacks.
function buildColdStartNote(
  cacheHits: number,
  searchHits: number,
  embeddingAvailable: boolean,
  initialCacheSize: number,
  initialEmbedIndexSize: number,
  conceptMode: boolean,
  finalResultCount: number,
): string | undefined {
  if (initialCacheSize === 0) {
    return 'Cache is empty. Results come from live web search only. Use wigolo_fetch / wigolo_crawl to warm the cache, then re-run find_similar for hybrid local+web ranking.';
  }
  // Most specific signal: cache was populated but didn't match THIS query,
  // and web search did — tells the host LLM the cache wasn't useful for the
  // topic and where to focus warming. Wins over the generic
  // embedding-unavailable hint because it's actionable per-query.
  if (cacheHits === 0 && searchHits > 0) {
    return `No cache matches for this query (cache has ${initialCacheSize} pages overall). Results come from live web search. Use wigolo_fetch on relevant sources before re-running for hybrid ranking.`;
  }
  // Slice S7 (H9): audit case "retrieval augmented generation" → 1
  // unrelated cache hit, no cold_start, no signal to caller. When concept
  // mode returns very few results AND search wasn't used to corroborate,
  // tell the caller the local-cache signal is thin. Bound at <= 2 because
  // that's the threshold the audit case demonstrates — a single Deployment
  // page returned for an unrelated query.
  //
  // Guard with `initialCacheSize >= 3` so the existing "cache is small"
  // notes still win when the cache is essentially empty (those are
  // system-level posture signals; H9 is a per-query thinness signal).
  if (
    conceptMode &&
    searchHits === 0 &&
    finalResultCount > 0 &&
    finalResultCount <= 2 &&
    initialCacheSize >= 3
  ) {
    return `Only ${finalResultCount} cache match${finalResultCount === 1 ? '' : 'es'} for this concept query (cache has ${initialCacheSize} pages overall). The result is a thin local-cache signal and may not be representative. Enable include_web=true or run wigolo_crawl on relevant sources to corroborate.`;
  }
  if (!embeddingAvailable && initialCacheSize > 0) {
    return 'Embeddings unavailable or index empty (cached pages have not been embedded yet). Falling back to FTS5 keyword ranking. Set up sentence-transformers to enable semantic matching.';
  }
  if (cacheHits === 0 && initialCacheSize < 20) {
    return `Cache has only ${initialCacheSize} pages. Add more context by fetching or crawling relevant sites before relying on find_similar for cross-source similarity.`;
  }
  if (!embeddingAvailable && initialEmbedIndexSize === 0) {
    return 'Embedding index is empty. Semantic matching disabled until background embedding jobs catch up.';
  }
  return undefined;
}

function safeColdStartThreshold(): number {
  try {
    return getConfig().findSimilarColdStartThreshold;
  } catch {
    return 0.02;
  }
}

function buildWeakSignalNote(
  query: string,
  topRawScore: number,
  threshold: number,
): string {
  const score = topRawScore.toFixed(4);
  const t = threshold.toFixed(4);
  const queryPart = query ? `Query "${query}": ` : '';
  return (
    `${queryPart}top result is a weak match (raw signal ${score} below threshold ${t}). ` +
    `Per-result relevance_score replaced with raw fused_score so callers see actual signal strength. ` +
    `Tune WIGOLO_FIND_SIMILAR_COLD_START_THRESHOLD to adjust, or set it to 0 to disable.`
  );
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
    const extractor = await getExtractProvider();
    const extraction = await extractor.extract(raw.html, raw.finalUrl, {
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
    if (!service.isAvailable() || !service.isSubprocessReady()) return [];
    if (service.getIndex().size() === 0) return [];

    const excludeUrls = excludeNormalizedUrl ? new Set([excludeNormalizedUrl]) : undefined;
    const similar = await service.findSimilar(queryText, topK, excludeUrls);
    if (similar.length === 0) return [];

    // PER-ROW hydration. The shared vector store mixes url_cache pages with studio
    // capture keys (studio://<type>|<id>), so a single key must never abort the
    // batch: each candidate is resolved in its own try/catch, and a miss OR a
    // throw is skipped + logged (never surfaced empty, never dropping the
    // co-resident rows). studio keys hydrate from studio_artifacts BY ID — they
    // must never reach getCachedContent/normalizeUrl (the `|` throws new URL()),
    // which is exactly the latent suppression that returned [] for the whole batch.
    const hydrated: Array<{ id: string; title: string; markdown: string; score: number; source: 'studio' | 'cache'; trusted: boolean }> = [];
    for (const { url: key, score } of similar) {
      try {
        if (isStudioEmbedKey(key)) {
          const art = getStudioArtifactByEmbedKey(key);
          if (!art) {
            log.debug('embedding hydration skipped — studio artifact missing for key', { key });
            continue;
          }
          hydrated.push({
            id: key, // C1: the stable cross-surface identity IS the studio URI.
            title: art.title ?? key,
            markdown: (art.markdown ?? '').slice(0, 5000),
            score,
            source: 'studio',
            trusted: art.contentTrusted, // mirrors content_trusted (clips/qa => false)
          });
        } else {
          const cached = getCachedContent(key);
          if (!cached) {
            log.debug('embedding hydration skipped — url not in cache', { url: key });
            continue;
          }
          hydrated.push({
            id: cached.url,
            title: cached.title,
            markdown: cached.markdown.slice(0, 5000),
            score,
            source: 'cache',
            trusted: false, // a fetched page is page-derived: never trusted as instructions
          });
        }
      } catch (err) {
        // A genuinely malformed url key still throws inside getCachedContent
        // (contract unchanged) — absorb it HERE, per row, so one bad key is
        // loud-in-logs but never silently masks the rest of the batch.
        log.warn('embedding hydration skipped — error resolving key', {
          key,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
    }

    // Domain filter: url-keyed rows carry a real host; studio rows resolve to ''
    // and pass unless an include filter is set (filters.ts getDomain swallows the
    // unparseable studio key — no throw).
    const filtered = filterByDomains(
      hydrated.map(h => ({ url: h.id })),
      includeDomains,
      excludeDomains,
    );
    const allowedUrls = new Set(filtered.map(f => f.url));

    const results: FindSimilarResult[] = [];
    let rank = 0;
    for (const h of hydrated) {
      if (!allowedUrls.has(h.id)) continue;

      rank++;
      rankMap.set(safeNormalize(h.id), rank);

      results.push({
        url: h.id,
        title: h.title,
        markdown: h.markdown,
        relevance_score: h.score,
        source: h.source,
        trusted: h.trusted,
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
        trusted: false, // url_cache page — page-derived, never trusted as instructions
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
        const searchResult = await handleSearch(
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

        if (!searchResult.ok) {
          log.warn('web search query failed', { query, error: searchResult.error_reason });
          continue;
        }
        const searchOutput = searchResult.data;

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
            trusted: false, // live web result — page-derived, never trusted as instructions
            match_signals: {
              fused_score: 0,
            },
          });
        }
      } catch (err) {
        log.warn('web search query failed', { query, error: String(err) });
      }
    }

    // Embed web results synchronously so they're in the index for the
    // re-query pass that runs after this fallback. Other tools use embedAsync
    // (fire-and-forget), but find_similar needs embeddings in THIS request.
    try {
      const embeddingService = getEmbeddingService();
      if (embeddingService.isAvailable() && embeddingService.isSubprocessReady()) {
        const embedPromises = allResults
          .filter(r => r.markdown)
          .slice(0, 10) // cap to avoid blocking too long
          .map(r => embeddingService.embedAndStore(r.url, r.markdown));
        await Promise.allSettled(embedPromises);
        log.debug('embedded web fallback results', { count: embedPromises.length });
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

const QUERY_STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'be', 'in', 'of', 'to', 'and', 'or', 'for',
  'on', 'at', 'with', 'by', 'as', 'it', 'this', 'that', 'these', 'those',
  'how', 'what', 'why', 'when', 'where', 'do', 'does', 'will', 'can',
]);

export function generateSearchQueries(terms: string[], title: string): string[] {
  const meaningful = terms
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !QUERY_STOPWORDS.has(t.toLowerCase()));

  // Refuse to issue web searches with too little signal — that's how cold-cache
  // fallback ended up returning generic React docs in the May-24 bench. A
  // single token rarely disambiguates between unrelated domains; without a
  // title to anchor intent, we bail and let the caller surface cold_start.
  const haveTitleSignal = !!title && title.length > 3;
  if (meaningful.length < 2 && !haveTitleSignal) return [];

  const queries: string[] = [];

  if (haveTitleSignal) {
    queries.push(title.slice(0, 150));
  }
  if (meaningful.length >= 2) {
    queries.push(meaningful.slice(0, 5).join(' '));
  }
  if (meaningful.length >= 3) {
    // Topic-focused suffix replaces the old "tutorial guide" — that suffix
    // biased toward beginner blogs and let irrelevant tutorial pages crowd
    // out authoritative sources for technical concepts.
    queries.push(`${meaningful.slice(0, 3).join(' ')} overview`);
  }

  const unique = [...new Set(queries)];
  return unique.slice(0, WEB_SEARCH_QUERY_COUNT);
}

interface FuseOutput {
  results: FindSimilarResult[];
  topRawScore: number;
}

function fuseResults(
  rankedLists: Map<string, number>[],
  allResults: FindSimilarResult[],
  maxResults: number,
): FuseOutput {
  const scores = reciprocalRankFusion(rankedLists);
  const sorted = sortByRRFScore(scores);

  const resultsByNormalizedUrl = new Map<string, FindSimilarResult>();
  for (const r of allResults) {
    const key = safeNormalize(r.url);
    if (!resultsByNormalizedUrl.has(key)) {
      resultsByNormalizedUrl.set(key, r);
    }
  }

  // Raw RRF scores cap at ~2/60 ≈ 0.033 which reads as "low relevance" to
  // users. Normalize against the top score so the best match is 1.0 and the
  // rest are proportional; the absolute RRF value is preserved in
  // match_signals.fused_score for clients that depend on it. The raw top
  // score is returned alongside so the caller can decide whether the match
  // is strong enough to trust or surface a cold_start (sub-ticket 2.8).
  const topScore = sorted.length > 0 ? sorted[0][1] : 0;
  const fused: FindSimilarResult[] = [];
  for (const [nUrl, score] of sorted) {
    if (fused.length >= maxResults) break;

    const result = resultsByNormalizedUrl.get(nUrl);
    if (!result) continue;

    const normalized = topScore > 0 ? score / topScore : 0;
    fused.push({
      ...result,
      relevance_score: normalized,
      match_signals: {
        ...result.match_signals,
        fused_score: score,
      },
    });
  }

  return { results: fused, topRawScore: topScore };
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
