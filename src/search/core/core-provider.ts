// CoreSearchProvider — Phase 7 retrieval-only adapter.
//
// Delegates to the core orchestrator (intent routing + per-vertical engines +
// RRF fusion) and maps RawSearchResult to SearchResultItem for the MCP
// `search` tool surface. Array queries dispatch in parallel and are RRF-fused
// across dispatches so callers can hedge phrasings without paying serial cost.

import type { SearchProvider, SearchContext } from '../../providers/search-provider.js';
import type {
  EngineOutcomeSummary,
  EngineTelemetry,
  RawSearchResult,
  SearchInput,
  SearchOutput,
  SearchResultItem,
  StageResult,
} from '../../types.js';
import { runV1Search } from './orchestrator.js';
import { applyContextRank } from './context-rank.js';
import { dedupAgainstRecentUrls } from './recent-cache-dedup.js';
import { buildQueryUnderstanding } from './query-understanding.js';
import { faviconUrlFor } from './favicon.js';
import { runSynthesis } from '../answer-synthesis.js';
import { applyEvidenceDefault, renderCitationsXml } from '../evidence.js';
import { fetchContentForResults } from '../content-fetch.js';
import {
  buildSearchCacheKey,
  cacheSearchResults,
  getCachedSearchResults,
} from '../../cache/store.js';
import { getConfig } from '../../config.js';
import { createLogger } from '../../logger.js';
import type { Citation } from '../../types.js';

const log = createLogger('search');

const DEFAULT_CONTENT_MAX_CHARS = 30000;
const DEFAULT_MAX_TOTAL_CHARS = 50000;

const RRF_K = 60;

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function matchesAnyDomain(url: string, domains: string[]): boolean {
  const host = hostnameOf(url);
  if (!host) return false;
  for (const raw of domains) {
    const needle = raw.toLowerCase().replace(/^\./, '');
    if (host === needle || host.endsWith(`.${needle}`)) return true;
  }
  return false;
}

function normalizeArrayQueries(queries: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of queries) {
    if (typeof raw !== 'string') continue;
    const q = raw.trim();
    if (q.length === 0) continue;
    const key = q.toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(q);
  }
  return out;
}

function fuseRankedLists(lists: RawSearchResult[][]): RawSearchResult[] {
  const scores = new Map<string, number>();
  const firstSeen = new Map<string, RawSearchResult>();
  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const r = list[rank];
      const prev = scores.get(r.url) ?? 0;
      scores.set(r.url, prev + 1 / (RRF_K + rank + 1));
      if (!firstSeen.has(r.url)) firstSeen.set(r.url, r);
    }
  }
  const maxScore = Math.max(0, ...scores.values());
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([url, score]) => {
      const base = firstSeen.get(url);
      if (!base) return undefined;
      return {
        ...base,
        relevance_score: maxScore > 0 ? score / maxScore : 0,
      };
    })
    .filter((r): r is RawSearchResult => r !== undefined);
}

export class CoreSearchProvider implements SearchProvider {
  readonly name = 'core' as const;

  async search(input: SearchInput, ctx: SearchContext): Promise<StageResult<SearchOutput>> {
    const isArray = Array.isArray(input.query);
    const queries = isArray
      ? normalizeArrayQueries(input.query as string[])
      : typeof input.query === 'string' && input.query.trim() !== ''
        ? [input.query.trim()]
        : [];

    if (queries.length === 0) {
      return {
        ok: false,
        error: 'invalid_input',
        error_reason: 'Query is empty',
        stage: 'search',
      };
    }

    if (input.category === 'images') {
      return {
        ok: false,
        error: 'unsupported_category',
        error_reason: 'images vertical not supported in core — set WIGOLO_SEARCH=searxng for legacy image search, or omit category for a general search',
        stage: 'search',
      };
    }
    const category = input.category;

    const start = Date.now();

    // Display query is the first input string (back-compat) so consumers can
    // still echo what was asked; arrays just join with " | " for clarity.
    const displayQuery = isArray ? (input.query as string[]).filter(Boolean).join(' | ') : queries[0];
    // Cache key includes filter params (sub-ticket 2.3) — without this,
    // include_domains / max_results / exclude_domains are silently ignored
    // on cache hits.
    const cacheKey = buildSearchCacheKey(queries.join(' | '), {
      category: input.category,
      include_domains: input.include_domains,
      exclude_domains: input.exclude_domains,
      max_results: input.max_results,
      from_date: input.from_date,
      to_date: input.to_date,
      language: input.language,
      time_range: input.time_range,
      exact_match: input.exact_match,
    });

    let items: SearchResultItem[] = [];
    let enginesUsed: string[] = [];
    let allDegraded = false;
    let searchElapsed = 0;
    let fetchElapsed = 0;
    let contentFetched = false;
    let servedFromCache = false;
    let cachedAt: string | undefined;
    let engineOutcomes: EngineOutcomeSummary[] | undefined;
    let engineTelemetry: EngineTelemetry[] | undefined;

    if (!input.force_refresh) {
      try {
        const cached = getCachedSearchResults(cacheKey);
        if (cached && !cached.stale) {
          // Defence-in-depth (sub-ticket 2.3): re-apply caller filters on
          // top of the cached payload before returning, so even if the
          // cache key omits a future filter, that filter still applies.
          let filtered = cached.results;
          if (input.include_domains?.length) {
            filtered = filtered.filter((r) => matchesAnyDomain(r.url, input.include_domains!));
          }
          if (input.exclude_domains?.length) {
            filtered = filtered.filter((r) => !matchesAnyDomain(r.url, input.exclude_domains!));
          }
          if (typeof input.max_results === 'number' && input.max_results >= 0) {
            filtered = filtered.slice(0, input.max_results);
          }
          items = filtered.map((r) => ({ ...r, cached: true, cached_at: cached.searched_at }));
          enginesUsed = cached.engines_used;
          servedFromCache = true;
          cachedAt = cached.searched_at;
          contentFetched = items.some((i) => typeof i.markdown_content === 'string' && i.markdown_content.length > 0);
        }
      } catch (err) {
        log.debug('cache lookup failed', { error: String(err) });
      }
    }

    if (!servedFromCache) {
      const dispatches = await Promise.all(
        queries.map((q) =>
          runV1Search({
            query: q,
            category,
            fromDate: input.from_date,
            toDate: input.to_date,
            maxResults: input.max_results,
            language: input.language,
            includeDomains: input.include_domains,
            excludeDomains: input.exclude_domains,
            includeScoreBreakdown: input.include_engine_outcomes,
            country: input.country,
            timeRange: input.time_range,
            exactMatch: input.exact_match,
          }),
        ),
      );

      const fused =
        dispatches.length === 1
          ? dispatches[0].results
          : fuseRankedLists(dispatches.map((d) => d.results));

      const enginesUsedSet = new Set<string>();
      for (const d of dispatches) {
        for (const e of d.enginesUsed) enginesUsedSet.add(e);
      }
      enginesUsed = [...enginesUsedSet];
      allDegraded = dispatches.every((d) => d.degraded);

      if (input.include_engine_outcomes) {
        // Flatten per-dispatch outcomes into a single array, summarized so we
        // never leak the raw RawSearchResult payload into telemetry.
        engineOutcomes = [];
        for (const d of dispatches) {
          for (const o of d.outcomes) {
            engineOutcomes.push({
              engine: o.engine,
              ok: o.ok,
              latency_ms: o.latencyMs,
              result_count: o.results.length,
              ...(o.error ? { error: o.error } : {}),
              ...(o.skipped ? { skipped: true } : {}),
            });
          }
        }
      }

      // Always emit richer engine_telemetry. Aggregate by engine name across
      // dispatches (multi-query): sum latency, result_count, dedup_kept.
      const telemetryByEngine = new Map<string, EngineTelemetry>();
      const fusedUrlSet = new Set(fused.map((r) => r.url));
      for (const d of dispatches) {
        for (const o of d.outcomes ?? []) {
          const existing = telemetryByEngine.get(o.engine);
          const outcome: EngineTelemetry['outcome'] = o.skipped
            ? 'skipped'
            : o.ok
              ? 'ok'
              : 'error';
          const kept = o.results.reduce(
            (acc, r) => (fusedUrlSet.has(r.url) ? acc + 1 : acc),
            0,
          );
          if (existing) {
            existing.latency_ms += o.latencyMs;
            existing.result_count += o.results.length;
            existing.dedup_kept += kept;
            if (outcome !== 'ok' && existing.outcome === 'ok') existing.outcome = outcome;
            if (o.error && !existing.error) existing.error = o.error;
          } else {
            telemetryByEngine.set(o.engine, {
              name: o.engine,
              latency_ms: o.latencyMs,
              result_count: o.results.length,
              outcome,
              dedup_kept: kept,
              ...(o.error ? { error: o.error } : {}),
            });
          }
        }
      }
      engineTelemetry = [...telemetryByEngine.values()];

      let processed = fused;

      if (input.agent_context?.text || input.agent_context?.intent) {
        const contextText = input.agent_context.text ?? input.agent_context.intent;
        processed = await applyContextRank(processed, queries[0], contextText);
      }

      if (input.agent_context?.recent_urls?.length) {
        processed = dedupAgainstRecentUrls(processed, input.agent_context.recent_urls);
      }

      const maxResults = input.max_results ?? processed.length;
      items = processed.slice(0, maxResults).map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.snippet,
        relevance_score: r.relevance_score,
        ...(r.published_date ? { published_date: r.published_date } : {}),
        ...(r.evidence_score ? { evidence_score: r.evidence_score } : {}),
        ...(r.image_url ? { image_url: r.image_url } : {}),
        ...(r.image_alt ? { image_alt: r.image_alt } : {}),
        ...(r._score_breakdown ? { _score_breakdown: r._score_breakdown } : {}),
      }));

      searchElapsed = Date.now() - start;

      const includeContent = input.include_content !== false;
      if (includeContent && ctx.router && items.length > 0) {
        const config = getConfig();
        const fetchStart = Date.now();
        await fetchContentForResults(items, ctx.router, {
          contentMaxChars: input.content_max_chars ?? DEFAULT_CONTENT_MAX_CHARS,
          maxContentChars: input.max_content_chars,
          maxTotalChars: input.max_total_chars ?? DEFAULT_MAX_TOTAL_CHARS,
          fetchTimeoutMs: config.searchFetchTimeoutMs,
          totalDeadline: start + config.searchTotalTimeoutMs,
          forceRefresh: input.force_refresh ?? false,
          maxFetches: input.max_fetches,
        });
        fetchElapsed = Date.now() - fetchStart;
        contentFetched = true;
      }

      if (items.length > 0) {
        try {
          cacheSearchResults(cacheKey, items, enginesUsed);
        } catch (err) {
          log.debug('search cache write failed', { error: String(err) });
        }
      }
    }
    void cachedAt;

    // category 'images' is rejected above, so by this point `category` is
    // either undefined or a vertical the orchestrator accepts.
    const queryUnderstanding = buildQueryUnderstanding(displayQuery, {
      category,
      language: input.language,
      rewrites: isArray ? (input.query as string[]).slice(1) : [],
    });

    if (input.include_favicon) {
      for (const it of items) {
        const fav = faviconUrlFor(it.url);
        if (fav) it.favicon = fav;
      }
    }

    const totalTimeMs = Date.now() - start;
    const data: SearchOutput = {
      results: items,
      query: displayQuery,
      engines_used: enginesUsed,
      total_time_ms: totalTimeMs,
      response_time_ms: totalTimeMs,
      search_time_ms: searchElapsed,
      fetch_time_ms: fetchElapsed,
      query_understanding: queryUnderstanding,
      ...(engineOutcomes ? { engine_outcomes: engineOutcomes } : {}),
      ...(engineTelemetry ? { engine_telemetry: engineTelemetry } : {}),
    };

    if (input.include_images) {
      data.images = items
        .filter((it) => typeof it.image_url === 'string' && it.image_url.length > 0)
        .map((it) => ({
          url: it.image_url!,
          ...(it.image_alt ? { alt: it.image_alt } : {}),
          source_url: it.url,
        }));
    }

    if (allDegraded) {
      data.warning = 'all engines failed or no results';
    }

    if (input.format === 'answer' || input.format === 'stream_answer') {
      const synthResult = await runSynthesis({
        query: displayQuery,
        results: items,
        samplingServer: ctx.samplingServer,
        maxTotalChars: input.max_total_chars ?? DEFAULT_MAX_TOTAL_CHARS,
      });

      if (synthResult.ok) {
        data.answer = synthResult.data.answer;
        if (synthResult.data.citations.length > 0) {
          data.citations = synthResult.data.citations;
        }
        if (synthResult.data.warning) {
          data.warning = synthResult.data.warning
            ? (data.warning ? `${data.warning}; ${synthResult.data.warning}` : synthResult.data.warning)
            : data.warning;
        }
        if (synthResult.data.synthesis_status) {
          data.synthesis_status = synthResult.data.synthesis_status;
          data.synthesis_provider = synthResult.data.synthesis_provider;
          data.synthesis_model = synthResult.data.synthesis_model;
          data.synthesis_advice = synthResult.data.synthesis_advice;
        }
      } else {
        data.warning = `synthesis failed: ${synthResult.error_reason}`;
      }

      if (input.format === 'stream_answer') {
        data.streaming = true;
      }
    } else if (items.length > 0 && contentFetched) {
      // Evidence + citations defaults require fetched content to be useful;
      // skip when content fetch was disabled or no router was available.
      await applyEvidenceDefault(input, data, items, displayQuery);
    }

    if (input.citation_format) {
      if (!data.citations || data.citations.length === 0) {
        const built: Citation[] = items.map((r, i) => ({
          index: i + 1,
          url: r.url,
          title: r.title,
          snippet: r.snippet,
        }));
        if (built.length > 0) data.citations = built;
      }
      if (input.citation_format === 'anthropic_tags' && data.citations && data.citations.length > 0 && !data.citations_xml) {
        data.citations_xml = renderCitationsXml(data.citations);
      }
    }

    return { ok: true, data };
  }
}
