import type {
  SearchInput,
  SearchOutput,
  SearchResultItem,
  RawSearchResult,
  StageResult,
} from '../../types.js';
import type { SmartRouter } from '../../fetch/router.js';
import type { SearchContext } from '../../providers/search-provider.js';
import { deduplicateResults } from '../dedup.js';
import { decomposeQuery } from '../query.js';
import { validateLinks } from '../validator.js';
import { rerankResults } from '../rerank.js';
import { applyAllFilters } from '../filters.js';
import { runSynthesis } from '../answer-synthesis.js';
import { applyEvidenceDefault } from '../evidence.js';
import { normalizeQueries, fanOutSearch, synthesizeIntent, expandIfSingle } from '../multi-query.js';
import { filterByLanguageWithFallback } from '../language-filter.js';
import { hasRecencyIntent } from '../reranker/recency.js';
import { cacheSearchResults, getCachedSearchResults } from '../../cache/store.js';
import { fetchContentForResults } from '../content-fetch.js';
import { getConfig } from '../../config.js';
import { resolveMode } from '../../util/mode.js';
import { createLogger } from '../../logger.js';

const log = createLogger('search');

const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS_CAP = 20;
const DEFAULT_CONTENT_MAX_CHARS = 30000;
const DEFAULT_MAX_TOTAL_CHARS = 50000;

function filterByExactPhrases<T extends { title: string; snippet: string }>(
  results: T[],
  phrases: string[],
): T[] {
  if (phrases.length === 0) return results;
  return results.filter((r) => {
    const hay = `${r.title} ${r.snippet}`.toLowerCase();
    return phrases.some((p) => hay.includes(p));
  });
}

export async function runSearxngSearch(
  input: SearchInput,
  ctx: SearchContext,
): Promise<StageResult<SearchOutput>> {
  const { engines, router, backendStatus, samplingServer, onProgress } = ctx;
  const mode = resolveMode(input.mode);
  const start = Date.now();
  const config = getConfig();

  const RETIRED_FORMATS = new Set(['full', 'context', 'highlights']);
  const VALID_FORMATS = new Set(['answer', 'stream_answer']);

  if (input.format != null) {
    const fmt = String(input.format);
    if (RETIRED_FORMATS.has(fmt)) {
      return {
        ok: false,
        error: 'invalid_format',
        error_reason: `format renamed; pass 'evidence' (default — omit) or 'answer'/'stream_answer' for synthesis`,
        stage: 'search',
      };
    }
    if (!VALID_FORMATS.has(fmt)) {
      return {
        ok: false,
        error: 'invalid_format',
        error_reason: `unknown format='${fmt}'. Valid: omit (evidence), 'answer', 'stream_answer'`,
        stage: 'search',
      };
    }
  }

  const maxResults = Math.min(input.max_results ?? DEFAULT_MAX_RESULTS, MAX_RESULTS_CAP);
  const includeContent = input.include_content ?? true;
  const contentMaxChars = input.content_max_chars ?? DEFAULT_CONTENT_MAX_CHARS;
  const maxContentChars = input.max_content_chars;
  const maxTotalChars = input.max_total_chars ?? DEFAULT_MAX_TOTAL_CHARS;
  const totalTimeoutMs = config.searchTotalTimeoutMs;
  const fetchTimeoutMs = config.searchFetchTimeoutMs;

  // Q12: when the query has temporal intent ("latest", "recent", "this week", current year),
  // bypass cache and constrain engines to recent results. Existing recency-boost in rerank
  // already biases newer published_date once results land; this gates the upstream retrieval.
  {
    const queryStr = Array.isArray(input.query) ? input.query.join(' ') : input.query;
    if (typeof queryStr === 'string' && hasRecencyIntent(queryStr)) {
      if (input.force_refresh !== false) input.force_refresh = true;
      if (!input.time_range) input.time_range = 'week';
    }
  }

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

  // exact_match: wrap each query string in double quotes so engines that
  // honour `"..."` filter to phrase matches. Post-filter below drops any
  // result whose title+snippet lacks the unquoted phrase.
  const exactPhrases: string[] = [];
  if (input.exact_match) {
    if (typeof input.query === 'string') {
      const trimmed = input.query.trim().replace(/^"|"$/g, '');
      if (trimmed) exactPhrases.push(trimmed.toLowerCase());
      input.query = trimmed ? `"${trimmed}"` : input.query;
    } else if (Array.isArray(input.query)) {
      const quoted: string[] = [];
      for (const q of input.query) {
        if (typeof q !== 'string') {
          quoted.push(q as unknown as string);
          continue;
        }
        const trimmed = q.trim().replace(/^"|"$/g, '');
        if (trimmed) exactPhrases.push(trimmed.toLowerCase());
        quoted.push(trimmed ? `"${trimmed}"` : q);
      }
      input.query = quoted;
    }
  }

  let normalizedQuery: string | string[] = input.query;
  let autoExpanded = false;
  if (mode !== 'cache' && typeof normalizedQuery === 'string') {
    normalizedQuery = expandIfSingle(normalizedQuery);
    autoExpanded = true;
  }

  const isMultiQuery = Array.isArray(normalizedQuery);

  // --- Multi-query path ---
  if (isMultiQuery) {
    const normalizedQueries = normalizeQueries(normalizedQuery as string[]);

    if (normalizedQueries.length === 0) {
      return {
        ok: false,
        error: 'invalid_input',
        error_reason: 'All queries were empty after normalization',
        stage: 'search',
      };
    }

    const displayQuery = autoExpanded && typeof input.query === 'string'
      ? input.query
      : normalizedQueries[0];
    const cacheKey = normalizedQueries.join(' | ');

    const staleMaxSeconds = mode === 'cache' ? config.fastStaleMaxHours * 3600 : 0;
    const cached = input.force_refresh
      ? null
      : getCachedSearchResults(cacheKey, { staleMaxSeconds });
    if (cached && !includeContent) {
      log.info('serving multi-query search results from cache', {
        queries: normalizedQueries,
        stale: cached.stale ?? false,
      });
      const stamped: SearchResultItem[] = cached.results.slice(0, maxResults).map(r => ({
        ...r,
        cached: true,
        cached_at: cached.searched_at,
        ...(cached.stale ? { stale: true } : {}),
      }));
      const _elapsedMq1 = Date.now() - start;
      const output: SearchOutput = {
        results: stamped,
        query: displayQuery,
        engines_used: cached.engines_used,
        total_time_ms: _elapsedMq1,
        response_time_ms: _elapsedMq1,
        queries_executed: normalizedQueries,
      };
      const warning = backendStatus?.consumeWarning();
      if (warning) output.warning = warning;
      if (input.format === 'answer' || input.format === 'stream_answer') {
        const synth = await runSynthesis({
          query: displayQuery,
          results: output.results,
          samplingServer,
          maxTotalChars,
        });
        if (!synth.ok) {
          output.error = synth.error;
          (output as unknown as Record<string, unknown>).error_reason = synth.error_reason;
          (output as unknown as Record<string, unknown>).stage = synth.stage;
          if (synth.hint) (output as unknown as Record<string, unknown>).hint = synth.hint;
        } else {
          output.answer = synth.data.answer;
          output.citations = synth.data.citations;
          if (input.format === 'stream_answer') output.streaming = true;
          if (synth.data.warning) {
            output.warning = output.warning ? `${output.warning}; ${synth.data.warning}` : synth.data.warning;
          }
        }
      } else if (output.results.length > 0 && mode !== 'cache') {
        await applyEvidenceDefault(input, output, output.results, displayQuery);
      }
      return { ok: true, data: output };
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
      mode === 'cache' ? activeEngines.slice(0, 1) : activeEngines,
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

    const filterTargetMq = (input.language ?? 'en').slice(0, 2).toLowerCase();
    const filteredMq = filterByLanguageWithFallback(rawResults, {
      target: filterTargetMq,
      dropThreshold: 0.7,
    });
    const filterWarningsMq = filteredMq.warnings.join('; ');
    const filteredRaw = filteredMq.results;

    if (filteredRaw.length === 0 && input.format !== 'answer' && input.format !== 'stream_answer') {
      return {
        ok: false,
        error: 'no_results',
        error_reason: errors.length > 0 ? errors.join('; ') : 'No results found',
        stage: 'search',
      };
    }

    await emit(2, 5, `Deduplicating and reranking ${filteredRaw.length} results...`);

    let merged = deduplicateResults(filteredRaw);

    merged = applyAllFilters(merged, {
      includeDomains: input.include_domains,
      excludeDomains: input.exclude_domains,
      fromDate: input.from_date,
      toDate: input.to_date,
      category: input.category,
    });

    merged = filterByExactPhrases(merged, exactPhrases);

    const intentString = synthesizeIntent(normalizedQueries);
    merged = await rerankResults(intentString, merged, { skip: mode === 'cache' });
    if (mode !== 'cache') merged = await validateLinks(merged);
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
        maxContentChars,
        maxTotalChars,
        fetchTimeoutMs,
        totalDeadline: start + totalTimeoutMs,
        forceRefresh: input.force_refresh ?? false,
        maxFetches: input.max_fetches,
      });
      fetchElapsed = Date.now() - fetchStart;
    }

    try {
      cacheSearchResults(cacheKey, results, enginesUsed);
    } catch (err) {
      log.warn('failed to cache multi-query search results', { error: String(err) });
    }

    const _elapsedMq2 = Date.now() - start;
    const output: SearchOutput = {
      results,
      query: displayQuery,
      engines_used: enginesUsed,
      total_time_ms: _elapsedMq2,
      response_time_ms: _elapsedMq2,
      search_time_ms: searchElapsed,
      fetch_time_ms: fetchElapsed,
      queries_executed: normalizedQueries,
    };
    const combinedMq = [filterWarningsMq, backendStatus?.consumeWarning()].filter(Boolean).join('; ');
    if (combinedMq) output.warning = combinedMq;
    if (input.format === 'answer' || input.format === 'stream_answer') {
      const synth = await runSynthesis({
        query: displayQuery,
        results,
        samplingServer,
        maxTotalChars,
      });
      if (!synth.ok) {
        output.error = synth.error;
        (output as unknown as Record<string, unknown>).error_reason = synth.error_reason;
        (output as unknown as Record<string, unknown>).stage = synth.stage;
        if (synth.hint) (output as unknown as Record<string, unknown>).hint = synth.hint;
      } else {
        output.answer = synth.data.answer;
        output.citations = synth.data.citations;
        if (input.format === 'stream_answer') output.streaming = true;
        if (synth.data.warning) {
          output.warning = output.warning ? `${output.warning}; ${synth.data.warning}` : synth.data.warning;
        }
      }
    } else if (results.length > 0 && mode !== 'cache') {
      await applyEvidenceDefault(input, output, results, displayQuery);
    }
    return { ok: true, data: output };
  }

  // --- Single-query path ---
  // Reachable only via mode='cache' with a string input. default/stealth string inputs
  // are converted to string[] by expandIfSingle above and handled by the multi-query path.
  const queryStr = input.query as string;

  const staleMaxSeconds = mode === 'cache' ? config.fastStaleMaxHours * 3600 : 0;
  const cached = input.force_refresh
    ? null
    : getCachedSearchResults(queryStr, { staleMaxSeconds });
  if (cached && !includeContent) {
    log.info('serving search results from cache', {
      query: queryStr,
      stale: cached.stale ?? false,
    });
    const stamped: SearchResultItem[] = cached.results.slice(0, maxResults).map(r => ({
      ...r,
      cached: true,
      cached_at: cached.searched_at,
      ...(cached.stale ? { stale: true } : {}),
    }));
    const _elapsedSq1 = Date.now() - start;
    const output: SearchOutput = {
      results: stamped,
      query: queryStr,
      engines_used: cached.engines_used,
      total_time_ms: _elapsedSq1,
      response_time_ms: _elapsedSq1,
    };
    const warning = backendStatus?.consumeWarning();
    if (warning) output.warning = warning;
    if (input.format === 'answer' || input.format === 'stream_answer') {
      const synth = await runSynthesis({
        query: queryStr,
        results: output.results,
        samplingServer,
        maxTotalChars,
      });
      if (!synth.ok) {
        output.error = synth.error;
        (output as unknown as Record<string, unknown>).error_reason = synth.error_reason;
        (output as unknown as Record<string, unknown>).stage = synth.stage;
        if (synth.hint) (output as unknown as Record<string, unknown>).hint = synth.hint;
      } else {
        output.answer = synth.data.answer;
        output.citations = synth.data.citations;
        if (input.format === 'stream_answer') output.streaming = true;
        if (synth.data.warning) {
          output.warning = output.warning ? `${output.warning}; ${synth.data.warning}` : synth.data.warning;
        }
      }
    } else if (output.results.length > 0 && mode !== 'cache') {
      await applyEvidenceDefault(input, output, output.results, queryStr);
    }
    return { ok: true, data: output };
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

  const effectiveEngines = mode === 'cache' ? activeEngines.slice(0, 1) : activeEngines;

  await emit(1, 5, `Running ${subQueries.length} search queries across ${effectiveEngines.length} engines...`);

  const allRaw: RawSearchResult[] = [];
  const enginesUsed = new Set<string>();
  const errors: string[] = [];

  const hasFilterAttrition = !!(input.include_domains?.length || input.exclude_domains?.length);
  const overfetchFactor = hasFilterAttrition ? 3 : 2;

  const searchPromises = effectiveEngines.flatMap(engine =>
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

  const filterTargetSq = (input.language ?? 'en').slice(0, 2).toLowerCase();
  const filteredSq = filterByLanguageWithFallback(allRaw, {
    target: filterTargetSq,
    dropThreshold: 0.4,
  });
  const filterWarningsSq = filteredSq.warnings.join('; ');
  const filteredAllRaw = filteredSq.results;

  if (filteredAllRaw.length === 0 && input.format !== 'answer' && input.format !== 'stream_answer') {
    return {
      ok: false,
      error: 'no_results',
      error_reason: errors.length > 0 ? errors.join('; ') : 'No results found',
      stage: 'search',
    };
  }

  await emit(2, 5, `Deduplicating and reranking ${filteredAllRaw.length} results...`);

  let merged = deduplicateResults(filteredAllRaw);

  merged = applyAllFilters(merged, {
    includeDomains: input.include_domains,
    excludeDomains: input.exclude_domains,
    fromDate: input.from_date,
    toDate: input.to_date,
    category: input.category,
  });

  merged = filterByExactPhrases(merged, exactPhrases);

  merged = await rerankResults(queryStr, merged, { skip: mode === 'cache' });
  if (mode !== 'cache') merged = await validateLinks(merged);

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
      maxContentChars,
      maxTotalChars,
      fetchTimeoutMs,
      totalDeadline: start + totalTimeoutMs,
      forceRefresh: input.force_refresh ?? false,
      maxFetches: input.max_fetches,
    });
    fetchElapsed = Date.now() - fetchStart;
  }

  try {
    cacheSearchResults(queryStr, results, [...enginesUsed]);
  } catch (err) {
    log.warn('failed to cache search results', { error: String(err) });
  }

  const _elapsedSq2 = Date.now() - start;
  const output: SearchOutput = {
    results,
    query: queryStr,
    engines_used: [...enginesUsed],
    total_time_ms: _elapsedSq2,
    response_time_ms: _elapsedSq2,
    search_time_ms: searchElapsed,
    fetch_time_ms: fetchElapsed,
  };
  const combinedSq = [filterWarningsSq, backendStatus?.consumeWarning()].filter(Boolean).join('; ');
  if (combinedSq) output.warning = combinedSq;
  if (input.format === 'answer' || input.format === 'stream_answer') {
    const synth = await runSynthesis({
      query: queryStr,
      results,
      samplingServer,
      maxTotalChars,
    });
    if (!synth.ok) {
      output.error = synth.error;
      (output as unknown as Record<string, unknown>).error_reason = synth.error_reason;
      (output as unknown as Record<string, unknown>).stage = synth.stage;
      if (synth.hint) (output as unknown as Record<string, unknown>).hint = synth.hint;
    } else {
      output.answer = synth.data.answer;
      output.citations = synth.data.citations;
      if (input.format === 'stream_answer') output.streaming = true;
      if (synth.data.warning) {
        output.warning = output.warning ? `${output.warning}; ${synth.data.warning}` : synth.data.warning;
      }
    }
  } else if (results.length > 0 && mode !== 'cache') {
    await applyEvidenceDefault(input, output, results, queryStr);
  }
  return { ok: true, data: output };
}

