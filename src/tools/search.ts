import type { SearchInput, SearchOutput, SearchResultItem, SearchEngine, RawSearchResult, ProgressCallback } from '../types.js';
import type { SmartRouter } from '../fetch/router.js';
import type { BackendStatus } from '../server/backend-status.js';
import { deduplicateResults } from '../search/dedup.js';
import { decomposeQuery } from '../search/query.js';
import { validateLinks } from '../search/validator.js';
import { rerankResults } from '../search/rerank.js';
import { applyAllFilters } from '../search/filters.js';
import { formatSearchContext } from '../search/context-formatter.js';
import type { SamplingCapableServer } from '../search/sampling.js';
import { synthesizeAnswer } from '../search/answer-synthesis.js';
import { normalizeQueries, fanOutSearch, synthesizeIntent } from '../search/multi-query.js';
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
  backendStatus?: BackendStatus,
  samplingServer?: SamplingCapableServer,
  onProgress?: ProgressCallback,
): Promise<SearchOutput> {
  const start = Date.now();
  const config = getConfig();

  const maxResults = Math.min(input.max_results ?? DEFAULT_MAX_RESULTS, MAX_RESULTS_CAP);
  const includeContent = input.include_content ?? true;
  const contentMaxChars = input.content_max_chars ?? DEFAULT_CONTENT_MAX_CHARS;
  const maxTotalChars = input.max_total_chars ?? DEFAULT_MAX_TOTAL_CHARS;
  const totalTimeoutMs = config.searchTotalTimeoutMs;
  const fetchTimeoutMs = config.searchFetchTimeoutMs;

  // Progress notifications are only emitted for stream_answer format
  const streamProgress = input.format === 'stream_answer' ? onProgress : undefined;
  const emit = async (progress: number, total: number, message: string): Promise<void> => {
    if (!streamProgress) return;
    try {
      await streamProgress({ progress, total, message });
    } catch (err) {
      log.debug('progress notification failed', { error: String(err) });
    }
  };

  const isMultiQuery = Array.isArray(input.query);

  // --- Multi-query path ---
  if (isMultiQuery) {
    const normalizedQueries = normalizeQueries(input.query as string[]);

    if (normalizedQueries.length === 0) {
      const output: SearchOutput = {
        results: [],
        query: Array.isArray(input.query) ? (input.query[0] ?? '') : input.query,
        engines_used: [],
        total_time_ms: Date.now() - start,
        error: 'All queries were empty after normalization',
        queries_executed: [],
      };
      const warning = backendStatus?.consumeWarning();
      if (warning) output.warning = warning;
      return output;
    }

    const displayQuery = normalizedQueries[0];
    const cacheKey = normalizedQueries.join(' | ');

    const cached = input.force_refresh ? null : getCachedSearchResults(cacheKey);
    if (cached && !includeContent) {
      log.info('serving multi-query search results from cache', { queries: normalizedQueries });
      const output: SearchOutput = {
        results: cached.results.slice(0, maxResults),
        query: displayQuery,
        engines_used: cached.engines_used,
        total_time_ms: Date.now() - start,
        queries_executed: normalizedQueries,
      };
      const warning = backendStatus?.consumeWarning();
      if (warning) output.warning = warning;
      if (input.format === 'context') {
        output.context_text = formatSearchContext(output.results, maxTotalChars);
      }
      return output;
    }

    let activeEngines = engines;
    if (input.search_engines && input.search_engines.length > 0) {
      activeEngines = engines.filter(e => input.search_engines!.includes(e.name));
      if (activeEngines.length === 0) {
        log.warn('no engines matched search_engines filter, using all', { requested: input.search_engines });
        activeEngines = engines;
      }
    }

    await emit(1, 5, `Running ${normalizedQueries.length} search queries across engines...`);

    const { results: rawResults, enginesUsed, errors } = await fanOutSearch(
      normalizedQueries,
      activeEngines,
      {
        maxResults,
        timeRange: input.time_range,
        language: input.language,
        includeDomains: input.include_domains,
        excludeDomains: input.exclude_domains,
        fromDate: input.from_date,
        toDate: input.to_date,
        category: input.category,
      },
    );

    if (rawResults.length === 0) {
      const output: SearchOutput = {
        results: [],
        query: displayQuery,
        engines_used: enginesUsed,
        total_time_ms: Date.now() - start,
        error: errors.length > 0 ? errors.join('; ') : 'No results found',
        queries_executed: normalizedQueries,
      };
      const warning = backendStatus?.consumeWarning();
      if (warning) output.warning = warning;
      if (input.format === 'context') {
        output.context_text = '';
      }
      return output;
    }

    await emit(2, 5, `Deduplicating and reranking ${rawResults.length} results...`);

    let merged = deduplicateResults(rawResults);

    merged = applyAllFilters(merged, {
      includeDomains: input.include_domains,
      excludeDomains: input.exclude_domains,
      fromDate: input.from_date,
      toDate: input.to_date,
      category: input.category,
    });

    const intentString = synthesizeIntent(normalizedQueries);
    merged = await rerankResults(intentString, merged);
    merged = await validateLinks(merged);
    merged = merged.slice(0, maxResults);

    const results: SearchResultItem[] = merged.map(m => ({
      title: m.title,
      url: m.url,
      snippet: m.snippet,
      relevance_score: m.relevance_score,
      ...(m.published_date ? { published_date: m.published_date } : {}),
    }));

    const searchElapsed = Date.now() - start;
    let fetchElapsed = 0;

    if (includeContent && results.length > 0) {
      await emit(3, 5, `Fetching content from ${results.length} sources...`);
      const fetchStart = Date.now();
      await fetchContentForResults(results, router, {
        contentMaxChars,
        maxTotalChars,
        fetchTimeoutMs,
        totalDeadline: start + totalTimeoutMs,
        forceRefresh: input.force_refresh ?? false,
      });
      fetchElapsed = Date.now() - fetchStart;
    }

    try {
      cacheSearchResults(cacheKey, results, enginesUsed);
    } catch (err) {
      log.warn('failed to cache multi-query search results', { error: String(err) });
    }

    const output: SearchOutput = {
      results,
      query: displayQuery,
      engines_used: enginesUsed,
      total_time_ms: Date.now() - start,
      search_time_ms: searchElapsed,
      fetch_time_ms: fetchElapsed,
      queries_executed: normalizedQueries,
    };
    const warning = backendStatus?.consumeWarning();
    if (warning) output.warning = warning;
    if (input.format === 'context') {
      output.context_text = formatSearchContext(output.results, maxTotalChars);
    }
    if ((input.format === 'answer' || input.format === 'stream_answer') && results.length > 0) {
      await applyAnswerSynthesis(input, output, results, maxTotalChars, samplingServer, streamProgress);
    }
    return output;
  }

  // --- Single-query path (unchanged from v2) ---
  const queryStr = input.query as string;

  const cached = input.force_refresh ? null : getCachedSearchResults(queryStr);
  if (cached && !includeContent) {
    log.info('serving search results from cache', { query: queryStr });
    const output: SearchOutput = {
      results: cached.results.slice(0, maxResults),
      query: queryStr,
      engines_used: cached.engines_used,
      total_time_ms: Date.now() - start,
    };
    const warning = backendStatus?.consumeWarning();
    if (warning) output.warning = warning;
    if (input.format === 'context') {
      output.context_text = formatSearchContext(output.results, maxTotalChars);
    }
    if ((input.format === 'answer' || input.format === 'stream_answer') && output.results.length > 0) {
      await applyAnswerSynthesis(input, output, output.results, maxTotalChars, samplingServer, streamProgress);
    }
    return output;
  }

  let activeEngines = engines;
  if (input.search_engines && input.search_engines.length > 0) {
    activeEngines = engines.filter(e => input.search_engines!.includes(e.name));
    if (activeEngines.length === 0) {
      log.warn('no engines matched search_engines filter, using all', { requested: input.search_engines });
      activeEngines = engines;
    }
  }

  const subQueries = decomposeQuery(queryStr);
  log.debug('query decomposition', { original: queryStr, parts: subQueries.length });

  await emit(1, 5, `Running ${subQueries.length} search queries across ${activeEngines.length} engines...`);

  const allRaw: RawSearchResult[] = [];
  const enginesUsed = new Set<string>();
  const errors: string[] = [];

  const hasFilterAttrition = !!(input.include_domains?.length || input.exclude_domains?.length);
  const overfetchFactor = hasFilterAttrition ? 3 : 2;

  const searchPromises = activeEngines.flatMap(engine =>
    subQueries.map(async (query) => {
      try {
        const results = await engine.search(query, {
          maxResults: maxResults * overfetchFactor,
          timeRange: input.time_range,
          language: input.language,
          includeDomains: input.include_domains,
          excludeDomains: input.exclude_domains,
          fromDate: input.from_date,
          toDate: input.to_date,
          category: input.category,
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
    const output: SearchOutput = {
      results: [],
      query: queryStr,
      engines_used: [...enginesUsed],
      total_time_ms: Date.now() - start,
      error: errors.length > 0 ? errors.join('; ') : 'No results found',
    };
    const warning = backendStatus?.consumeWarning();
    if (warning) output.warning = warning;
    if (input.format === 'context') {
      output.context_text = '';
    }
    return output;
  }

  await emit(2, 5, `Deduplicating and reranking ${allRaw.length} results...`);

  let merged = deduplicateResults(allRaw);

  merged = applyAllFilters(merged, {
    includeDomains: input.include_domains,
    excludeDomains: input.exclude_domains,
    fromDate: input.from_date,
    toDate: input.to_date,
    category: input.category,
  });

  merged = await rerankResults(queryStr, merged);
  merged = await validateLinks(merged);

  merged = merged.slice(0, maxResults);

  const results: SearchResultItem[] = merged.map(m => ({
    title: m.title,
    url: m.url,
    snippet: m.snippet,
    relevance_score: m.relevance_score,
    ...(m.published_date ? { published_date: m.published_date } : {}),
  }));

  const searchElapsed = Date.now() - start;
  let fetchElapsed = 0;

  if (includeContent && results.length > 0) {
    await emit(3, 5, `Fetching content from ${results.length} sources...`);
    const fetchStart = Date.now();
    await fetchContentForResults(results, router, {
      contentMaxChars,
      maxTotalChars,
      fetchTimeoutMs,
      totalDeadline: start + totalTimeoutMs,
      forceRefresh: input.force_refresh ?? false,
    });
    fetchElapsed = Date.now() - fetchStart;
  }

  try {
    cacheSearchResults(queryStr, results, [...enginesUsed]);
  } catch (err) {
    log.warn('failed to cache search results', { error: String(err) });
  }

  const output: SearchOutput = {
    results,
    query: queryStr,
    engines_used: [...enginesUsed],
    total_time_ms: Date.now() - start,
    search_time_ms: searchElapsed,
    fetch_time_ms: fetchElapsed,
  };
  const warning = backendStatus?.consumeWarning();
  if (warning) output.warning = warning;
  if (input.format === 'context') {
    output.context_text = formatSearchContext(output.results, maxTotalChars);
  }
  if ((input.format === 'answer' || input.format === 'stream_answer') && results.length > 0) {
    await applyAnswerSynthesis(input, output, results, maxTotalChars, samplingServer, streamProgress);
  }
  return output;
}

async function applyAnswerSynthesis(
  input: SearchInput,
  output: SearchOutput,
  results: SearchResultItem[],
  maxTotalChars: number,
  samplingServer?: SamplingCapableServer,
  onProgress?: ProgressCallback,
): Promise<void> {
  const isStreaming = input.format === 'stream_answer';

  if (samplingServer) {
    if (isStreaming && onProgress) {
      try {
        await onProgress({
          progress: 4,
          total: 5,
          message: `Synthesizing answer from ${results.length} sources...`,
        });
      } catch (err) {
        log.debug('progress notification failed', { error: String(err) });
      }
    }

    const synthesis = await synthesizeAnswer(results, typeof input.query === 'string' ? input.query : input.query[0], samplingServer);

    if (!synthesis.fallback && synthesis.answer) {
      output.answer = synthesis.answer;
      output.citations = synthesis.citations;
      if (isStreaming) output.streaming = true;

      if (isStreaming && onProgress) {
        try {
          await onProgress({
            progress: 5,
            total: 5,
            message: `Answer synthesis complete (${synthesis.answer.length} chars, ${synthesis.citations?.length ?? 0} citations)`,
          });
        } catch (err) {
          log.debug('progress notification failed', { error: String(err) });
        }
      }
    } else {
      output.context_text = formatSearchContext(results, maxTotalChars);
      if (synthesis.warning) {
        output.warning = output.warning
          ? `${output.warning}; ${synthesis.warning}`
          : synthesis.warning;
      }
    }
  } else {
    output.context_text = formatSearchContext(results, maxTotalChars);
    output.warning = output.warning
      ? `${output.warning}; No sampling server available`
      : 'No sampling server available; falling back to context format';
  }
}

interface FetchContext {
  contentMaxChars: number;
  maxTotalChars: number;
  fetchTimeoutMs: number;
  totalDeadline: number;
  forceRefresh: boolean;
}

// Parallel fetch all URLs; then apply total-char budget in relevance (input) order.
async function fetchContentForResults(
  results: SearchResultItem[],
  router: SmartRouter,
  ctx: FetchContext,
): Promise<void> {
  const fetches = results.map(async (result): Promise<{ content?: string; error?: string }> => {
    if (Date.now() >= ctx.totalDeadline) {
      return { error: 'total_timeout' };
    }
    try {
      const raw = await Promise.race([
        router.fetch(result.url, {
          renderJs: 'auto',
          ...(ctx.forceRefresh && { force_refresh: true }),
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), ctx.fetchTimeoutMs),
        ),
      ]);
      const extraction = await extractContent(raw.html, raw.finalUrl, {
        maxChars: ctx.contentMaxChars,
        contentType: raw.contentType,
      });
      return { content: extraction.markdown };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.debug('content fetch failed', { url: result.url, error: msg });
      return { error: msg };
    }
  });

  const fetched = await Promise.all(fetches);

  let totalCharsUsed = 0;
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const { content, error } = fetched[i];

    if (error) {
      result.fetch_failed = error;
      continue;
    }
    if (content === undefined) continue;

    if (totalCharsUsed >= ctx.maxTotalChars) {
      result.content_truncated = true;
      continue;
    }

    let out = content;
    const remaining = ctx.maxTotalChars - totalCharsUsed;
    if (out.length > remaining) {
      out = out.slice(0, remaining);
      result.content_truncated = true;
    }

    totalCharsUsed += out.length;
    result.markdown_content = out;
  }
}
