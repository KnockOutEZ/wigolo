import type { SearchInput, SearchOutput, SearchResultItem, SearchEngine, RawSearchResult } from '../types.js';
import type { SmartRouter } from '../fetch/router.js';
import { deduplicateResults, type MergedSearchResult } from '../search/dedup.js';
import { decomposeQuery } from '../search/query.js';
import { validateLinks } from '../search/validator.js';
import { rerankResults } from '../search/rerank.js';
import { extractContent } from '../extraction/pipeline.js';
import { cacheSearchResults, getCachedSearchResults } from '../cache/store.js';
import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('search');

const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS_CAP = 20;
const DEFAULT_CONTENT_MAX_CHARS = 30000;
const DEFAULT_MAX_TOTAL_CHARS = 50000;

export async function handleSearch(
  input: SearchInput,
  engines: SearchEngine[],
  router: SmartRouter,
): Promise<SearchOutput> {
  const start = Date.now();
  const config = getConfig();

  const maxResults = Math.min(input.max_results ?? DEFAULT_MAX_RESULTS, MAX_RESULTS_CAP);
  const includeContent = input.include_content ?? true;
  const contentMaxChars = input.content_max_chars ?? DEFAULT_CONTENT_MAX_CHARS;
  const maxTotalChars = input.max_total_chars ?? DEFAULT_MAX_TOTAL_CHARS;
  const totalTimeoutMs = config.searchTotalTimeoutMs;
  const fetchTimeoutMs = config.searchFetchTimeoutMs;

  const cached = getCachedSearchResults(input.query);
  if (cached && !includeContent) {
    log.info('serving search results from cache', { query: input.query });
    return {
      results: cached.results.slice(0, maxResults),
      query: input.query,
      engines_used: cached.engines_used,
      total_time_ms: Date.now() - start,
    };
  }

  let activeEngines = engines;
  if (input.search_engines && input.search_engines.length > 0) {
    activeEngines = engines.filter(e => input.search_engines!.includes(e.name));
    if (activeEngines.length === 0) {
      log.warn('no engines matched search_engines filter, using all', { requested: input.search_engines });
      activeEngines = engines;
    }
  }

  const subQueries = decomposeQuery(input.query);
  log.debug('query decomposition', { original: input.query, parts: subQueries.length });

  const allRaw: RawSearchResult[] = [];
  const enginesUsed = new Set<string>();
  const errors: string[] = [];

  const searchPromises = activeEngines.flatMap(engine =>
    subQueries.map(async (query) => {
      try {
        const results = await engine.search(query, {
          maxResults: maxResults * 2,
          timeRange: input.time_range,
          language: input.language,
        });
        for (const r of results) {
          allRaw.push(r);
          enginesUsed.add(engine.name);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn('engine search failed', { engine: engine.name, query, error: msg });
        errors.push(`${engine.name}: ${msg}`);
      }
    }),
  );

  await Promise.allSettled(searchPromises);

  if (allRaw.length === 0) {
    return {
      results: [],
      query: input.query,
      engines_used: [...enginesUsed],
      total_time_ms: Date.now() - start,
      error: errors.length > 0 ? errors.join('; ') : 'No results found',
    };
  }

  let merged = deduplicateResults(allRaw);
  merged = await rerankResults(input.query, merged);
  merged = await validateLinks(merged);

  merged = merged.slice(0, maxResults);

  const results: SearchResultItem[] = merged.map(m => ({
    title: m.title,
    url: m.url,
    snippet: m.snippet,
    relevance_score: m.relevance_score,
  }));

  if (includeContent && results.length > 0) {
    await fetchContentForResults(results, router, {
      contentMaxChars,
      maxTotalChars,
      fetchTimeoutMs,
      totalDeadline: start + totalTimeoutMs,
    });
  }

  try {
    cacheSearchResults(input.query, results, [...enginesUsed]);
  } catch (err) {
    log.warn('failed to cache search results', { error: String(err) });
  }

  return {
    results,
    query: input.query,
    engines_used: [...enginesUsed],
    total_time_ms: Date.now() - start,
  };
}

interface FetchContext {
  contentMaxChars: number;
  maxTotalChars: number;
  fetchTimeoutMs: number;
  totalDeadline: number;
}

// v1: sequential fetch for correct budget enforcement. v2: parallel fetch then apply budget in relevance order.
async function fetchContentForResults(
  results: SearchResultItem[],
  router: SmartRouter,
  ctx: FetchContext,
): Promise<void> {
  let totalCharsUsed = 0;

  for (const result of results) {
    if (Date.now() >= ctx.totalDeadline) {
      result.fetch_failed = 'total_timeout';
      continue;
    }

    if (totalCharsUsed >= ctx.maxTotalChars) {
      result.content_truncated = true;
      continue;
    }

    try {
      const raw = await Promise.race([
        router.fetch(result.url, { renderJs: 'auto' }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), ctx.fetchTimeoutMs),
        ),
      ]);

      const extraction = await extractContent(raw.html, raw.finalUrl, {
        maxChars: ctx.contentMaxChars,
        contentType: raw.contentType,
      });

      let content = extraction.markdown;

      const remaining = ctx.maxTotalChars - totalCharsUsed;
      if (content.length > remaining) {
        content = content.slice(0, remaining);
        result.content_truncated = true;
      }

      totalCharsUsed += content.length;
      result.markdown_content = content;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.debug('content fetch failed', { url: result.url, error: msg });
      result.fetch_failed = msg;
    }
  }
}
