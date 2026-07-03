// CoreSearchProvider — retrieval-only adapter.
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
import { expandQuery, LOW_RECALL_THRESHOLD } from './query-expansion.js';
import { dedupAgainstRecentUrls } from './recent-cache-dedup.js';
import { foldRerankIntoOrdering } from './rerank-fold.js';
import { applyScoreFloor, DEFAULT_SEARCH_SCORE_FLOOR } from './score-floor.js';
import { recencyDemotion, hasTemporalIntent } from './recency-boost.js';
import { detectBrandCollision, detectLexicalCollision } from './brand-collision.js';
import { computeFreshnessSignal } from './freshness.js';
import { buildQueryUnderstanding } from './query-understanding.js';
import { detectRareTerms } from './rare-terms.js';
import { buildEngineWarnings } from './engine-warnings.js';
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

// Recall backfill buffer. The downstream score-floor + stale
// demotion drop junk from the dispatched set; without an over-fetch they have
// nothing to backfill from and the response thins below max_results. Mirror
// the research module's 40%-over buffer (research/pipeline.ts): ask the
// orchestrator for max_results + ceil(40%) so the floor can trim and the final
// slice still refills to max_results. Returns undefined when the caller set no
// max_results — the orchestrator default already over-fetches relative to a
// typical floor in that case.
const RECALL_BUFFER_RATIO = 0.4;
function bufferedMaxResults(maxResults: number | undefined): number | undefined {
  if (typeof maxResults !== 'number' || maxResults <= 0) return maxResults;
  return maxResults + Math.ceil(maxResults * RECALL_BUFFER_RATIO);
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

// Build at most ONE quoted-phrase variant for a COMPOUND-term query. Quoting
// the compound token coaxes exact-match pages out of engines that support
// phrase queries — engines otherwise drop hyphens and search the dominant
// single term. Compound-only by design: a concept phrase fires for nearly every
// multi-word query, so quoting it would spend an extra engine sweep on almost
// every call; concept-phrase queries are handled purely rank-side. Returns null
// when no compound token is present.
function buildRareTermVariant(query: string): string | null {
  const rare = detectRareTerms(query);
  if (rare.compoundTokens.length === 0) return null;
  let v = query;
  for (const t of rare.compoundTokens) {
    // quote the first occurrence of each compound token, case-insensitively
    const re = new RegExp(`(^|\\s)(${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?=\\s|$)`, 'i');
    v = v.replace(re, (_m, pre, tok) => `${pre}"${tok}"`);
  }
  return v !== query ? v : null;
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

    // The images vertical is first-class on core via
    // the DDG Image (zero-key) + Brave Image (key-gated) adapters. Earlier
    // releases returned `unsupported_category` here; that branch is gone.
    const category = input.category;
    const depth = input.search_depth ?? 'balanced';
    // For image search the per-result `url` is the SOURCE page, not the
    // asset — fetching it would extract HTML the caller didn't ask for and
    // waste budget. We short-circuit include_content so the orchestrator
    // never spins up the router pool for an images call.
    const isImagesCategory = category === 'images';

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
      search_depth: depth,
      reranker: getConfig().reranker,
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
    // Reasons any dispatch reported its engine pool degraded (e.g. a thin
    // vertical starved and backfilled from general). Surfaced on engine_pool.
    const poolReasons = new Set<string>();

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

    let ultraFastMiss = false;
    if (!servedFromCache && depth === 'ultra-fast') {
      ultraFastMiss = true;
    }

    // S11c sub-area 3: when the initial dispatch produces few results, fire
    // ONE auto-rewrite from the static synonym map (acronyms, multi-word
    // identifier joins, last-resort pluralization). The rewrite is reported
    // back to the caller via query_understanding.rewrites so the auto-fired
    // variant is not mistaken for user-supplied input. Only fires on a
    // single-query call (multi-query callers already supplied their own
    // variants — we trust them).
    const autoRewrites: string[] = [];

    if (!servedFromCache && !ultraFastMiss) {
      // For a single-query call carrying a compound token
      // (sqlite-vec, vec0, snake_case), add ONE quoted-phrase variant to the
      // initial fan-out so engines that honour phrase quotes surface exact-match
      // pages they'd otherwise drop by stripping the hyphen. The variant is
      // dispatched CONCURRENTLY in the same Promise.all (not a serial second
      // sweep), so it adds engine load but no extra wall-clock latency. Bounded
      // to one extra concurrent dispatch; `queries` stays the user-supplied list
      // (the low-recall block below still keys its single-query gate off it).
      const rareVariant =
        category !== 'images' && queries.length === 1
          ? buildRareTermVariant(queries[0])
          : null;
      const dispatchQueries =
        rareVariant && rareVariant.trim() !== queries[0].trim()
          ? [...queries, rareVariant]
          : queries;
      if (dispatchQueries.length > queries.length) {
        log.debug('rare-term variant firing', { original: queries[0], variant: rareVariant });
      }

      // Recall backfill: the orchestrator slices to the
      // maxResults it is handed, so the downstream score-floor + stale
      // demotion would have NOTHING to backfill from when they drop junk —
      // leaving fewer than max_results even when good survivors exist. Mirror
      // the research module's pattern: over-fetch a small buffer here so the
      // floor can trim and the final slice still refills to max_results. The
      // buffer is bounded (40% over, like research) so engine load stays
      // proportional; when no max_results is set the orchestrator default
      // already over-fetches relative to a typical floor, so we leave it.
      const dispatchMaxResults = bufferedMaxResults(input.max_results);

      const dispatches = await Promise.all(
        dispatchQueries.map((q) =>
          runV1Search({
            query: q,
            category,
            fromDate: input.from_date,
            toDate: input.to_date,
            maxResults: dispatchMaxResults,
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

      if (rareVariant && dispatchQueries.length > queries.length) {
        autoRewrites.push(rareVariant);
      }

      let fused =
        dispatches.length === 1
          ? dispatches[0].results
          : fuseRankedLists(dispatches.map((d) => d.results));

      // Low-recall expansion (S11c): only fire when single-query, result
      // count is at or below threshold, and category is not 'images'. Image
      // search uses entirely different snippets so the static synonym map
      // would mostly noise. expandQuery returns null when no synonym
      // applies, so the rewrite is silent on terminal stop-word queries.
      if (
        category !== 'images' &&
        queries.length === 1 &&
        fused.length <= LOW_RECALL_THRESHOLD
      ) {
        const rewrite = expandQuery(queries[0]);
        if (rewrite && rewrite.trim() !== queries[0].trim()) {
          log.debug('low-recall expansion firing', {
            original: queries[0],
            rewrite,
            initialResultCount: fused.length,
          });
          const retry = await runV1Search({
            query: rewrite,
            category,
            fromDate: input.from_date,
            toDate: input.to_date,
            maxResults: dispatchMaxResults,
            language: input.language,
            includeDomains: input.include_domains,
            excludeDomains: input.exclude_domains,
            includeScoreBreakdown: input.include_engine_outcomes,
            country: input.country,
            timeRange: input.time_range,
            exactMatch: input.exact_match,
          });
          // RRF-merge the retry results on top of the initial dispatch so
          // we keep ranking signal from both passes.
          fused = fuseRankedLists([fused, retry.results]);
          autoRewrites.push(rewrite);
          // Merge enginesUsed + outcomes from the retry into the in-scope
          // accumulators so the response telemetry reflects the full work.
          dispatches.push(retry);
        }
      }

      const enginesUsedSet = new Set<string>();
      for (const d of dispatches) {
        for (const e of d.enginesUsed) enginesUsedSet.add(e);
      }
      enginesUsed = [...enginesUsedSet];
      allDegraded = dispatches.every((d) => d.degraded);
      for (const d of dispatches) {
        for (const reason of d.pool_degraded?.reasons ?? []) poolReasons.add(reason);
      }

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
            if (o.skipped && !existing.reason) existing.reason = 'breaker_open';
            if (o.cooldownRemainingMs !== undefined && existing.cooldown_remaining_ms === undefined) {
              existing.cooldown_remaining_ms = o.cooldownRemainingMs;
            }
          } else {
            telemetryByEngine.set(o.engine, {
              name: o.engine,
              latency_ms: o.latencyMs,
              result_count: o.results.length,
              outcome,
              dedup_kept: kept,
              ...(o.error ? { error: o.error } : {}),
              ...(o.skipped ? { reason: 'breaker_open' as const } : {}),
              ...(o.cooldownRemainingMs !== undefined
                ? { cooldown_remaining_ms: o.cooldownRemainingMs }
                : {}),
            });
          }
        }
      }
      engineTelemetry = [...telemetryByEngine.values()];

      // `engines_used` = engines that contributed >= 1 result
      // to the deduped fused list (semantic — "who ended up in the answer").
      // `engine_telemetry` already carries the per-engine dedup_kept count;
      // deriving `engines_used` from it here keeps the two surfaces in sync
      // and rules out empty/errored engines that the old code would still
      // list because they "fired ok" but contributed nothing.
      //
      // Fall back to the union of `dispatch.enginesUsed` only when the
      // dispatch layer didn't surface any telemetry rows (mocks in tests,
      // legacy paths) — that path mirrors the pre-M1 behavior so the
      // top-level array is never empty when engines actually fired.
      if (engineTelemetry.length > 0) {
        enginesUsed = engineTelemetry
          .filter((t) => t.dedup_kept > 0)
          .map((t) => t.name);
      } else {
        const enginesUsedSet = new Set<string>();
        for (const d of dispatches) {
          for (const e of d.enginesUsed) enginesUsedSet.add(e);
        }
        enginesUsed = [...enginesUsedSet];
      }

      let processed = fused;

      // fast tier skips embedding rerank + agent_context rerank for latency.
      if (depth !== 'fast' && (input.agent_context?.text || input.agent_context?.intent)) {
        const contextText = input.agent_context.text ?? input.agent_context.intent;
        processed = await applyContextRank(processed, queries[0], contextText);
      }

      if (input.agent_context?.recent_urls?.length) {
        processed = dedupAgainstRecentUrls(processed, input.agent_context.recent_urls);
      }

      // Cross-encoder rerank-fold: the LAST reorder, after
      // all cross-query merges + context-rank. Balanced/deep only; images skip
      // (snippet rerank on image results is noise); gated on the same onnx
      // reranker config the evidence path uses. The helper is failure-safe.
      if (
        (depth === 'balanced' || depth === 'deep') &&
        !isImagesCategory &&
        getConfig().reranker === 'onnx'
      ) {
        processed = await foldRerankIntoOrdering(processed, {
          queries,
          deep: depth === 'deep',
          maxResults: input.max_results,
        });
      }

      // Stale-result demotion: on a temporal-intent query an
      // out-of-date page must lose its slot to a fresher one. The RRF-fusion
      // recency BOOST (orchestrator.ts) only lifts recent results — it cannot
      // push a stale one down. This applies the demotion penalty exactly once,
      // here at the final-ordering seam (after rerank-fold, before the floor),
      // so it is the authoritative last word on staleness and is never
      // overwritten by an upstream re-score. Gated on temporal intent so
      // evergreen queries (no date sensitivity) are untouched; undated and
      // recent results carry a factor of 1.0 and are unaffected.
      const demoteForRecency = queries.some((q) => hasTemporalIntent(q));
      if (demoteForRecency) {
        const now = new Date();
        processed = [...processed]
          .map((r) => ({ r, demoted: r.relevance_score * recencyDemotion(r.published_date, now) }))
          .sort((a, b) => b.demoted - a.demoted)
          .map(({ r, demoted }) => ({ ...r, relevance_score: demoted }));
      }

      // Relevance-score floor: the LAST trim before the slice, so
      // an upstream slice cannot bypass it and the near-zero/negative junk the
      // rerank-fold scored into the tier-0 band never consumes a top-N slot.
      // The user-settable relevanceThreshold raises the floor; it never lowers
      // the default below DEFAULT_SEARCH_SCORE_FLOOR. applyScoreFloor always
      // keeps the single best result so the set is never emptied.
      const configuredThreshold = getConfig().relevanceThreshold;
      const floor = Math.max(DEFAULT_SEARCH_SCORE_FLOOR, configuredThreshold);
      const floored = applyScoreFloor(processed, floor);
      processed = floored.kept;

      const maxResults = input.max_results ?? processed.length;
      items = processed.slice(0, maxResults).map((r) => {
        const freshness = computeFreshnessSignal(r.url, r.published_date);
        return {
          title: r.title,
          url: r.url,
          snippet: r.snippet,
          relevance_score: r.relevance_score,
          ...(r.published_date ? { published_date: r.published_date } : {}),
          // Omit the field entirely when the freshness
          // helper returns undefined (the "no parseable date" case) so the
          // response shape stays clean.
          ...(freshness ? { freshness_signal: freshness } : {}),
          ...(r.evidence_score ? { evidence_score: r.evidence_score } : {}),
          ...(r.image_url ? { image_url: r.image_url } : {}),
          ...(r.image_alt ? { image_alt: r.image_alt } : {}),
          // Image-search fields: only set when the engine carried
          // them — non-image engines leave these undefined so the response
          // shape stays slim for general/code/docs/papers verticals.
          ...(r.thumbnail_url ? { thumbnail_url: r.thumbnail_url } : {}),
          ...(typeof r.width === 'number' && typeof r.height === 'number'
            ? { width: r.width, height: r.height }
            : {}),
          ...(r._score_breakdown ? { _score_breakdown: r._score_breakdown } : {}),
        };
      });

      searchElapsed = Date.now() - start;

      // fast tier short-circuits content fetch; ultra-fast already returned
      // before reaching this block. Image search also skips fetch — the
      // per-result `url` is the source page, not the asset, and callers who
      // asked for image search don't want HTML extracted into markdown_content.
      const includeContent = input.include_content !== false && depth !== 'fast' && !isImagesCategory;
      if (includeContent && ctx.router && items.length > 0) {
        const config = getConfig();
        const fetchStart = Date.now();
        const isDeep = depth === 'deep';
        await fetchContentForResults(items, ctx.router, {
          contentMaxChars: input.content_max_chars ?? DEFAULT_CONTENT_MAX_CHARS,
          maxContentChars: input.max_content_chars,
          maxTotalChars: input.max_total_chars ?? DEFAULT_MAX_TOTAL_CHARS,
          fetchTimeoutMs: isDeep ? config.searchFetchTimeoutDeepMs : config.searchFetchTimeoutBalancedMs,
          stageBudgetMs: isDeep ? config.searchStageBudgetDeepMs : config.searchStageBudgetBalancedMs,
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
    // `rewrites` reports query expansions. When the
    // caller hands us an array, they ARE the rewriter so echoing their own
    // input back is misleading — we omit caller-supplied alternates. We DO
    // surface S11c auto-rewrites (low-recall expansion fired by us) so
    // callers can audit what wigolo actually searched for. queries_executed
    // still carries the full dispatched-query list.
    const queryUnderstanding = buildQueryUnderstanding(displayQuery, {
      category,
      language: input.language,
      rewrites: [...autoRewrites],
    });

    if (input.include_favicon) {
      for (const it of items) {
        const fav = faviconUrlFor(it.url);
        if (fav) it.favicon = fav;
      }
    }

    const totalTimeMs = Date.now() - start;
    // Promote per-engine errors out of debug-only telemetry
    // into a top-level array so every caller sees broken engines. Empty
    // array on cache hits or all-ok runs (cleaner than `undefined?.length`).
    const engineWarnings = buildEngineWarnings(engineTelemetry);
    // Pool health: total = engines dispatched, healthy = engines that returned
    // ≥1 result. Degraded when any didn't contribute OR a dispatch flagged a
    // degrade reason (e.g. starvation re-dispatch). Single "pool degraded to N
    // engines" surface. Cache hits omit it (no telemetry to source from).
    const enginePool = engineTelemetry
      ? (() => {
          const total = engineTelemetry.length;
          const healthy = engineTelemetry.filter((t) => t.result_count > 0).length;
          const reasons = [...poolReasons];
          const degraded = healthy < total || reasons.length > 0;
          return {
            healthy,
            total,
            degraded,
            ...(reasons.length > 0 ? { reasons } : {}),
          };
        })()
      : undefined;
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
      // Always emit on engine-pool path (telemetry present); cache hits
      // intentionally omit since there's no telemetry to source from.
      ...(engineTelemetry ? { engine_warnings: engineWarnings } : {}),
      ...(enginePool ? { engine_pool: enginePool } : {}),
    };

    // Try the brand-domain check first (cheap, requires
    // top-3 to actually carry a brand TLD). Fall back to the lexical
    // dev-term collision check — fires on "useState" etc. even when the
    // top-3 has no brand domain. Either path emits the same warning shape.
    const collisionWarning =
      detectBrandCollision(displayQuery, items.map((i) => i.url)) ??
      detectLexicalCollision(displayQuery);
    if (collisionWarning) data.brand_collision_warning = collisionWarning;

    if (input.include_images || isImagesCategory) {
      // S11a: when the caller asked for the images category explicitly, we
      // ALWAYS aggregate the top-level `images[]` array (even without
      // include_images=true) — the contract of `category: 'images'` is that
      // image data is the primary payload, not an opt-in extra.
      data.images = items
        .filter((it) => typeof it.image_url === 'string' && it.image_url.length > 0)
        .map((it) => ({
          url: it.image_url!,
          ...(it.image_alt ? { alt: it.image_alt } : {}),
          source_url: it.url,
          ...(it.thumbnail_url ? { thumbnail_url: it.thumbnail_url } : {}),
          ...(typeof it.width === 'number' && typeof it.height === 'number'
            ? { width: it.width, height: it.height }
            : {}),
          ...(it.title ? { title: it.title } : {}),
        }));
    }

    if (allDegraded) {
      data.warning = 'all engines failed or no results';
    }

    if (ultraFastMiss) {
      data.notice = 'cache miss, retry with search_depth=fast or higher';
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

      // slim payload. The synthesized answer + citations are the contract
      // when format=answer; per-result markdown_content is pure overhead
      // (~3× cost in the bench). Drop bodies unless the caller explicitly
      // asked for include_full_markdown.
      if (!input.include_full_markdown) {
        for (const r of items) {
          if (r.markdown_content !== undefined) r.markdown_content = undefined;
        }
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
